export const LOCAL_ALEMBIC_ROUTE = 'local-alembic';
export const DAEMON_FILE_CHANGE_EVENT_SOURCES = ['host-edit', 'git-head', 'git-worktree'] as const;
export const DAEMON_JOB_KINDS = ['bootstrap', 'rescan'] as const;

export type AlembicRuntimeRoute = typeof LOCAL_ALEMBIC_ROUTE;
export type DaemonFileChangeEventSource = (typeof DAEMON_FILE_CHANGE_EVENT_SOURCES)[number];
export type DaemonJobKind = (typeof DAEMON_JOB_KINDS)[number];

export interface InternalAiCapability {
  available: boolean;
  configSource: 'empty' | 'process-env' | 'workspace-settings';
  model: string | null;
  provider: string | null;
}

export interface RuntimeBoundaryWorkspace {
  databasePath: string;
  dataRoot: string;
  ghost: boolean;
  projectId: string | null;
  projectRoot: string;
  runtimeDir: string;
}

export interface AlembicRuntimeBoundaryOptions {
  dashboardUrl: string | null;
  fileMonitorAvailable: boolean;
  internalAi: InternalAiCapability;
  mode: 'api' | 'daemon';
  origin: string | null;
  workspace: RuntimeBoundaryWorkspace;
}

export interface AlembicRuntimeBoundary {
  owner: 'alembic';
  route: AlembicRuntimeRoute;
  workspace: {
    contract: '@alembic/core/workspace';
    databasePath: string;
    dataRoot: string;
    mode: 'ghost' | 'standard';
    projectId: string | null;
    projectRoot: string;
    runtimeDir: string;
  };
  daemon: {
    apiBaseUrl: string | null;
    mode: 'api' | 'daemon';
    owner: 'alembic';
    stateContract: '@alembic/core/daemon';
  };
  dashboard: {
    frontendOwner: 'AlembicDashboard';
    handoff: 'url';
    serverOwner: 'alembic';
    url: string | null;
  };
  fileMonitor: {
    acceptedEventSources: DaemonFileChangeEventSource[];
    available: boolean;
    dispatcher: 'FileChangeDispatcher';
    endpoint: '/api/v1/file-changes';
    longLivedOwner: 'alembic-daemon';
    source: 'daemon-git-worktree';
  };
  internalAi: InternalAiCapability & {
    owner: 'alembic-internal-ai';
    runtimeOwner: 'AlembicAgent';
  };
  jobs: {
    kinds: DaemonJobKind[];
    owner: 'alembic';
    store: '@alembic/core/daemon/JobStore';
  };
}

export function buildAlembicRuntimeBoundary(
  options: AlembicRuntimeBoundaryOptions
): AlembicRuntimeBoundary {
  return {
    owner: 'alembic',
    route: LOCAL_ALEMBIC_ROUTE,
    workspace: {
      contract: '@alembic/core/workspace',
      databasePath: options.workspace.databasePath,
      dataRoot: options.workspace.dataRoot,
      mode: options.workspace.ghost ? 'ghost' : 'standard',
      projectId: options.workspace.projectId,
      projectRoot: options.workspace.projectRoot,
      runtimeDir: options.workspace.runtimeDir,
    },
    daemon: {
      apiBaseUrl: options.origin,
      mode: options.mode,
      owner: 'alembic',
      stateContract: '@alembic/core/daemon',
    },
    dashboard: {
      frontendOwner: 'AlembicDashboard',
      handoff: 'url',
      serverOwner: 'alembic',
      url: options.dashboardUrl,
    },
    fileMonitor: {
      acceptedEventSources: [...DAEMON_FILE_CHANGE_EVENT_SOURCES],
      available: options.fileMonitorAvailable,
      dispatcher: 'FileChangeDispatcher',
      endpoint: '/api/v1/file-changes',
      longLivedOwner: 'alembic-daemon',
      source: 'daemon-git-worktree',
    },
    internalAi: {
      ...options.internalAi,
      owner: 'alembic-internal-ai',
      runtimeOwner: 'AlembicAgent',
    },
    jobs: {
      kinds: [...DAEMON_JOB_KINDS],
      owner: 'alembic',
      store: '@alembic/core/daemon/JobStore',
    },
  };
}
