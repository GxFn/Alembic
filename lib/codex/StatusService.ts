import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DaemonStatus } from '../daemon/DaemonSupervisor.js';
import { DaemonSupervisor } from '../daemon/DaemonSupervisor.js';
import type { GitDiffCheckpointStatus } from '../service/evolution/git-diff-checkpoint/index.js';
import { DEFAULT_FOLDER_NAMES } from '../shared/folder-names.js';
import { WorkspaceResolver } from '../shared/WorkspaceResolver.js';
import { WorkspaceSettingsStore } from '../shared/WorkspaceSettingsStore.js';
import { type CodexAiConfigState, inspectCodexAiConfig } from './AiConfigState.js';
import { buildCodexRuntimeDiagnostics } from './Diagnostics.js';
import { type CodexKnowledgeState, inspectCodexKnowledge } from './KnowledgeState.js';
import {
  buildCodexProjectRootRequiredActions,
  buildCodexProjectRootRequiredMessage,
  type CodexProjectRootResolution,
  getCodexInitMarkerPath,
  readCodexInitMarker,
  resolveCodexProjectRoot,
  summarizeCodexProjectRootResolution,
} from './ProjectRootResolver.js';
import {
  CODEX_SETUP_PROFILE,
  type CodexRuntimeContext,
  resolveCodexRuntimeContext,
} from './RuntimeContext.js';
import {
  buildCodexToolPolicySignals,
  type CodexToolPolicySignal,
  type CodexToolPolicyState,
  resolveCodexToolPolicyState,
} from './ToolPolicy.js';

export interface CodexDaemonStatusProvider {
  status(projectRoot: string): Promise<DaemonStatus>;
}

export interface CodexRecommendedAction {
  arguments: Record<string, unknown>;
  label: string;
  reason: string;
  startsDaemon: boolean;
  tool: string;
}

export interface CodexStatusServiceOptions {
  autoInit?: Record<string, unknown>;
  projectRootResolution?: CodexProjectRootResolution;
  runtime?: CodexRuntimeContext;
  supervisor?: CodexDaemonStatusProvider;
}

export interface CodexStatusData {
  aiConfig: CodexAiConfigState;
  channel: { expectedId: string; id: string };
  daemon: CodexDaemonSummary & {
    health: Record<string, unknown> | null;
    implemented: boolean;
    pidExists: boolean;
    stateExists: boolean;
  };
  diagnostics: Record<string, unknown>;
  gitDiffCheckpoint: GitDiffCheckpointStatus | null;
  initialized: boolean;
  knowledge: CodexKnowledgeState;
  autoInit: Record<string, unknown>;
  mcp: Record<string, unknown>;
  nextActions: string[];
  ok: boolean;
  onboarding: Record<string, unknown>;
  packageVersion: string;
  policy: {
    signals: CodexToolPolicySignal[];
    state: CodexToolPolicyState;
  };
  profile: string;
  projectRootResolution: Record<string, unknown>;
  projectArtifacts: {
    knowledgeDir: string;
    knowledgeExists: boolean;
    runtimeDir: string;
    runtimeExists: boolean;
  };
  projectRoot: string;
  registry: Record<string, unknown>;
  workspace: {
    candidatesDir: string;
    configExists: boolean;
    configPath: string;
    dataRoot: string;
    dataRootSource: string;
    databaseExists: boolean;
    databasePath: string;
    ghost: boolean;
    knowledgeDir: string;
    knowledgeExists: boolean;
    mode: string;
    recipesDir: string;
    recipesExists: boolean;
    runtimeDir: string;
    runtimeExists: boolean;
    secretsExists: boolean;
    secretsPath: string;
    settingsExists: boolean;
    settingsPath: string;
    skillsDir: string;
    wikiDir: string;
    workspaceExists: boolean;
  };
}

