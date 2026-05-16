import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type DaemonState,
  getPackageVersion,
  resolveDaemonPaths,
} from '@alembic/core/daemon/DaemonState';
import { JobStore } from '@alembic/core/daemon/JobStore';
import { DEFAULT_FOLDER_NAMES } from '@alembic/core/shared/folder-names';
import { WorkspaceResolver } from '@alembic/core/shared/WorkspaceResolver';
import { WorkspaceSettingsStore } from '@alembic/core/shared/WorkspaceSettingsStore';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SetupService } from '../../cli/SetupService.js';
import { type DaemonStatus, DaemonSupervisor } from '../../daemon/DaemonSupervisor.js';
import { DEFAULT_IDE_FOLDER_NAMES } from '../../shared/ide-folder-names.js';
import { PACKAGE_ROOT } from '../../shared/package-assets.js';
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
    const diagnostics = buildRuntimeDiagnostics(daemonStatus);
    const onboarding = buildStatusOnboarding({
      daemonStatus,
      diagnostics,
      knowledge,
    });

    return {
      success: true,
      data: {
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
          cursorDirExists: existsSync(join(this.projectRoot, DEFAULT_IDE_FOLDER_NAMES.cursorRoot)),
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
    return {
      success: true,
      data: buildRuntimeDiagnostics(daemonStatus),
    };
  }

  async initializeWorkspace(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const service = new SetupService({
      projectRoot: this.projectRoot,
      force: Boolean(args.force),
      seed: Boolean(args.seed),
      ghost: args.standard !== true,
      profile: 'codex-plugin',
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
        profile: 'codex-plugin',
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
  tierName = process.env.ALEMBIC_MCP_TIER || 'agent',
  projectRoot = resolveProjectRoot()
) {
  const knowledge = inspectCodexKnowledge(projectRoot);
  const allowedNames = allowedCodexToolNames(knowledge);
  const effectiveTier = resolveEffectiveCodexTier(tierName);
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

function resolveEffectiveCodexTier(tierName: string): string {
  if (tierName === 'admin' && process.env.ALEMBIC_CODEX_ENABLE_ADMIN !== '1') {
    return 'agent';
  }
  return tierName;
}

function buildRuntimeDiagnostics(daemonStatus: DaemonStatus): Record<string, unknown> {
  const packageVersion = getPackageVersion();
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] || '0', 10);
  const npm = probeCommand('npm');
  const npx = probeCommand('npx');
  const npmAvailable = npm.available === true;
  const npxAvailable = npx.available === true;
  const plugin = buildPluginDiagnostics(packageVersion);
  const requestedTier = process.env.ALEMBIC_MCP_TIER || 'agent';
  const effectiveTier = resolveEffectiveCodexTier(requestedTier);
  const adminEnabled = process.env.ALEMBIC_CODEX_ENABLE_ADMIN === '1';
  const checks = {
    adminGate: requestedTier !== 'admin' || adminEnabled,
    node: nodeMajor >= 22,
    npm: npmAvailable,
    npx: npxAvailable,
    packagePin: plugin.mcp.packagePin,
    pluginAssets: plugin.assets.ok,
    pluginManifest: plugin.manifest.ok,
    pluginSkills: plugin.skills.ok,
  };
  const issues = buildDiagnosticIssues({
    adminEnabled,
    checks,
    npm,
    npx,
    packageVersion,
    plugin,
    requestedTier,
  });

  return {
    ok: Object.values(checks).every(Boolean),
    summary: buildDiagnosticSummary(issues),
    checks,
    issues,
    nextActions: buildDiagnosticNextActions(issues),
    primaryAction:
      issues.length === 0
        ? buildRecommendedAction({
            label: 'Check workspace status',
            reason: 'Runtime checks passed; inspect project initialization and daemon state next.',
            startsDaemon: false,
            tool: 'alembic_codex_status',
          })
        : buildRecommendedAction({
            label: 'Fix diagnostics',
            reason: 'Resolve the reported runtime or plugin metadata issue before using Alembic.',
            startsDaemon: false,
            tool: 'alembic_codex_diagnostics',
          }),
    node: {
      ok: checks.node,
      required: '>=22',
      recommended: '22 LTS',
      version: process.versions.node,
      execPath: process.execPath,
      modules: process.versions.modules,
    },
    commands: {
      npm,
      npx,
    },
    package: {
      name: 'alembic-ai',
      version: packageVersion,
      pinnedSpecifier: `alembic-ai@${packageVersion}`,
      mcpBinary: 'alembic-codex-mcp',
    },
    plugin,
    daemon: {
      ready: daemonStatus.ready,
      status: daemonStatus.status,
      stateVersion: daemonStatus.state?.version || null,
      healthVersion: readHealthVersion(daemonStatus.health),
    },
    codex: {
      requestedTier,
      effectiveTier,
      adminEnabled,
      adminMode: adminEnabled
        ? 'enabled-by-ALEMBIC_CODEX_ENABLE_ADMIN'
        : 'disabled-requires-ALEMBIC_CODEX_ENABLE_ADMIN=1',
    },
    offlineFallback: {
      note: 'The marketplace MCP config uses pinned npx. If first-run network access is unavailable, install the same pinned runtime globally and use alembic-codex-mcp from PATH.',
      globalInstall: `npm install -g alembic-ai@${packageVersion}`,
      command: 'alembic-codex-mcp',
    },
    cleanup: {
      automaticOnUninstall: false,
      command: 'alembic_codex_cleanup',
      defaultMode: 'dry-run',
    },
  };
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

interface PluginDiagnostics {
  assets: { missing: string[]; ok: boolean; required: string[] };
  manifest: { ok: boolean; path: string; version: string | null };
  mcp: {
    adminDisabledByDefault: boolean;
    agentTierByDefault: boolean;
    binary: string | null;
    command: string | null;
    ok: boolean;
    packagePin: boolean;
    path: string;
    pinnedSpecifier: string | null;
  };
  ok: boolean;
  readme: { mentionsPinnedRuntime: boolean; ok: boolean; path: string };
  root: string;
  skills: { missing: string[]; ok: boolean; required: string[] };
}

interface DiagnosticIssue {
  action: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

function buildPluginDiagnostics(packageVersion: string): PluginDiagnostics {
  const pluginRoot = join(PACKAGE_ROOT, 'plugins', 'alembic-codex');
  const manifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
  const mcpPath = join(pluginRoot, '.mcp.json');
  const readmePath = join(pluginRoot, 'README.md');
  const manifest = readJsonObject(manifestPath);
  const mcpConfig = readJsonObject(mcpPath);
  const manifestInterface = asPlainRecord(manifest.value?.interface);
  const manifestAssets = collectManifestAssetPaths(manifestInterface);
  const missingAssets = manifestAssets.filter((asset) => !existsSync(join(pluginRoot, asset)));
  const requiredSkills = [
    'alembic',
    'alembic-create',
    'alembic-devdocs',
    'alembic-guard',
    'alembic-recipes',
    'alembic-structure',
  ];
  const missingSkills = requiredSkills.filter(
    (skill) => !existsSync(join(pluginRoot, 'skills', skill, 'SKILL.md'))
  );
  const server = asPlainRecord(asPlainRecord(mcpConfig.value?.mcpServers)?.alembic);
  const args = Array.isArray(server?.args)
    ? server.args.filter((arg): arg is string => typeof arg === 'string')
    : [];
  const packageIndex = args.indexOf('--package');
  const pinnedSpecifier = packageIndex >= 0 ? args[packageIndex + 1] || null : null;
  const command = typeof server?.command === 'string' ? server.command : null;
  const env = asPlainRecord(server?.env);
  const binary = args.find((arg) => arg === 'alembic-codex-mcp') || null;
  const packagePin =
    command === 'npx' &&
    pinnedSpecifier === `alembic-ai@${packageVersion}` &&
    binary === 'alembic-codex-mcp' &&
    !args.includes('latest');
  const adminDisabledByDefault = env?.ALEMBIC_CODEX_ENABLE_ADMIN === '0';
  const agentTierByDefault = env?.ALEMBIC_MCP_TIER === 'agent';
  const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
  const readmeOk = readme.includes(`alembic-ai@${packageVersion}`);

  return {
    assets: {
      missing: missingAssets,
      ok: manifestAssets.length > 0 && missingAssets.length === 0,
      required: manifestAssets,
    },
    manifest: {
      ok: manifest.ok && asString(manifest.value?.name) === 'alembic-codex',
      path: manifestPath,
      version: asString(manifest.value?.version) || null,
    },
    mcp: {
      adminDisabledByDefault,
      agentTierByDefault,
      binary,
      command,
      ok: packagePin && adminDisabledByDefault && agentTierByDefault,
      packagePin,
      path: mcpPath,
      pinnedSpecifier,
    },
    ok:
      manifest.ok &&
      packagePin &&
      adminDisabledByDefault &&
      agentTierByDefault &&
      missingAssets.length === 0 &&
      missingSkills.length === 0 &&
      readmeOk,
    readme: {
      mentionsPinnedRuntime: readmeOk,
      ok: readmeOk,
      path: readmePath,
    },
    root: pluginRoot,
    skills: {
      missing: missingSkills,
      ok: missingSkills.length === 0,
      required: requiredSkills,
    },
  };
}

function buildDiagnosticIssues(input: {
  adminEnabled: boolean;
  checks: Record<string, boolean>;
  npm: Record<string, unknown>;
  npx: Record<string, unknown>;
  packageVersion: string;
  plugin: PluginDiagnostics;
  requestedTier: string;
}): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  if (!input.checks.node) {
    issues.push({
      action:
        'Install Node.js 22 LTS or newer, then restart Codex. Keep MCP and daemon on the same Node executable.',
      code: 'NODE_VERSION_UNSUPPORTED',
      message: `Alembic Codex requires Node.js >=22; current runtime is ${process.versions.node}.`,
      severity: 'error',
    });
  }
  if (!input.checks.npm) {
    issues.push({
      action: 'Install npm or use a Node.js distribution that includes npm.',
      code: 'NPM_UNAVAILABLE',
      message: String(input.npm.error || 'npm is not available.'),
      severity: 'error',
    });
  }
  if (!input.checks.npx) {
    issues.push({
      action: `Install the pinned runtime globally with npm install -g alembic-ai@${input.packageVersion}.`,
      code: 'NPX_UNAVAILABLE',
      message: String(input.npx.error || 'npx is not available.'),
      severity: 'error',
    });
  }
  if (!input.checks.packagePin) {
    issues.push({
      action: `Update plugins/alembic-codex/.mcp.json to use npx --package alembic-ai@${input.packageVersion} alembic-codex-mcp.`,
      code: 'PLUGIN_RUNTIME_PIN_MISMATCH',
      message: 'Codex plugin MCP config is not pinned to the current Alembic runtime package.',
      severity: 'error',
    });
  }
  if (!input.checks.pluginManifest || !input.plugin.readme.ok) {
    issues.push({
      action: 'Run npm run verify:codex-plugin and repair plugin metadata before publishing.',
      code: 'PLUGIN_METADATA_INCOMPLETE',
      message: 'Codex plugin manifest or README metadata is incomplete.',
      severity: 'error',
    });
  }
  if (!input.checks.pluginAssets || !input.checks.pluginSkills) {
    issues.push({
      action: 'Restore missing plugin assets or skills under plugins/alembic-codex.',
      code: 'PLUGIN_ASSETS_OR_SKILLS_MISSING',
      message: 'Codex plugin assets or skills are missing from the package.',
      severity: 'error',
    });
  }
  if (input.requestedTier === 'admin' && !input.adminEnabled) {
    issues.push({
      action: 'Set ALEMBIC_CODEX_ENABLE_ADMIN=1 only for explicit admin workflows.',
      code: 'CODEX_ADMIN_OPT_IN_REQUIRED',
      message: 'Admin tier was requested, but the Codex-specific admin opt-in is disabled.',
      severity: 'warning',
    });
  }
  return issues;
}

function buildDiagnosticNextActions(issues: DiagnosticIssue[]): string[] {
  if (issues.length === 0) {
    return ['Alembic Codex runtime checks passed.'];
  }
  return [...new Set(issues.map((issue) => issue.action))];
}

function buildDiagnosticSummary(issues: DiagnosticIssue[]): string {
  if (issues.length === 0) {
    return 'Alembic Codex runtime checks passed. Continue with status, init, bootstrap, or priming.';
  }
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const parts = [];
  if (errorCount > 0) {
    parts.push(`${errorCount} error${errorCount === 1 ? '' : 's'}`);
  }
  if (warningCount > 0) {
    parts.push(`${warningCount} warning${warningCount === 1 ? '' : 's'}`);
  }
  return `Alembic Codex diagnostics found ${parts.join(' and ')}. Review issues before starting project knowledge workflows.`;
}

function collectManifestAssetPaths(manifestInterface: Record<string, unknown> | null): string[] {
  const assets = [
    asString(manifestInterface?.composerIcon),
    asString(manifestInterface?.logo),
    ...(Array.isArray(manifestInterface?.screenshots)
      ? manifestInterface.screenshots.map((value) => asString(value))
      : []),
  ];
  return assets.filter((asset): asset is string => Boolean(asset));
}

function readJsonObject(filePath: string): { ok: boolean; value: Record<string, unknown> | null } {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return { ok: Boolean(parsed && typeof parsed === 'object'), value: asPlainRecord(parsed) };
  } catch {
    return { ok: false, value: null };
  }
}

function probeCommand(command: string): Record<string, unknown> {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 2000,
  });
  const output = `${result.stdout || result.stderr || ''}`.trim();
  return {
    available: result.status === 0,
    version: result.status === 0 ? output : null,
    error:
      result.status === 0 ? null : result.error?.message || output || `Unable to run ${command}`,
  };
}

function readHealthVersion(health: Record<string, unknown> | null): string | null {
  const data = health?.data;
  if (!data || typeof data !== 'object') {
    return null;
  }
  const version = (data as { version?: unknown }).version;
  return typeof version === 'string' ? version : null;
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

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
