import {
  ALEMBIC_FILE_CHANGES_PATH,
  ALEMBIC_FILE_MONITOR_EVENT_SOURCES,
  ALEMBIC_JOB_ENDPOINTS,
  ALEMBIC_JOB_KINDS,
  type AlembicEnhancementRoute,
  type AlembicInternalAiCapability,
  type AlembicRuntimeCapabilities,
  type AlembicRuntimeMode,
  type AlembicRuntimeProjectIdentity,
} from '@alembic/core/daemon';

export const LOCAL_ALEMBIC_ROUTE: AlembicEnhancementRoute = 'local-alembic';
export const DAEMON_FILE_CHANGE_EVENT_SOURCES = ALEMBIC_FILE_MONITOR_EVENT_SOURCES;
export const DAEMON_JOB_KINDS = ALEMBIC_JOB_KINDS;

export type AlembicRuntimeRoute = AlembicEnhancementRoute;
export type DaemonFileChangeEventSource = (typeof ALEMBIC_FILE_MONITOR_EVENT_SOURCES)[number];
export type DaemonJobKind = (typeof ALEMBIC_JOB_KINDS)[number];
export type InternalAiCapability = AlembicInternalAiCapability;
export type RuntimeBoundaryWorkspaceMode = NonNullable<
  AlembicRuntimeProjectIdentity['workspaceMode']
>;

export interface RuntimeBoundaryWorkspace {
  databasePath: NonNullable<AlembicRuntimeProjectIdentity['databasePath']>;
  dataRoot: AlembicRuntimeProjectIdentity['dataRoot'];
  dataRootSource: AlembicRuntimeProjectIdentity['dataRootSource'];
  ghost: boolean;
  projectId: AlembicRuntimeProjectIdentity['projectId'];
  projectRoot: AlembicRuntimeProjectIdentity['projectRoot'];
  runtimeDir: AlembicRuntimeProjectIdentity['runtimeDir'];
  workspaceMode?: AlembicRuntimeProjectIdentity['workspaceMode'];
}

export interface AlembicRuntimeBoundaryOptions {
  capabilities: AlembicRuntimeCapabilities;
  dashboardUrl: string | null;
  mode: AlembicRuntimeMode;
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
    dataRootSource: AlembicRuntimeProjectIdentity['dataRootSource'];
    mode: RuntimeBoundaryWorkspaceMode;
    projectId: string | null;
    projectRoot: string;
    runtimeDir: string;
    workspaceMode: RuntimeBoundaryWorkspaceMode;
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
    endpoint: string | null;
    longLivedOwner: 'alembic-daemon';
    mode: AlembicRuntimeCapabilities['fileMonitor']['mode'];
  };
  internalAi: InternalAiCapability & {
    owner: 'alembic-internal-ai';
    runtimeOwner: 'AlembicAgent';
  };
  jobs: {
    kinds: DaemonJobKind[];
    owner: 'alembic';
    store: '@alembic/core/daemon/JobStore';
    endpoints: typeof ALEMBIC_JOB_ENDPOINTS;
  };
}

export function buildAlembicRuntimeBoundary(
  options: AlembicRuntimeBoundaryOptions
): AlembicRuntimeBoundary {
  const workspaceMode =
    options.workspace.workspaceMode ?? (options.workspace.ghost ? 'ghost' : 'standard');

  return {
    owner: 'alembic',
    route: LOCAL_ALEMBIC_ROUTE,
    workspace: {
      contract: '@alembic/core/workspace',
      databasePath: options.workspace.databasePath,
      dataRoot: options.workspace.dataRoot,
      dataRootSource: options.workspace.dataRootSource,
      mode: workspaceMode,
      projectId: options.workspace.projectId,
      projectRoot: options.workspace.projectRoot,
      runtimeDir: options.workspace.runtimeDir,
      workspaceMode,
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
      acceptedEventSources: [...options.capabilities.fileMonitor.acceptedEventSources],
      available: options.capabilities.fileMonitor.available,
      dispatcher: 'FileChangeDispatcher',
      endpoint: options.capabilities.fileMonitor.endpoint ?? ALEMBIC_FILE_CHANGES_PATH,
      longLivedOwner: 'alembic-daemon',
      mode: options.capabilities.fileMonitor.mode,
    },
    internalAi: {
      ...options.capabilities.internalAi,
      owner: 'alembic-internal-ai',
      runtimeOwner: 'AlembicAgent',
    },
    jobs: {
      kinds: [...options.capabilities.jobs.kinds],
      owner: 'alembic',
      store: '@alembic/core/daemon/JobStore',
      endpoints: { ...ALEMBIC_JOB_ENDPOINTS },
    },
  };
}