export async function buildCodexStatus(
  projectRootInput: string,
  options: CodexStatusServiceOptions = {}
): Promise<CodexStatusData> {
  const projectRoot = resolve(projectRootInput);
  const resolver = WorkspaceResolver.fromProject(projectRoot);
  const settingsStore = new WorkspaceSettingsStore(resolver);
  const aiConfig = inspectCodexAiConfig(projectRoot);
  const facts = resolver.toFacts();
  const supervisor = options.supervisor || new DaemonSupervisor();
  const daemonStatus = await supervisor.status(projectRoot);
  const knowledge = inspectCodexKnowledge(projectRoot);
  const runtime = options.runtime || resolveCodexRuntimeContext();
  const projectRootResolution =
    options.projectRootResolution || resolveCodexProjectRoot({ projectRoot: projectRootInput });
  const autoInit = buildCodexAutoInitStatus(projectRoot, knowledge, projectRootResolution, {
    runtimeState: options.autoInit,
  });
  const diagnostics = buildCodexRuntimeDiagnostics(daemonStatus, runtime, {
    autoInit,
    projectRootResolution,
  });
  const policyInput = {
    coreTools: [],
    daemon: daemonStatus,
    knowledge,
    tierOrder: {},
  };
  const policyState = resolveCodexToolPolicyState(policyInput);
  const onboarding = buildCodexStatusOnboarding({
    daemonStatus,
    diagnostics,
    knowledge,
    projectRootResolution,
  });
  const daemonStatePath = join(resolver.runtimeDir, 'daemon.json');
  const daemonPidPath = join(resolver.runtimeDir, 'daemon.pid');
  const gitDiffCheckpoint = readGitDiffCheckpointStatus(daemonStatus.health);

  return {
    ok: knowledge.initialized,
    aiConfig,
    packageVersion: runtime.packageVersion,
    profile: CODEX_SETUP_PROFILE,
    channel: {
      id: runtime.channelId,
      expectedId: runtime.expectedChannelId,
    },
    initialized: knowledge.initialized,
    projectRoot,
    projectRootResolution: summarizeCodexProjectRootResolution(projectRootResolution),
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
      workspaceExists: facts.workspaceExists,
      runtimeDir: resolver.runtimeDir,
      runtimeExists: existsSync(resolver.runtimeDir),
      configPath: resolver.configPath,
      configExists: existsSync(resolver.configPath),
      databasePath: resolver.databasePath,
      databaseExists: existsSync(resolver.databasePath),
      knowledgeDir: resolver.knowledgeDir,
      knowledgeExists: existsSync(resolver.knowledgeDir),
      recipesDir: resolver.recipesDir,
      recipesExists: existsSync(resolver.recipesDir),
      candidatesDir: resolver.candidatesDir,
      skillsDir: resolver.skillsDir,
      wikiDir: resolver.wikiDir,
      settingsPath: settingsStore.settingsPath,
      settingsExists: existsSync(settingsStore.settingsPath),
      secretsPath: settingsStore.secretsPath,
      secretsExists: existsSync(settingsStore.secretsPath),
    },
    autoInit,
    knowledge,
    projectArtifacts: {
      runtimeDir: join(projectRoot, DEFAULT_FOLDER_NAMES.project.runtime),
      runtimeExists: existsSync(join(projectRoot, DEFAULT_FOLDER_NAMES.project.runtime)),
      knowledgeDir: join(projectRoot, DEFAULT_FOLDER_NAMES.project.knowledgeBase),
      knowledgeExists: existsSync(join(projectRoot, DEFAULT_FOLDER_NAMES.project.knowledgeBase)),
    },
    mcp: {
      runtimeCommand: runtime.runtimeBin,
      channelId: runtime.channelId,
      tier: runtime.requestedTier,
      effectiveTier: runtime.effectiveTier,
      adminEnabled: runtime.adminEnabled,
      requiresProjectEnv: null,
    },
    gitDiffCheckpoint,
    daemon: {
      ...summarizeCodexDaemonStatus(daemonStatus),
      implemented: true,
      statePath: daemonStatePath,
      stateExists: existsSync(daemonStatePath),
      pidPath: daemonPidPath,
      pidExists: existsSync(daemonPidPath),
      health: daemonStatus.health,
      state:
        summarizeCodexDaemonState(daemonStatus.state) ||
        summarizeCodexDaemonState(readJsonIfExists(daemonStatePath)),
    },
    diagnostics,
    onboarding,
    nextActions: buildCodexActionLabels(onboarding.nextActions),
    policy: {
      signals: buildCodexToolPolicySignals(policyInput, policyState),
      state: policyState,
    },
  };
}

function readGitDiffCheckpointStatus(
  health: Record<string, unknown> | null
): GitDiffCheckpointStatus | null {
  const data = (health?.data || null) as Record<string, unknown> | null;
  const status = data?.gitDiffCheckpoint;
  if (!status || typeof status !== 'object') {
    return null;
  }
  return status as GitDiffCheckpointStatus;
}

