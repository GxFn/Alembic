import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SetupService } from '../../cli/SetupService.js';
import {
  buildCodexPostInitActions,
  buildCodexPostInitMessage,
  buildCodexProjectRootRequiredActions,
  buildCodexProjectRootRequiredMessage,
  buildCodexRecommendedAction,
  buildCodexRuntimeDiagnostics,
  buildCodexStatus,
  CODEX_ADMIN_ENABLE_ENV,
  CODEX_DEFAULT_MCP_TIER,
  CODEX_MCP_TIER_ENV,
  CODEX_PROJECT_ROOT_PROPERTY,
  CODEX_SETUP_PROFILE,
  type CodexKnowledgeState,
  type CodexProjectRootResolution,
  createCodexJobContext,
  EMPTY_CODEX_KNOWLEDGE_STATE,
  inspectCodexAiConfig,
  inspectCodexKnowledge,
  isCodexInitOnDemandTool,
  isCodexProjectRootDiscoveryTool,
  isTrustedCodexProjectRoot,
  preflightCodexTool,
  resolveCodexProjectRoot,
  resolveCodexRuntimeContext,
  resolveCodexToolPolicy,
  summarizeCodexDaemonStatus,
  summarizeCodexProjectRootResolution,
  writeCodexInitMarker,
  writeCodexSavedProjectRoot,
} from '../../codex/index.js';
import { type DaemonState, resolveDaemonPaths } from '../../daemon/DaemonState.js';
import { type DaemonStatus, DaemonSupervisor } from '../../daemon/DaemonSupervisor.js';
import { JobStore } from '../../daemon/JobStore.js';
import { PROVIDER_KEY_ENV, WorkspaceSettingsStore } from '../../shared/WorkspaceSettingsStore.js';
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

interface CodexInitRuntimeState {
  attempted: boolean;
  lastAttemptedAt: string | null;
  lastError: string | null;
  ok: boolean;
  requestedTool: string | null;
  route: 'explicit' | 'tool-call' | null;
}

interface WorkspaceInitializationInput {
  force: boolean;
  initializedBy: 'alembic_codex_init' | 'codex-plugin-init-on-demand';
  requestedTool?: string;
  route: 'explicit' | 'tool-call';
  seed: boolean;
  standard: boolean;
}

