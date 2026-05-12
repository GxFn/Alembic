import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SetupService } from '../../cli/SetupService.js';
import {
  allowedCodexToolNames,
  buildCodexKnowledgeGateActions,
  buildCodexPostInitActions,
  buildCodexPostInitMessage,
  buildCodexRecommendedAction,
  buildCodexRuntimeDiagnostics,
  buildCodexStatus,
  CODEX_ADMIN_ENABLE_ENV,
  CODEX_DEFAULT_MCP_TIER,
  CODEX_MCP_TIER_ENV,
  CODEX_SETUP_PROFILE,
  type CodexKnowledgeState,
  createCodexJobContext,
  EMPTY_CODEX_KNOWLEDGE_STATE,
  inspectCodexKnowledge,
  isToolAllowedForCodexKnowledge,
  resolveCodexRuntimeContext,
  resolveCodexToolPolicy,
  summarizeCodexDaemonStatus,
} from '../../codex/index.js';
import { type DaemonState, resolveDaemonPaths } from '../../daemon/DaemonState.js';
import { type DaemonStatus, DaemonSupervisor } from '../../daemon/DaemonSupervisor.js';
import { JobStore } from '../../daemon/JobStore.js';
import { TIER_ORDER, TOOLS, withMcpToolAnnotations } from './tools.js';

interface CodexMcpServerOptions {
  projectRoot?: string;
  supervisor?: DaemonSupervisorLike;
  waitUntilReadyMs?: number;
}

interface DaemonSupervisorLike {
  ensure(options: { projectRoot: string; waitUntilReadyMs?: number }): Promise<DaemonStatus>;
  status(projectRoot: string): Promise<DaemonStatus>;
  stop(options: { projectRoot: string; waitMs?: number }): Promise<DaemonStatus>;
}

interface CodexToolCallActor {
  role?: string;
  user?: string;
  sessionId?: string;
}

export class CodexMcpServer {
  readonly projectRoot: string;
  readonly supervisor: DaemonSupervisorLike;
  readonly waitUntilReadyMs: number;
  readonly sessionId: string;
  sdkServer: SdkMcpServer | null = null;

