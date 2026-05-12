import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SetupService } from '../../cli/SetupService.js';
import {
  buildCodexRuntimeDiagnostics,
  CODEX_ADMIN_ENABLE_ENV,
  CODEX_DEFAULT_MCP_TIER,
  CODEX_MCP_TIER_ENV,
  CODEX_SETUP_PROFILE,
  resolveCodexRuntimeContext,
  resolveEffectiveCodexTier,
} from '../../codex/index.js';
import { type DaemonState, resolveDaemonPaths } from '../../daemon/DaemonState.js';
import { type DaemonStatus, DaemonSupervisor } from '../../daemon/DaemonSupervisor.js';
import { JobStore } from '../../daemon/JobStore.js';
import { DEFAULT_FOLDER_NAMES } from '../../shared/folder-names.js';
import { WorkspaceResolver } from '../../shared/WorkspaceResolver.js';
import { WorkspaceSettingsStore } from '../../shared/WorkspaceSettingsStore.js';
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

interface CodexRecommendedAction {
  arguments: Record<string, unknown>;
  label: string;
  reason: string;
  startsDaemon: boolean;
  tool: string;
}

interface CodexKnowledgeState {
  hasKnowledge: boolean;
  initialized: boolean;
  recipeCount: number;
  skillCount: number;
  usable: boolean;
}

const CODEX_DISCOVERY_TOOL_NAMES = new Set(['alembic_codex_status', 'alembic_codex_diagnostics']);

const CODEX_INIT_TOOL_NAMES = new Set([...CODEX_DISCOVERY_TOOL_NAMES, 'alembic_codex_init']);

const CODEX_COLD_START_TOOL_NAMES = new Set([
  ...CODEX_INIT_TOOL_NAMES,
  'alembic_codex_bootstrap',
  'alembic_codex_job',
]);