function buildCodexAutoInitStatus(
  projectRoot: string,
  knowledge: CodexKnowledgeState,
  projectRootResolution: CodexProjectRootResolution,
  options: { runtimeState?: Record<string, unknown> } = {}
): Record<string, unknown> {
  let markerPath: string | null = null;
  let markerExists = false;
  let marker = null;
  try {
    markerPath = getCodexInitMarkerPath(projectRoot);
    marker = readCodexInitMarker(projectRoot);
    markerExists = Boolean(marker);
  } catch {
    markerPath = null;
  }
  const runtimeState = options.runtimeState || {};
  const skippedReason =
    projectRootResolution.trust !== 'trusted'
      ? buildCodexProjectRootRequiredMessage(projectRootResolution)
      : knowledge.initialized
        ? 'workspace already initialized'
        : 'waiting for explicit init or an init-on-demand tool call';
  return {
    enabled: true,
    attempted: Boolean(runtimeState.attempted) || markerExists,
    ok: runtimeState.ok === true || markerExists,
    skippedReason,
    route: runtimeState.route || marker?.route || null,
    requestedTool: runtimeState.requestedTool || marker?.requestedTool || null,
    lastError: runtimeState.lastError || null,
    lastAttemptedAt: runtimeState.lastAttemptedAt || marker?.initializedAt || null,
    markerPath,
    markerExists,
    marker,
  };
}

export interface CodexDaemonSummary {
  dataRoot: string;
  logPath: string;
  message?: string;
  pidAlive: boolean;
  pidPath: string;
  projectId: string | null;
  projectRoot: string;
  ready: boolean;
  state: Record<string, unknown> | null;
  statePath: string;
  status: string;
}

export function summarizeCodexDaemonStatus(status: DaemonStatus): CodexDaemonSummary {
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
    state: summarizeCodexDaemonState(status.state),
    message: status.message,
  };
}

export function buildCodexPostInitActions(
  knowledge: CodexKnowledgeState
): CodexRecommendedAction[] {
  if (knowledge.usable) {
    return [
      buildCodexRecommendedAction({
        arguments: { operation: 'prime' },
        label: 'Prime Codex',
        reason: 'Load the most relevant Alembic Recipes before non-trivial coding work.',
        startsDaemon: true,
        tool: 'alembic_task',
      }),
      buildCodexRecommendedAction({
        label: 'Start bootstrap',
        reason: 'Refresh Alembic project knowledge in a recoverable background job.',
        startsDaemon: true,
        tool: 'alembic_codex_bootstrap',
      }),
    ];
  }
  return [
    buildCodexRecommendedAction({
      label: 'Start bootstrap',
      reason: 'Build the first Alembic project knowledge in a recoverable background job.',
      startsDaemon: true,
      tool: 'alembic_codex_bootstrap',
    }),
    buildCodexRecommendedAction({
      arguments: { limit: 10 },
      label: 'List jobs',
      reason: 'Recover bootstrap job status after Codex reconnects.',
      startsDaemon: false,
      tool: 'alembic_codex_job',
    }),
  ];
}

export function buildCodexPostInitMessage(knowledge: CodexKnowledgeState): string {
  return knowledge.usable
    ? 'Alembic Codex workspace initialized with usable project knowledge. Next: prime Codex or refresh bootstrap.'
    : 'Alembic Codex workspace initialized. Next: start bootstrap to build the first usable project knowledge.';
}