  constructor(options: CodexMcpServerOptions = {}) {
    this.projectRoot = resolveProjectRoot(options.projectRoot);
    this.supervisor = options.supervisor || new DaemonSupervisor();
    this.waitUntilReadyMs = options.waitUntilReadyMs ?? 3000;
    this.sessionId = `codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async start(): Promise<void> {
    this.sdkServer = new SdkMcpServer(
      { name: 'alembic-codex', version: '0.1.0' },
      { capabilities: { tools: {} } }
    );
    this.registerHandlers();
    await this.sdkServer.connect(new StdioServerTransport());
    process.stderr.write(
      `Alembic Codex MCP ready — ${getVisibleCodexTools(undefined, this.projectRoot).length} tools\n`
    );
  }

  async shutdown(): Promise<void> {
    if (this.sdkServer) {
      await this.sdkServer.close();
    }
  }

  registerHandlers(): void {
    if (!this.sdkServer) {
      throw new Error('Codex MCP SDK server is not initialized');
    }
    const server = this.sdkServer.server;

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: getVisibleCodexTools(undefined, this.projectRoot),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        const result = await this.handleToolCall(name, args || {});
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: isErrorResult(result) ? true : undefined,
        };
      } catch (err: unknown) {
        const result = failureResult(name, err instanceof Error ? err.message : String(err));
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: true,
        };
      }
    });
  }

  async handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    const knowledge = inspectCodexKnowledge(this.projectRoot);
    if (!isToolAllowedForCodexKnowledge(name, knowledge)) {
      return failureResult(
        name,
        'Alembic project-knowledge tools are hidden until this project has a usable Alembic knowledge base. Use the cold-start initialization tools first.',
        {
          allowedTools: [...allowedCodexToolNames(knowledge)],
          errorCode: 'CODEX_ALEMBIC_KNOWLEDGE_REQUIRED',
          nextActions: buildCodexKnowledgeGateActions(knowledge),
        }
      );
    }

    switch (name) {
      case 'alembic_codex_status':
        return this.buildStatus();
      case 'alembic_codex_diagnostics':
        return this.buildDiagnostics();
      case 'alembic_codex_init':
        return this.initializeWorkspace(args);
      case 'alembic_codex_dashboard':
        return this.openDashboard();
      case 'alembic_codex_bootstrap':
        return this.enqueueJob('bootstrap', args);
      case 'alembic_codex_rescan':
        return this.enqueueJob('rescan', args);
      case 'alembic_codex_job':
        return this.readJob(args);
      case 'alembic_codex_stop':
        return this.stopDaemon(args);
      case 'alembic_codex_cleanup':
        return this.cleanupRuntime(args);
      default:
        return this.callDaemonTool(name, args);
    }
  }

  async buildStatus(): Promise<Record<string, unknown>> {
    return {
      success: true,
      data: await buildCodexStatus(this.projectRoot, { supervisor: this.supervisor }),
    };
  }

  async buildDiagnostics(): Promise<Record<string, unknown>> {
    const daemonStatus = await this.supervisor.status(this.projectRoot);
    const runtime = resolveCodexRuntimeContext();
    return {
      success: true,
      data: buildCodexRuntimeDiagnostics(daemonStatus, runtime),
    };
  }

  async initializeWorkspace(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const service = new SetupService({
      projectRoot: this.projectRoot,
      force: Boolean(args.force),
      seed: Boolean(args.seed),
      ghost: args.standard !== true,
      profile: CODEX_SETUP_PROFILE,
      quiet: true,
    });
    const results = await service.run();
    const status = await this.buildStatus();
    const ok = results.every((result) => result.ok);
    const knowledgeAfterInit =
      (status as { data?: { knowledge?: CodexKnowledgeState } }).data?.knowledge ??
      EMPTY_CODEX_KNOWLEDGE_STATE;
    return {
      success: ok,
      data: {
        mode: args.standard === true ? 'standard' : 'ghost',
        nextActions: ok
          ? buildCodexPostInitActions(knowledgeAfterInit)
          : [
              buildCodexRecommendedAction({
                label: 'Run diagnostics',
                reason: 'Inspect runtime, package, and plugin metadata before retrying setup.',
                startsDaemon: false,
                tool: 'alembic_codex_diagnostics',
              }),
            ],
        profile: CODEX_SETUP_PROFILE,
        results,
        status: (status as { data?: unknown }).data,
      },
      message: ok
        ? buildCodexPostInitMessage(knowledgeAfterInit)
        : 'Alembic Codex initialization failed. Run diagnostics before retrying.',
    };
  }

  async openDashboard(): Promise<Record<string, unknown>> {
    const daemon = await this.supervisor.ensure({
      projectRoot: this.projectRoot,
      waitUntilReadyMs: this.waitUntilReadyMs,
    });
    if (!daemon.ready || !daemon.state) {
      return {
        success: false,
        message: daemon.message || 'Alembic daemon is not ready yet.',
        data: {
          daemon: summarizeCodexDaemonStatus(daemon),
          nextActions: [
            buildCodexRecommendedAction({
              label: 'Run diagnostics',
              reason: 'Check Node, npm, embedded runtime wiring, and daemon state before retrying.',
              startsDaemon: false,
              tool: 'alembic_codex_diagnostics',
            }),
          ],
        },
      };
    }
    return {
      success: true,
      data: {
        dashboardUrl: daemon.state.dashboardUrl || daemon.state.url,
        daemon: summarizeCodexDaemonStatus(daemon),
        nextActions: [
          buildCodexRecommendedAction({
            label: 'Start bootstrap',
            reason: 'Create or refresh Alembic project knowledge from the Dashboard-backed daemon.',
            startsDaemon: true,
            tool: 'alembic_codex_bootstrap',
          }),
          buildCodexRecommendedAction({
            arguments: { limit: 10 },
            label: 'List jobs',
            reason: 'Recover job status after Codex reconnects or the Dashboard refreshes.',
            startsDaemon: false,
            tool: 'alembic_codex_job',
          }),
        ],
      },
    };
  }

  async stopDaemon(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const daemon = await this.supervisor.stop({
      projectRoot: this.projectRoot,
      waitMs: typeof args.waitMs === 'number' ? args.waitMs : 5000,
    });
    return {
      success: true,
      data: { daemon: summarizeCodexDaemonStatus(daemon) },
      message: daemon.message || 'Alembic daemon stopped.',
    };
  }

  async cleanupRuntime(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const paths = resolveDaemonPaths(this.projectRoot);
    const targets = {
      dataRoot: paths.dataRoot,
      jobsDir: paths.jobsDir,
      lockDir: paths.lockDir,
      logPath: paths.logPath,
      pidPath: paths.pidPath,
      runtimeDir: paths.runtimeDir,
      statePath: paths.statePath,
    };

    if (args.confirm !== true) {
      return {
        success: true,
        data: {
          dryRun: true,
          targets,
        },
        message:
          'Dry run only. Plugin uninstall does not remove Alembic data. Re-run with confirm=true to delete daemon runtime state/log/job files.',
      };
    }

    await this.supervisor.stop({ projectRoot: this.projectRoot, waitMs: 5000 });
    rmSync(paths.statePath, { force: true });
    rmSync(paths.pidPath, { force: true });
    rmSync(paths.logPath, { force: true });
    rmSync(paths.lockDir, { force: true, recursive: true });
    rmSync(paths.jobsDir, { force: true, recursive: true });
    return {
      success: true,
      data: {
        dryRun: false,
        cleaned: targets,
      },
      message:
        'Alembic Codex daemon runtime state cleaned. Knowledge, Recipes, and project data were left intact.',
    };
  }

  async enqueueJob(kind: 'bootstrap' | 'rescan', args: Record<string, unknown>): Promise<unknown> {
    const daemon = await this.supervisor.ensure({
      projectRoot: this.projectRoot,
      waitUntilReadyMs: this.waitUntilReadyMs,
    });
    if (!daemon.ready || !daemon.state) {
      return failureResult(
        `alembic_codex_${kind}`,
        daemon.message || 'Alembic daemon is not ready yet.',
        {
          daemon: summarizeCodexDaemonStatus(daemon),
          nextActions: [
            buildCodexRecommendedAction({
              label: 'Run diagnostics',
              reason: 'Check daemon startup state before retrying the job.',
              startsDaemon: false,
              tool: 'alembic_codex_diagnostics',
            }),
          ],
        }
      );
    }
    if (!daemon.state.token) {
      return failureResult(
        `alembic_codex_${kind}`,
        'Alembic daemon token is missing. Restart the daemon and retry.',
        { daemon: summarizeCodexDaemonStatus(daemon) }
      );
    }

    return callDaemonHttpEndpoint(
      daemon.state,
      `/api/v1/jobs/${kind}`,
      {
        method: 'POST',
        body: {
          ...args,
          jobContext: createCodexJobContext({
            createdByTool: `alembic_codex_${kind}`,
            sessionId: this.sessionId,
            user: process.env.USER || undefined,
          }),
        },
      },
      `alembic_codex_${kind}`
    );
  }

  async readJob(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const daemonResult = await this.tryReadJobFromDaemon(args);
    if (daemonResult) {
      return daemonResult;
    }

    const store = new JobStore({ projectRoot: this.projectRoot });
    const jobId = typeof args.jobId === 'string' ? args.jobId : '';
    if (jobId) {
      const job = store.get(jobId);
      return job
        ? { success: true, data: { job } }
        : failureResult('alembic_codex_job', `Alembic job not found: ${jobId}`);
    }

    const kind = args.kind === 'bootstrap' || args.kind === 'rescan' ? args.kind : undefined;
    const status =
      args.status === 'queued' ||
      args.status === 'running' ||
      args.status === 'completed' ||
      args.status === 'failed' ||
      args.status === 'cancelled'
        ? args.status
        : undefined;
    const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : 20;
    return {
      success: true,
      data: {
        jobs: store.list({ kind, limit, status }),
      },
    };
  }

  async tryReadJobFromDaemon(
    args: Record<string, unknown>
  ): Promise<Record<string, unknown> | null> {
    let daemon: DaemonStatus;
    try {
      daemon = await this.supervisor.status(this.projectRoot);
    } catch {
      return null;
    }
    if (!daemon.ready || !daemon.state?.token) {
      return null;
    }

    const jobId = typeof args.jobId === 'string' ? args.jobId : '';
    const path = jobId
      ? `/api/v1/jobs/${encodeURIComponent(jobId)}`
      : `/api/v1/jobs${buildJobQuery(args)}`;
    try {
      const result = await callDaemonHttpEndpoint(
        daemon.state,
        path,
        { method: 'GET' },
        'alembic_codex_job'
      );
      return isErrorResult(result) ? null : (result as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  async callDaemonTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!TOOLS.some((tool) => tool.name === name)) {
      return failureResult(name, `Unknown Alembic tool: ${name}`);
    }

    const daemon = await this.supervisor.ensure({
      projectRoot: this.projectRoot,
      waitUntilReadyMs: this.waitUntilReadyMs,
    });
    if (!daemon.ready || !daemon.state) {
      return failureResult(name, daemon.message || 'Alembic daemon is not ready yet.', {
        daemon: summarizeCodexDaemonStatus(daemon),
      });
    }
    if (!daemon.state.token) {
      return failureResult(name, 'Alembic daemon token is missing. Restart the daemon and retry.', {
        daemon: summarizeCodexDaemonStatus(daemon),
      });
    }

    return callDaemonBridge(daemon.state, name, args, {
      role: 'external_agent',
      user: process.env.USER || undefined,
      sessionId: this.sessionId,
    });
  }
}

export function getVisibleCodexTools(
  tierName = process.env[CODEX_MCP_TIER_ENV] || CODEX_DEFAULT_MCP_TIER,
  projectRoot = resolveProjectRoot()
) {
  const knowledge = inspectCodexKnowledge(projectRoot);
  return resolveCodexToolPolicy({
    adminEnabled: process.env[CODEX_ADMIN_ENABLE_ENV] === '1',
    coreTools: TOOLS,
    knowledge,
    tierName,
    tierOrder: TIER_ORDER,
  }).visibleTools.map(withMcpToolAnnotations);
}

async function callDaemonBridge(
  state: DaemonState,
  name: string,
  args: Record<string, unknown>,
  actor: CodexToolCallActor
): Promise<unknown> {
  const response = await fetch(`${state.url}/api/v1/mcp/call`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-alembic-daemon-token': state.token || '',
    },
    body: JSON.stringify({ name, args, actor }),
  });

  const payload = await readJsonResponse(response);
  if (response.ok) {
    return payload;
  }
  return failureResult(
    name,
    extractResponseError(payload) || `Daemon bridge returned ${response.status}`,
    {
      daemon: {
        url: state.url,
        pid: state.pid,
        port: state.port,
      },
      response: payload,
    }
  );
}

async function callDaemonHttpEndpoint(
  state: DaemonState,
  path: string,
  request: { body?: Record<string, unknown>; method: 'GET' | 'POST' },
  tool: string
): Promise<unknown> {
  const response = await fetch(`${state.url}${path}`, {
    method: request.method,
    headers: {
      'content-type': 'application/json',
      'x-alembic-daemon-token': state.token || '',
    },
    body: request.body ? JSON.stringify(request.body) : undefined,
  });

  const payload = await readJsonResponse(response);
  if (response.ok) {
    return payload;
  }
  return failureResult(
    tool,
    extractResponseError(payload) || `Daemon job API returned ${response.status}`,
    {
      daemon: {
        url: state.url,
        pid: state.pid,
        port: state.port,
      },
      response: payload,
    }
  );
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { success: false, message: text };
  }
}

function failureResult(
  tool: string,
  message: string,
  data: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    success: false,
    message,
    errorCode: 'CODEX_MCP_ERROR',
    tool,
    data,
  };
}

function isErrorResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') {
    return false;
  }
  const value = result as { ok?: unknown; success?: unknown; isError?: unknown };
  return value.ok === false || value.success === false || value.isError === true;
}

function extractResponseError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const obj = payload as { message?: unknown; error?: { message?: unknown } };
  return typeof obj.message === 'string'
    ? obj.message
    : typeof obj.error?.message === 'string'
      ? obj.error.message
      : null;
}

function buildJobQuery(args: Record<string, unknown>): string {
  const params = new URLSearchParams();
  if (args.kind === 'bootstrap' || args.kind === 'rescan') {
    params.set('kind', args.kind);
  }
  if (
    args.status === 'queued' ||
    args.status === 'running' ||
    args.status === 'completed' ||
    args.status === 'failed' ||
    args.status === 'cancelled'
  ) {
    params.set('status', args.status);
  }
  if (typeof args.limit === 'number' && Number.isFinite(args.limit)) {
    params.set('limit', String(args.limit));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

function resolveProjectRoot(projectRoot?: string): string {
  return resolve(
    projectRoot ||
      process.env.ALEMBIC_PROJECT_DIR ||
      process.env.CODEX_WORKSPACE_DIR ||
      process.env.INIT_CWD ||
      process.env.PWD ||
      process.cwd()
  );
}

export async function startCodexMcpServer(): Promise<CodexMcpServer> {
  const server = new CodexMcpServer();
  await server.start();
  return server;
}

export default CodexMcpServer;