export class CodexMcpServer {
  readonly projectRoot: string;
  readonly projectRootResolution: CodexProjectRootResolution;
  readonly supervisor: DaemonSupervisorLike;
  readonly waitUntilReadyMs: number;
  readonly sessionId: string;
  sdkServer: SdkMcpServer | null = null;
  #initPromise: Promise<Record<string, unknown>> | null = null;
  #initRuntimeState: CodexInitRuntimeState = {
    attempted: false,
    lastAttemptedAt: null,
    lastError: null,
    ok: false,
    requestedTool: null,
    route: null,
  };

  constructor(options: CodexMcpServerOptions = {}) {
    this.projectRootResolution = resolveCodexProjectRoot({ projectRoot: options.projectRoot });
    this.projectRoot = this.projectRootResolution.path || safeProjectRootFallback();
    this.supervisor = options.supervisor || new DaemonSupervisor();
    this.waitUntilReadyMs = options.waitUntilReadyMs ?? 3000;
    this.sessionId = `codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async start(): Promise<void> {
    this.sdkServer = new SdkMcpServer(
      { name: 'alembic-codex', version: '0.1.1' },
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
    const projectRootArg = args.projectRoot;
    if (projectRootArg !== undefined) {
      if (typeof projectRootArg !== 'string' || projectRootArg.trim().length === 0) {
        return failureResult(name, 'projectRoot must be a non-empty absolute path string.', {
          errorCode: 'CODEX_INVALID_PROJECT_ROOT_ARGUMENT',
          required: { projectRoot: 'absolute path' },
        });
      }
      if (!isAbsolute(projectRootArg)) {
        return failureResult(name, 'projectRoot must be an absolute path.', {
          errorCode: 'CODEX_INVALID_PROJECT_ROOT_ARGUMENT',
          received: projectRootArg,
          required: { projectRoot: 'absolute path' },
        });
      }
      const scopedArgs = { ...args };
      delete scopedArgs.projectRoot;
      const scopedServer = new CodexMcpServer({
        projectRoot: projectRootArg,
        supervisor: this.supervisor,
        waitUntilReadyMs: this.waitUntilReadyMs,
      });
      if (isTrustedCodexProjectRoot(scopedServer.projectRootResolution)) {
        writeCodexSavedProjectRoot(scopedServer.projectRoot);
      }
      return scopedServer.handleToolCallInCurrentProject(name, scopedArgs);
    }
    return this.handleToolCallInCurrentProject(name, args);
  }

  private async handleToolCallInCurrentProject(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    let knowledge = inspectCodexKnowledge(this.projectRoot);

    const initialPreflight = preflightCodexTool({
      coreTools: TOOLS,
      knowledge,
      projectRootResolution: this.projectRootResolution,
      stage: 'before-auto-init',
      tierOrder: TIER_ORDER,
      toolName: name,
    });
    if (!initialPreflight.ok) {
      return initialPreflight.failure;
    }

    if (initialPreflight.autoInit) {
      const initResult = await this.ensureWorkspaceInitializedForTool(name);
      if (isErrorResult(initResult)) {
        return initResult;
      }
      knowledge = inspectCodexKnowledge(this.projectRoot);
    }

    const executePreflight = preflightCodexTool({
      aiConfig: isCodexProjectRootDiscoveryTool(name)
        ? null
        : inspectCodexAiConfig(this.projectRoot),
      coreTools: TOOLS,
      knowledge,
      projectRootResolution: this.projectRootResolution,
      stage: 'execute',
      tierOrder: TIER_ORDER,
      toolName: name,
    });
    if (!executePreflight.ok) {
      return executePreflight.failure;
    }

    switch (name) {
      case 'alembic_codex_status':
        return this.buildStatus();
      case 'alembic_codex_diagnostics':
        return this.buildDiagnostics();
      case 'alembic_codex_init':
        return this.initializeWorkspace(args);
      case 'alembic_codex_ai_config':
        return this.configureAi(args);
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
      data: await buildCodexStatus(this.projectRoot, {
        autoInit: this.#initRuntimeState as unknown as Record<string, unknown>,
        projectRootResolution: this.projectRootResolution,
        supervisor: this.supervisor,
      }),
    };
  }

  async buildDiagnostics(): Promise<Record<string, unknown>> {
    const daemonStatus = await this.supervisor.status(this.projectRoot);
    const runtime = resolveCodexRuntimeContext();
    return {
      success: true,
      data: buildCodexRuntimeDiagnostics(daemonStatus, runtime, {
        autoInit: this.#initRuntimeState as unknown as Record<string, unknown>,
        projectRootResolution: this.projectRootResolution,
      }),
    };
  }

  async initializeWorkspace(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const initResult = await this.runWorkspaceInitialization({
      force: Boolean(args.force),
      initializedBy: 'alembic_codex_init',
      route: 'explicit',
      seed: Boolean(args.seed),
      standard: args.standard === true,
    });
    if (isErrorResult(initResult)) {
      return initResult;
    }
    const results = Array.isArray((initResult.data as { results?: unknown })?.results)
      ? ((initResult.data as { results: Array<Record<string, unknown>> }).results ?? [])
      : [];
    const status = await this.buildStatus();
    const ok = initResult.success !== false && results.every((result) => result.ok !== false);
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

  async configureAi(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const mode = args.mode === 'configure' ? 'configure' : 'status';
    if (mode === 'status') {
      return {
        success: true,
        data: { aiConfig: inspectCodexAiConfig(this.projectRoot) },
        message: 'Alembic Codex AI config inspected.',
      };
    }

    const provider = typeof args.provider === 'string' ? args.provider.trim().toLowerCase() : '';
    if (!provider) {
      return failureResult(
        'alembic_codex_ai_config',
        'provider is required when configuring Alembic Codex AI settings.',
        {
          errorCode: 'CODEX_AI_PROVIDER_REQUIRED',
          needsUserInput: true,
          required: { provider: 'deepseek | openai | claude | google | ollama' },
        }
      );
    }
    const apiKey = typeof args.apiKey === 'string' ? args.apiKey.trim() : '';
    if (apiKey && args.confirmChatSecret !== true) {
      return failureResult(
        'alembic_codex_ai_config',
        'confirmChatSecret=true is required before storing an API key provided through Codex chat.',
        {
          errorCode: 'CODEX_AI_SECRET_CONFIRMATION_REQUIRED',
          needsUserInput: true,
          required: { confirmChatSecret: true },
        }
      );
    }
    if (!PROVIDER_KEY_ENV[provider] && provider !== 'ollama') {
      return failureResult('alembic_codex_ai_config', `Unsupported AI provider: ${provider}`, {
        errorCode: 'CODEX_AI_PROVIDER_UNSUPPORTED',
        required: { provider: 'deepseek | openai | claude | google | ollama' },
      });
    }

    if (!inspectCodexKnowledge(this.projectRoot).initialized) {
      const initResult = await this.runWorkspaceInitialization({
        force: false,
        initializedBy: 'codex-plugin-init-on-demand',
        requestedTool: 'alembic_codex_ai_config',
        route: 'tool-call',
        seed: false,
        standard: false,
      });
      if (isErrorResult(initResult)) {
        return initResult;
      }
    }

    const updates: Record<string, string> = {
      ALEMBIC_AI_PROVIDER: provider,
    };
    for (const [argKey, envKey] of [
      ['model', 'ALEMBIC_AI_MODEL'],
      ['proxy', 'ALEMBIC_AI_PROXY'],
      ['reasoningEffort', 'ALEMBIC_AI_REASONING_EFFORT'],
    ] as const) {
      const value = args[argKey];
      if (typeof value === 'string' && value.trim().length > 0) {
        updates[envKey] = value.trim();
      }
    }
    const keyEnv = PROVIDER_KEY_ENV[provider];
    if (apiKey && keyEnv) {
      updates[keyEnv] = apiKey;
    }

    const store = WorkspaceSettingsStore.fromProject(this.projectRoot);
    store.writeAiConfig(updates);
    store.applyToProcessEnv({ override: true });
    return {
      success: true,
      data: { aiConfig: inspectCodexAiConfig(this.projectRoot) },
      message: 'Alembic Codex AI config updated.',
    };
  }

  async ensureWorkspaceInitializedForTool(toolName: string): Promise<Record<string, unknown>> {
    if (!isCodexInitOnDemandTool(toolName)) {
      return { success: true, data: { initialized: false, reason: 'tool is not init-on-demand' } };
    }
    if (inspectCodexKnowledge(this.projectRoot).initialized) {
      return {
        success: true,
        data: {
          initialized: false,
          reason: 'workspace already initialized',
          requestedTool: toolName,
        },
      };
    }
    return this.runWorkspaceInitialization({
      force: false,
      initializedBy: 'codex-plugin-init-on-demand',
      requestedTool: toolName,
      route: 'tool-call',
      seed: false,
      standard: false,
    });
  }

  async runWorkspaceInitialization(
    input: WorkspaceInitializationInput
  ): Promise<Record<string, unknown>> {
    if (!isTrustedCodexProjectRoot(this.projectRootResolution)) {
      const errorCode =
        this.projectRootResolution.trust === 'rejected'
          ? 'CODEX_PROJECT_ROOT_REJECTED'
          : 'CODEX_PROJECT_ROOT_UNRESOLVED';
      this.#initRuntimeState = {
        attempted: false,
        lastAttemptedAt: null,
        lastError: buildCodexProjectRootRequiredMessage(this.projectRootResolution),
        ok: false,
        requestedTool: input.requestedTool || null,
        route: input.route,
      };
      return failureResult(
        input.requestedTool || 'alembic_codex_init',
        buildCodexProjectRootRequiredMessage(this.projectRootResolution),
        {
          errorCode,
          needsUserInput: true,
          projectRootResolution: summarizeCodexProjectRootResolution(this.projectRootResolution),
          required: { projectRoot: 'absolute path' },
          requiredActions: buildCodexProjectRootRequiredActions(),
        }
      );
    }
    if (this.#initPromise) {
      return this.#initPromise;
    }
    const promise = this.performWorkspaceInitialization(input).finally(() => {
      if (this.#initPromise === promise) {
        this.#initPromise = null;
      }
    });
    this.#initPromise = promise;
    return promise;
  }

  private async performWorkspaceInitialization(
    input: WorkspaceInitializationInput
  ): Promise<Record<string, unknown>> {
    const startedAt = new Date().toISOString();
    this.#initRuntimeState = {
      attempted: true,
      lastAttemptedAt: startedAt,
      lastError: null,
      ok: false,
      requestedTool: input.requestedTool || null,
      route: input.route,
    };

    if (
      inspectCodexKnowledge(this.projectRoot).initialized &&
      !input.force &&
      !input.seed &&
      !input.standard
    ) {
      this.#initRuntimeState = { ...this.#initRuntimeState, ok: true };
      return {
        success: true,
        data: {
          alreadyInitialized: true,
          initialized: false,
          requestedTool: input.requestedTool || null,
          results: [],
          route: input.route,
        },
        message: 'Alembic Codex workspace is already initialized.',
      };
    }

    try {
      const service = new SetupService({
        projectRoot: this.projectRoot,
        force: input.force,
        seed: input.seed,
        ghost: input.standard !== true,
        profile: CODEX_SETUP_PROFILE,
        quiet: true,
      });
      const results = (await service.run()) as Array<Record<string, unknown>>;
      const ok = results.every((result) => result.ok !== false);
      if (!ok) {
        this.#initRuntimeState = {
          ...this.#initRuntimeState,
          lastError: 'One or more setup steps failed.',
          ok: false,
        };
        return failureResult(
          input.requestedTool || 'alembic_codex_init',
          'Alembic Codex initialization failed. Run diagnostics before retrying.',
          {
            errorCode: 'CODEX_AUTO_INIT_FAILED',
            results,
            route: input.route,
          }
        );
      }
      const marker = writeCodexInitMarker(this.projectRoot, {
        initializedBy: input.initializedBy,
        requestedTool: input.requestedTool,
        results,
        route: input.route,
      });
      this.#initRuntimeState = {
        ...this.#initRuntimeState,
        lastAttemptedAt: marker.initializedAt,
        ok: true,
      };
      return {
        success: true,
        data: {
          initialized: true,
          marker,
          requestedTool: input.requestedTool || null,
          results,
          route: input.route,
        },
        message:
          input.route === 'explicit'
            ? 'Alembic Codex workspace initialized.'
            : 'Alembic Codex workspace initialized before running the requested tool.',
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.#initRuntimeState = {
        ...this.#initRuntimeState,
        lastError: message,
        ok: false,
      };
      return failureResult(
        input.requestedTool || 'alembic_codex_init',
        'Alembic Codex initialization failed. Run diagnostics before retrying.',
        {
          errorCode: 'CODEX_AUTO_INIT_FAILED',
          lastError: message,
          route: input.route,
        }
      );
    }
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
  projectRoot = resolveCodexProjectRoot().path || safeProjectRootFallback()
) {
  const resolution = resolveCodexProjectRoot({ projectRoot });
  const knowledge = isTrustedCodexProjectRoot(resolution)
    ? inspectCodexKnowledge(projectRoot)
    : buildExplicitProjectRootRequiredKnowledgeState();
  return resolveCodexToolPolicy({
    adminEnabled: process.env[CODEX_ADMIN_ENABLE_ENV] === '1',
    coreTools: TOOLS,
    knowledge,
    tierName,
    tierOrder: TIER_ORDER,
  })
    .visibleTools.map(withMcpToolAnnotations)
    .map(withCodexProjectRootInput);
}

function buildExplicitProjectRootRequiredKnowledgeState(): CodexKnowledgeState {
  return {
    ...EMPTY_CODEX_KNOWLEDGE_STATE,
    initialized: true,
    hasKnowledge: true,
    recipeCount: 1,
    skillCount: 0,
    status: 'knowledge_ready',
    usable: true,
  };
}

function withCodexProjectRootInput<T extends { inputSchema?: Record<string, unknown> }>(
  tool: T
): T {
  const inputSchema = tool.inputSchema || {};
  const properties =
    inputSchema.properties && typeof inputSchema.properties === 'object'
      ? (inputSchema.properties as Record<string, unknown>)
      : {};
  return {
    ...tool,
    inputSchema: {
      ...inputSchema,
      type: 'object',
      properties: {
        projectRoot: CODEX_PROJECT_ROOT_PROPERTY,
        ...properties,
      },
    },
  };
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

function safeProjectRootFallback(): string {
  try {
    return process.cwd();
  } catch {
    return process.env.PWD || homedir();
  }
}

export async function startCodexMcpServer(): Promise<CodexMcpServer> {
  const server = new CodexMcpServer();
  await server.start();
  return server;
}

export default CodexMcpServer;