export const CODEX_LOCAL_TOOLS = [
  {
    name: 'alembic_codex_status',
    tier: 'agent',
    description:
      'Check Alembic Codex plugin status without starting the daemon. Reports workspace, Ghost data root, initialization, daemon state, and the recommended next tool call.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'alembic_codex_diagnostics',
    tier: 'agent',
    description:
      'Run Alembic Codex runtime diagnostics without starting the daemon. Checks Node, npm, npx, package pinning, daemon version, offline fallback, admin mode gate, and first-run next actions.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'alembic_codex_init',
    tier: 'agent',
    description:
      'Initialize Alembic for Codex plugin use. Defaults to Ghost mode, skips IDE file deployment, and returns next actions for bootstrap or priming.',
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description: 'Overwrite existing Alembic Codex setup artifacts.',
        },
        seed: { type: 'boolean', description: 'Create seed example Recipes.' },
        standard: {
          type: 'boolean',
          description: 'Write Alembic data into the project instead of the Ghost data root.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'alembic_codex_dashboard',
    tier: 'agent',
    description:
      'Start or connect to the project Alembic daemon and return the local Dashboard URL plus follow-up job actions.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'alembic_codex_bootstrap',
    tier: 'agent',
    description:
      'Start or connect to the daemon and enqueue an internal Alembic bootstrap job. Returns immediately with a recoverable job id.',
    inputSchema: {
      type: 'object',
      properties: {
        maxFiles: { type: 'number', description: 'Maximum files to include in project analysis.' },
        skipGuard: { type: 'boolean', description: 'Skip Guard audit during bootstrap analysis.' },
        contentMaxLines: {
          type: 'number',
          description: 'Maximum lines of content sampled per file.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'alembic_codex_rescan',
    tier: 'agent',
    description:
      'Start or connect to the daemon and enqueue an internal Alembic rescan job. Returns immediately with a recoverable job id.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short reason for the rescan.' },
        dimensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional dimension ids to rescan.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'alembic_codex_job',
    tier: 'agent',
    description:
      'Read Alembic daemon job status from the local JobStore without starting the daemon. Pass jobId for one job, or omit it to list recent jobs.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'Job id returned by alembic_codex_bootstrap or alembic_codex_rescan.',
        },
        kind: { type: 'string', enum: ['bootstrap', 'rescan'] },
        status: {
          type: 'string',
          enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
        },
        limit: { type: 'number', description: 'Maximum jobs to return when listing.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'alembic_codex_stop',
    tier: 'agent',
    description: 'Stop the current project Alembic daemon.',
    inputSchema: {
      type: 'object',
      properties: {
        waitMs: { type: 'number', description: 'Milliseconds to wait for graceful daemon stop.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'alembic_codex_cleanup',
    tier: 'agent',
    description:
      'Preview or explicitly clean Alembic Codex runtime files. Plugin uninstall never removes user data automatically; this tool requires confirm=true before deleting runtime state.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          description: 'When true, stop the daemon and delete runtime state/log/job files.',
        },
      },
      additionalProperties: false,
    },
  },
];

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
          nextActions: buildKnowledgeGateActions(knowledge),
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
    const resolver = WorkspaceResolver.fromProject(this.projectRoot);
    const settingsStore = new WorkspaceSettingsStore(resolver);
    const facts = resolver.toFacts();
    const daemonStatus = await this.supervisor.status(this.projectRoot);
    const knowledge = inspectCodexKnowledge(this.projectRoot);
    const runtime = resolveCodexRuntimeContext();
    const diagnostics = buildCodexRuntimeDiagnostics(daemonStatus, runtime);
    const onboarding = buildStatusOnboarding({
      daemonStatus,
      diagnostics,
      knowledge,
    });

    return {
      success: true,
      data: {
        channel: {
          id: runtime.channelId,
          expectedId: runtime.expectedChannelId,
        },
        initialized: knowledge.initialized,
        projectRoot: this.projectRoot,
        registry: {
          registered: facts.registered,
          path: facts.registryPath,
          projectId: facts.projectId,
          expectedProjectId: facts.expectedProjectId,
        },
        workspace: {
          mode: facts.mode,
          ghost: facts.ghost,
          dataRoot: facts.dataRoot,
          dataRootSource: facts.dataRootSource,
          runtimeDir: resolver.runtimeDir,
          configPath: resolver.configPath,
          databasePath: resolver.databasePath,
          knowledgeDir: resolver.knowledgeDir,
          recipesDir: resolver.recipesDir,
          candidatesDir: resolver.candidatesDir,
          skillsDir: resolver.skillsDir,
          wikiDir: resolver.wikiDir,
          settingsPath: settingsStore.settingsPath,
          settingsExists: existsSync(settingsStore.settingsPath),
          secretsPath: settingsStore.secretsPath,
          secretsExists: existsSync(settingsStore.secretsPath),
        },
        knowledge,
        projectArtifacts: {
          runtimeExists: existsSync(join(this.projectRoot, DEFAULT_FOLDER_NAMES.project.runtime)),
          knowledgeExists: existsSync(
            join(this.projectRoot, DEFAULT_FOLDER_NAMES.project.knowledgeBase)
          ),
          cursorDirExists: existsSync(join(this.projectRoot, DEFAULT_FOLDER_NAMES.ide.cursorRoot)),
          vscodeMcpExists: existsSync(join(this.projectRoot, '.vscode', 'mcp.json')),
        },
        daemon: summarizeDaemonStatus(daemonStatus),
        diagnostics,
        onboarding,
        nextActions: buildActionLabels(onboarding.nextActions),
      },
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
    const knowledgeAfterInit = (status as { data?: { knowledge?: CodexKnowledgeState } }).data
      ?.knowledge ?? {
      hasKnowledge: false,
      initialized: false,
      recipeCount: 0,
      skillCount: 0,
      usable: false,
    };
    return {
      success: ok,
      data: {
        mode: args.standard === true ? 'standard' : 'ghost',
        nextActions: ok
          ? buildPostInitActions(knowledgeAfterInit)
          : [
              buildRecommendedAction({
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
        ? buildPostInitMessage(knowledgeAfterInit)
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
          daemon: summarizeDaemonStatus(daemon),
          nextActions: [
            buildRecommendedAction({
              label: 'Run diagnostics',
              reason: 'Check Node, npm, package pinning, and daemon state before retrying.',
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
        daemon: summarizeDaemonStatus(daemon),
        nextActions: [
          buildRecommendedAction({
            label: 'Start bootstrap',
            reason: 'Create or refresh Alembic project knowledge from the Dashboard-backed daemon.',
            startsDaemon: true,
            tool: 'alembic_codex_bootstrap',
          }),
          buildRecommendedAction({
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
      data: { daemon: summarizeDaemonStatus(daemon) },
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
          daemon: summarizeDaemonStatus(daemon),
          nextActions: [
            buildRecommendedAction({
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
        { daemon: summarizeDaemonStatus(daemon) }
      );
    }

    return callDaemonHttpEndpoint(
      daemon.state,
      `/api/v1/jobs/${kind}`,
      {
        method: 'POST',
        body: args,
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
        daemon: summarizeDaemonStatus(daemon),
      });
    }
    if (!daemon.state.token) {
      return failureResult(name, 'Alembic daemon token is missing. Restart the daemon and retry.', {
        daemon: summarizeDaemonStatus(daemon),
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
  const allowedNames = allowedCodexToolNames(knowledge);
  const effectiveTier = resolveEffectiveCodexTier(
    tierName,
    process.env[CODEX_ADMIN_ENABLE_ENV] === '1'
  );
  const maxTier = (TIER_ORDER as Record<string, number>)[effectiveTier] ?? TIER_ORDER.agent;
  const coreTools = TOOLS.filter(
    (tool) =>
      knowledge.usable &&
      ((TIER_ORDER as Record<string, number>)[tool.tier || 'agent'] ?? 0) <= maxTier
  );
  const localTools = CODEX_LOCAL_TOOLS.filter((tool) => allowedNames.has(tool.name));
  return [...localTools, ...coreTools].map(withMcpToolAnnotations);
}

function allowedCodexToolNames(knowledge: CodexKnowledgeState): Set<string> {
  if (knowledge.usable) {
    return new Set(CODEX_LOCAL_TOOLS.map((tool) => tool.name));
  }
  if (knowledge.initialized) {
    return CODEX_COLD_START_TOOL_NAMES;
  }
  return CODEX_INIT_TOOL_NAMES;
}

function isToolAllowedForCodexKnowledge(name: string, knowledge: CodexKnowledgeState): boolean {
  if (knowledge.usable) {
    return true;
  }
  return allowedCodexToolNames(knowledge).has(name);
}

function inspectCodexKnowledge(projectRoot: string): CodexKnowledgeState {
  let resolver: WorkspaceResolver;
  try {
    resolver = WorkspaceResolver.fromProject(projectRoot);
  } catch {
    resolver = new WorkspaceResolver({ projectRoot });
  }
  const initialized =
    existsSync(resolver.configPath) &&
    existsSync(resolver.databasePath) &&
    existsSync(resolver.knowledgeDir) &&
    existsSync(resolver.recipesDir);
  const recipeCount = countMarkdownFiles(resolver.recipesDir, {
    excludeNames: new Set(['_template.md']),
  });
  const skillCount = countSkillFiles(resolver.skillsDir);
  const hasKnowledge = recipeCount > 0 || skillCount > 0;
  return {
    hasKnowledge,
    initialized,
    recipeCount,
    skillCount,
    usable: initialized && hasKnowledge,
  };
}

function countMarkdownFiles(dir: string, options: { excludeNames?: Set<string> } = {}): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).reduce((count, entry) => {
      if (entry.isDirectory()) {
        return count + countMarkdownFiles(join(dir, entry.name), options);
      }
      return (
        count +
        (entry.isFile() && entry.name.endsWith('.md') && !options.excludeNames?.has(entry.name)
          ? 1
          : 0)
      );
    }, 0);
  } catch {
    return 0;
  }
}

function countSkillFiles(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).reduce(
      (count, entry) =>
        count + (entry.isDirectory() && existsSync(join(dir, entry.name, 'SKILL.md')) ? 1 : 0),
      0
    );
  } catch {
    return 0;
  }
}

function buildPostInitActions(knowledge: CodexKnowledgeState): CodexRecommendedAction[] {
  if (knowledge.usable) {
    return [
      buildRecommendedAction({
        arguments: { operation: 'prime' },
        label: 'Prime Codex',
        reason: 'Load the most relevant Alembic Recipes before non-trivial coding work.',
        startsDaemon: true,
        tool: 'alembic_task',
      }),
      buildRecommendedAction({
        label: 'Start bootstrap',
        reason: 'Refresh Alembic project knowledge in a recoverable background job.',
        startsDaemon: true,
        tool: 'alembic_codex_bootstrap',
      }),
    ];
  }
  return [
    buildRecommendedAction({
      label: 'Start bootstrap',
      reason: 'Build the first Alembic project knowledge in a recoverable background job.',
      startsDaemon: true,
      tool: 'alembic_codex_bootstrap',
    }),
    buildRecommendedAction({
      arguments: { limit: 10 },
      label: 'List jobs',
      reason: 'Recover bootstrap job status after Codex reconnects.',
      startsDaemon: false,
      tool: 'alembic_codex_job',
    }),
  ];
}

function buildPostInitMessage(knowledge: CodexKnowledgeState): string {
  return knowledge.usable
    ? 'Alembic Codex workspace initialized with usable project knowledge. Next: prime Codex or refresh bootstrap.'
    : 'Alembic Codex workspace initialized. Next: start bootstrap to build the first usable project knowledge.';
}

function buildKnowledgeGateActions(knowledge: CodexKnowledgeState): CodexRecommendedAction[] {
  const actions = [
    buildRecommendedAction({
      label: 'Check workspace status',
      reason: 'Inspect whether this project is initialized and whether Alembic knowledge exists.',
      startsDaemon: false,
      tool: 'alembic_codex_status',
    }),
  ];
  if (!knowledge.initialized) {
    actions.push(
      buildRecommendedAction({
        label: 'Initialize Ghost workspace',
        reason: 'Create Alembic Codex data roots without writing IDE MCP files into the project.',
        startsDaemon: false,
        tool: 'alembic_codex_init',
      })
    );
  } else {
    actions.push(
      buildRecommendedAction({
        label: 'Start bootstrap',
        reason: 'Build the first Alembic project knowledge in a recoverable background job.',
        startsDaemon: true,
        tool: 'alembic_codex_bootstrap',
      }),
      buildRecommendedAction({
        arguments: { limit: 10 },
        label: 'List jobs',
        reason: 'Recover bootstrap job status after Codex reconnects.',
        startsDaemon: false,
        tool: 'alembic_codex_job',
      })
    );
  }
  return actions;
}

function buildStatusOnboarding(input: {
  daemonStatus: DaemonStatus;
  diagnostics: Record<string, unknown>;
  knowledge: CodexKnowledgeState;
}): Record<string, unknown> {
  const diagnosticsOk = input.diagnostics.ok !== false;
  if (!diagnosticsOk) {
    return {
      state: 'runtime_issue',
      summary:
        'Alembic Codex is installed, but runtime diagnostics need attention before project knowledge is reliable.',
      primaryAction: buildRecommendedAction({
        label: 'Run diagnostics',
        reason: 'Resolve Node, npm, package pinning, or plugin metadata issues first.',
        startsDaemon: false,
        tool: 'alembic_codex_diagnostics',
      }),
      nextActions: [
        buildRecommendedAction({
          label: 'Run diagnostics',
          reason: 'Inspect structured issues and repair guidance.',
          startsDaemon: false,
          tool: 'alembic_codex_diagnostics',
        }),
      ],
      notes: ['Status checks do not start the daemon.'],
    };
  }

  if (!input.knowledge.initialized) {
    return {
      state: input.knowledge.hasKnowledge ? 'needs_init_existing_knowledge' : 'needs_init',
      summary: input.knowledge.hasKnowledge
        ? 'Alembic knowledge files exist for this project, but the Codex workspace runtime has not been initialized yet.'
        : 'Alembic Codex is installed and the runtime is healthy, but this workspace has not been initialized yet.',
      primaryAction: buildRecommendedAction({
        label: 'Initialize Ghost workspace',
        reason: input.knowledge.hasKnowledge
          ? 'Connect Codex to the existing Alembic knowledge base without writing IDE MCP files into the project.'
          : 'Create Alembic Codex data roots without writing IDE MCP files into the project.',
        startsDaemon: false,
        tool: 'alembic_codex_init',
      }),
      nextActions: [
        buildRecommendedAction({
          label: 'Initialize Ghost workspace',
          reason: 'Set up local Alembic config, database, knowledge, and Recipe directories.',
          startsDaemon: false,
          tool: 'alembic_codex_init',
        }),
      ],
      notes: [
        input.knowledge.hasKnowledge
          ? 'Only cold-start initialization tools are exposed until setup completes.'
          : 'Only cold-start initialization tools are exposed until Alembic knowledge exists.',
        'Ghost mode keeps Alembic data outside the repository by default.',
      ],
    };
  }

  if (!input.knowledge.usable) {
    return {
      state: 'needs_bootstrap',
      summary:
        'Alembic Codex is initialized, but this project does not have usable Alembic Recipes or Project Skills yet.',
      primaryAction: buildRecommendedAction({
        label: 'Start bootstrap',
        reason: 'Build the first Alembic project knowledge in a recoverable background job.',
        startsDaemon: true,
        tool: 'alembic_codex_bootstrap',
      }),
      nextActions: [
        buildRecommendedAction({
          label: 'Start bootstrap',
          reason: 'Create the initial Alembic knowledge base for this project.',
          startsDaemon: true,
          tool: 'alembic_codex_bootstrap',
        }),
        buildRecommendedAction({
          arguments: { limit: 10 },
          label: 'List jobs',
          reason: 'Recover bootstrap job status after Codex reconnects.',
          startsDaemon: false,
          tool: 'alembic_codex_job',
        }),
      ],
      notes: [
        'Project-knowledge tools stay hidden until Recipes or Project Skills exist.',
        'Prime, Guard, search, rescan, and lifecycle tools are available after the knowledge base is usable.',
      ],
    };
  }

  const daemonReady = input.daemonStatus.ready === true;
  return {
    state: daemonReady ? 'ready_daemon_running' : 'ready',
    summary: daemonReady
      ? 'Alembic Codex is initialized and the daemon is ready.'
      : 'Alembic Codex is initialized. The daemon will start on demand when a project-knowledge tool needs it.',
    primaryAction: buildRecommendedAction({
      arguments: { operation: 'prime' },
      label: 'Prime Codex',
      reason: 'Load relevant Alembic Recipes before non-trivial coding work.',
      startsDaemon: !daemonReady,
      tool: 'alembic_task',
    }),
    nextActions: [
      buildRecommendedAction({
        arguments: { operation: 'prime' },
        label: 'Prime Codex',
        reason: 'Load project conventions and active task context.',
        startsDaemon: !daemonReady,
        tool: 'alembic_task',
      }),
      buildRecommendedAction({
        label: 'Start bootstrap',
        reason: 'Build or refresh project knowledge in a recoverable background job.',
        startsDaemon: !daemonReady,
        tool: 'alembic_codex_bootstrap',
      }),
      buildRecommendedAction({
        label: 'Open Dashboard',
        reason: 'Inspect jobs, candidates, and project knowledge in the local UI.',
        startsDaemon: !daemonReady,
        tool: 'alembic_codex_dashboard',
      }),
    ],
    notes: daemonReady
      ? ['Dashboard and job APIs are available now.']
      : ['Status checks stay light; project-knowledge tools wake the daemon only when needed.'],
  };
}

function buildRecommendedAction(input: {
  arguments?: Record<string, unknown>;
  label: string;
  reason: string;
  startsDaemon: boolean;
  tool: string;
}): CodexRecommendedAction {
  return {
    arguments: input.arguments || {},
    label: input.label,
    reason: input.reason,
    startsDaemon: input.startsDaemon,
    tool: input.tool,
  };
}

function buildActionLabels(actions: unknown): string[] {
  return Array.isArray(actions)
    ? actions
        .map((action) => asPlainRecord(action))
        .map((action) =>
          action && typeof action.tool === 'string' && typeof action.label === 'string'
            ? `${action.label}: call ${action.tool}`
            : null
        )
        .filter((value): value is string => Boolean(value))
    : [];
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

function summarizeDaemonStatus(status: DaemonStatus): Record<string, unknown> {
  return {
    status: status.status,
    ready: status.ready,
    projectRoot: status.projectRoot,
    dataRoot: status.dataRoot,
    projectId: status.projectId,
    pidAlive: status.pidAlive,
    statePath: status.statePath,
    pidPath: status.pidPath,
    logPath: status.logPath,
    state: status.state
      ? {
          pid: status.state.pid,
          host: status.state.host,
          port: status.state.port,
          url: status.state.url,
          dashboardUrl: status.state.dashboardUrl,
          startedAt: status.state.startedAt,
          lastReadyAt: status.state.lastReadyAt,
        }
      : null,
    message: status.message,
  };
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

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