export function buildCodexKnowledgeGateActions(
  knowledge: CodexKnowledgeState
): CodexRecommendedAction[] {
  const actions = [
    buildCodexRecommendedAction({
      label: 'Check workspace status',
      reason: 'Inspect whether this project is initialized and whether Alembic knowledge exists.',
      startsDaemon: false,
      tool: 'alembic_codex_status',
    }),
  ];
  if (!knowledge.initialized) {
    actions.push(
      buildCodexRecommendedAction({
        label: 'Initialize Ghost workspace',
        reason: 'Create Alembic Codex data roots without writing IDE MCP files into the project.',
        startsDaemon: false,
        tool: 'alembic_codex_init',
      })
    );
  } else {
    actions.push(
      buildCodexRecommendedAction({
        label: 'Start bootstrap',
        reason: 'Build the first Alembic project knowledge in a recoverable background job.',
        startsDaemon: true,
        tool: 'alembic_codex_bootstrap',
      }),
      buildCodexRecommendedAction({
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

export function buildCodexStatusOnboarding(input: {
  daemonStatus: DaemonStatus;
  diagnostics: Record<string, unknown>;
  knowledge: CodexKnowledgeState;
  projectRootResolution?: CodexProjectRootResolution;
}): Record<string, unknown> {
  if (input.projectRootResolution && input.projectRootResolution.trust !== 'trusted') {
    return {
      state: 'project_root_unresolved',
      summary:
        'Alembic Codex cannot determine the target project directory, so project workflows cannot be used yet.',
      primaryAction: buildCodexRecommendedAction({
        label: 'Run diagnostics',
        reason:
          'Show why the project root is unavailable and which absolute path must be provided.',
        startsDaemon: false,
        tool: 'alembic_codex_diagnostics',
      }),
      nextActions: [
        buildCodexRecommendedAction({
          label: 'Run diagnostics',
          reason: 'Show the rejected or fallback project root and required environment variables.',
          startsDaemon: false,
          tool: 'alembic_codex_diagnostics',
        }),
      ],
      notes: [
        buildCodexProjectRootRequiredMessage(input.projectRootResolution),
        ...buildCodexProjectRootRequiredActions(),
        'Initialization and init-on-demand tools fail closed until the project root is trusted.',
      ],
    };
  }

  const diagnosticsOk = input.diagnostics.ok !== false;
  if (!diagnosticsOk) {
    return {
      state: 'runtime_issue',
      summary:
        'Alembic Codex is installed, but runtime diagnostics need attention before project knowledge is reliable.',
      primaryAction: buildCodexRecommendedAction({
        label: 'Run diagnostics',
        reason: 'Resolve Node, npm, embedded runtime, or plugin metadata issues first.',
        startsDaemon: false,
        tool: 'alembic_codex_diagnostics',
      }),
      nextActions: [
        buildCodexRecommendedAction({
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
      primaryAction: buildCodexRecommendedAction({
        label: 'Initialize Ghost workspace',
        reason: input.knowledge.hasKnowledge
          ? 'Connect Codex to the existing Alembic knowledge base without writing IDE MCP files into the project.'
          : 'Create Alembic Codex data roots without writing IDE MCP files into the project.',
        startsDaemon: false,
        tool: 'alembic_codex_init',
      }),
      nextActions: [
        buildCodexRecommendedAction({
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
      primaryAction: buildCodexRecommendedAction({
        label: 'Start bootstrap',
        reason: 'Build the first Alembic project knowledge in a recoverable background job.',
        startsDaemon: true,
        tool: 'alembic_codex_bootstrap',
      }),
      nextActions: [
        buildCodexRecommendedAction({
          label: 'Start bootstrap',
          reason: 'Create the initial Alembic knowledge base for this project.',
          startsDaemon: true,
          tool: 'alembic_codex_bootstrap',
        }),
        buildCodexRecommendedAction({
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
    primaryAction: buildCodexRecommendedAction({
      arguments: { operation: 'prime' },
      label: 'Prime Codex',
      reason: 'Load relevant Alembic Recipes before non-trivial coding work.',
      startsDaemon: !daemonReady,
      tool: 'alembic_task',
    }),
    nextActions: [
      buildCodexRecommendedAction({
        arguments: { operation: 'prime' },
        label: 'Prime Codex',
        reason: 'Load project conventions and active task context.',
        startsDaemon: !daemonReady,
        tool: 'alembic_task',
      }),
      buildCodexRecommendedAction({
        label: 'Start bootstrap',
        reason: 'Build or refresh project knowledge in a recoverable background job.',
        startsDaemon: !daemonReady,
        tool: 'alembic_codex_bootstrap',
      }),
      buildCodexRecommendedAction({
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

export function buildCodexRecommendedAction(input: {
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

export function buildCodexActionLabels(actions: unknown): string[] {
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

function summarizeCodexDaemonState(state: unknown): Record<string, unknown> | null {
  const value = asPlainRecord(state);
  if (!value) {
    return null;
  }
  return {
    pid: value.pid,
    host: value.host,
    port: value.port,
    url: value.url,
    dashboardUrl: value.dashboardUrl,
    startedAt: value.startedAt,
    lastReadyAt: value.lastReadyAt,
  };
}

function readJsonIfExists(filePath: string): unknown | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
