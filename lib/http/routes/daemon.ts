import {
  ALEMBIC_JOB_PROCESS_EVENTS_PATH,
  type AlembicApiAiCapability,
  type AlembicResidentCapabilityOverrides,
  type AlembicResidentServiceStatus,
  type AlembicRuntimeCapabilities,
  type AlembicRuntimeProjectIdentity,
  createAlembicResidentServiceStatus,
  createAlembicRuntimeCapabilities,
  createAlembicRuntimeHealthData,
  createAlembicRuntimeProjectIdentity,
  getPackageVersion,
} from '@alembic/core/daemon';
import { collectAiEnvOverrides, isAiEnvReady, WorkspaceSettingsStore } from '@alembic/core/shared';
import { resolveProjectRoot } from '@alembic/core/workspace';
import express, { type Request } from 'express';
import {
  createDisabledFileMonitorStatus,
  createGitFallbackFileMonitorStatus,
  createStartingFileMonitorStatus,
  createUnsupportedFileMonitorStatus,
  type DaemonFileMonitorActiveEventSource,
  type DaemonFileMonitorRuntimeState,
  type DaemonFileMonitorRuntimeStatus,
  isFileMonitorRuntimeAvailable,
} from '../../daemon/FileMonitorStatus.js';
import { ProjectRuntimeControl } from '../../daemon/ProjectRuntimeControl.js';
import { buildDaemonProjectRuntimeSourceOfTruth } from '../../daemon/ProjectRuntimeSourceOfTruth.js';
import { buildAlembicRuntimeBoundary } from '../../daemon/RuntimeBoundary.js';
import { readLatestSchemaMigrationVersion } from '../../infrastructure/database/SqliteDatabaseAccess.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { resolveAlembicWorkspace } from '../../project-scope/ProjectScopeRegistry.js';
import { buildIntentEpisodeCapability } from './intent-episodes.js';

const router = express.Router();
const API_PREFIX = '/api/v1';

export interface ResidentSearchCapability {
  available: boolean;
  endpoint: string;
  modes: Array<'keyword' | 'bm25' | 'semantic'>;
  owner: 'alembic';
  route: 'resident-search';
  telemetry: {
    exposesActualMode: boolean;
    exposesDegradedReason: boolean;
    exposesDurationMs: boolean;
    exposesVectorStats: boolean;
    exposesWorkspaceIdentity: boolean;
  };
}

type RuntimeFileMonitorCapability = AlembicRuntimeCapabilities['fileMonitor'] & {
  activeEventSource: DaemonFileMonitorActiveEventSource;
  degraded: boolean;
  degradedReason: string | null;
  fallback: DaemonFileMonitorRuntimeStatus['fallback'];
  lastDispatchAt: string | null;
  lastError: string | null;
  lastScanAt: string | null;
  nativeWatcher: DaemonFileMonitorRuntimeStatus['nativeWatcher'];
  producerKind: DaemonFileMonitorRuntimeStatus['producerKind'];
  runtimeState: DaemonFileMonitorRuntimeState;
  status: DaemonFileMonitorRuntimeState;
};

export type DaemonCapabilities = AlembicRuntimeCapabilities & {
  apiAi: AlembicApiAiCapability;
};

router.get('/health', (req, res) => {
  const container = getServiceContainer();
  const projectRoot = resolveProjectRoot(container);
  const resolver = resolveAlembicWorkspace(projectRoot);
  const workspaceFacts = resolver.toFacts();
  const mode = process.env.ALEMBIC_DAEMON_MODE === '1' ? 'daemon' : 'api';
  const origin = buildRequestOrigin(req);
  const dashboardAvailable =
    mode === 'daemon' && process.env.ALEMBIC_DAEMON_DASHBOARD_MOUNTED === '1';
  const dashboardUrl = dashboardAvailable && origin ? origin : null;
  const schemaMigrationVersion = getSchemaMigrationVersion(container);
  const projectIdentity = buildDaemonProjectIdentity({
    dataRoot: resolver.dataRoot,
    dataRootSource: workspaceFacts.dataRootSource,
    databasePath: resolver.databasePath,
    projectId: resolver.projectId,
    projectScope: workspaceFacts.projectScope,
    projectScopeId: workspaceFacts.projectScopeId,
    projectRoot: resolver.projectRoot,
    runtimeDir: resolver.runtimeDir,
    schemaMigrationVersion,
    workspaceMode: workspaceFacts.mode,
  });
  const apiAi = getApiAiCapability(projectRoot);
  const fileMonitorStatus = resolveDaemonFileMonitorRuntimeStatus({ container, mode });
  const capabilities = buildDaemonCapabilities({
    apiAi,
    dashboardAvailable,
    dashboardUrl,
    fileMonitorStatus,
    origin,
  });
  const runtimeBoundary = buildAlembicRuntimeBoundary({
    capabilities,
    dashboardUrl,
    mode,
    origin,
    workspace: {
      ...projectIdentity,
      databasePath: projectIdentity.databasePath ?? resolver.databasePath,
      ghost: resolver.ghost,
    },
  });
  const residentService = buildResidentServiceStatus({
    apiAi,
    capabilities,
    origin,
    projectIdentity,
    statePath: `${resolver.runtimeDir}/daemon.json`,
  });
  const runtimeControl = new ProjectRuntimeControl();
  const projectRuntimeSourceOfTruth = buildDaemonProjectRuntimeSourceOfTruth({
    capabilities,
    dashboardUrl,
    mode,
    origin,
    projectIdentity,
    runtimeControlState: runtimeControl.readState(),
    runtimeControlStatePath: runtimeControl.statePath,
    statePath: `${resolver.runtimeDir}/daemon.json`,
  });
  const healthData = createAlembicRuntimeHealthData({
    capabilities,
    dashboardUrl,
    mode,
    pid: process.pid,
    ...projectIdentity,
    uptime: process.uptime(),
    version: getPackageVersion(),
  });

  res.json({
    success: true,
    data: {
      ...healthData,
      projectRuntimeSourceOfTruth,
      residentService,
      runtimeBoundary,
      capabilities: {
        ...healthData.capabilities,
        intentEpisodes: buildIntentEpisodeCapability(),
        residentSearch: buildResidentSearchCapability(),
        runtimeBoundary,
      },
    },
  });
});

export type DaemonProjectIdentityOptions = AlembicRuntimeProjectIdentity;

export function buildDaemonProjectIdentity(
  options: DaemonProjectIdentityOptions
): AlembicRuntimeProjectIdentity {
  return createAlembicRuntimeProjectIdentity(options);
}

export interface DaemonCapabilitiesOptions {
  apiAi: AlembicApiAiCapability;
  dashboardAvailable: boolean;
  dashboardUrl: string | null;
  fileMonitorAvailable?: boolean;
  fileMonitorStatus?: DaemonFileMonitorRuntimeStatus;
  origin: string | null;
}

export interface ResidentServiceStatusOptions {
  apiAi: AlembicApiAiCapability;
  capabilities: DaemonCapabilities;
  origin: string | null;
  projectIdentity: AlembicRuntimeProjectIdentity;
  statePath?: string | null;
}

export function buildDaemonCapabilities(options: DaemonCapabilitiesOptions): DaemonCapabilities {
  const fileMonitorStatus =
    options.fileMonitorStatus ??
    buildLegacyFileMonitorStatus(options.fileMonitorAvailable === true);
  const fileMonitorAvailable = isFileMonitorRuntimeAvailable(fileMonitorStatus);
  const capabilities = createAlembicRuntimeCapabilities({
    apiBaseUrl: options.origin,
    apiAi: options.apiAi,
    dashboardAvailable: options.dashboardAvailable,
    dashboardUrl: options.dashboardUrl,
    fileMonitorAvailable,
    fileMonitorEndpoint: `${API_PREFIX}/file-changes`,
    fileMonitorMode: fileMonitorAvailable ? resolveFileMonitorMode(fileMonitorStatus) : 'disabled',
    jobProcessEvents: {
      available: true,
      endpoint: ALEMBIC_JOB_PROCESS_EVENTS_PATH,
    },
    projectScope: {
      available: true,
    },
  });

  return {
    ...capabilities,
    apiAi: options.apiAi,
    fileMonitor: {
      ...capabilities.fileMonitor,
      activeEventSource: fileMonitorStatus.activeEventSource,
      degraded: fileMonitorStatus.state === 'degraded',
      degradedReason: fileMonitorStatus.degradedReason,
      fallback: fileMonitorStatus.fallback,
      lastDispatchAt: fileMonitorStatus.lastDispatchAt,
      lastError: fileMonitorStatus.lastError,
      lastScanAt: fileMonitorStatus.lastScanAt,
      nativeWatcher: fileMonitorStatus.nativeWatcher,
      producerKind: fileMonitorStatus.producerKind,
      runtimeState: fileMonitorStatus.state,
      status: fileMonitorStatus.state,
    } satisfies RuntimeFileMonitorCapability,
  } as DaemonCapabilities;
}

export function buildResidentServiceStatus(
  options: ResidentServiceStatusOptions
): AlembicResidentServiceStatus {
  const fileMonitor = options.capabilities.fileMonitor as RuntimeFileMonitorCapability;
  const capabilityOverrides: AlembicResidentCapabilityOverrides = {
    'dashboard.handoff': {
      available: options.capabilities.dashboard.available,
      message: options.capabilities.dashboard.available
        ? 'Alembic Dashboard handoff is available from the local daemon.'
        : 'Alembic Dashboard is not mounted on this daemon.',
    },
    'file-monitor.git-worktree': {
      available:
        fileMonitor.available &&
        fileMonitor.mode === 'daemon-git-worktree' &&
        fileMonitor.activeEventSource === 'git-worktree',
      message: buildFileMonitorCapabilityMessage(fileMonitor),
    },
    'jobs.api-ai.bootstrap': {
      available:
        options.capabilities.jobs.available &&
        options.capabilities.jobs.kinds.includes('bootstrap'),
      message: buildApiAiJobMessage('bootstrap', options.apiAi),
    },
    'jobs.api-ai.rescan': {
      available:
        options.capabilities.jobs.available && options.capabilities.jobs.kinds.includes('rescan'),
      message: buildApiAiJobMessage('rescan', options.apiAi),
    },
    'search.keyword': {
      available: true,
      message: 'Alembic resident search supports keyword and BM25-compatible modes.',
    },
    'search.semantic': {
      available: true,
      message: 'Alembic resident search reports semantic/vector telemetry from /api/v1/search.',
    },
    'status.health': {
      available: true,
      message: 'Alembic daemon health endpoint is available.',
    },
  };

  return createAlembicResidentServiceStatus({
    apiBaseUrl: options.origin,
    capabilityOverrides,
    owner: 'alembic',
    route: 'local-alembic-daemon',
    serviceScope: {
      diagnosticPaths: {
        controlRoot: options.projectIdentity.projectScope?.controlRoot ?? null,
        databasePath: options.projectIdentity.databasePath ?? null,
        dataRoot: options.projectIdentity.dataRoot,
        projectRoot: options.projectIdentity.projectRoot,
        runtimeDir: options.projectIdentity.runtimeDir,
        statePath: options.statePath ?? null,
      },
      displayName:
        options.projectIdentity.projectScope?.displayName ??
        options.projectIdentity.projectId ??
        'Alembic current service scope',
      kind: 'current-project',
      // projectIdentity 只携带非路径身份摘要；路径只作为 diagnosticPaths 给排障使用。
      projectIdentity: {
        dataRootSource: options.projectIdentity.dataRootSource,
        projectId: options.projectIdentity.projectId,
        projectScope: options.projectIdentity.projectScope ?? null,
        projectScopeId: options.projectIdentity.projectScopeId ?? null,
        schemaMigrationVersion: options.projectIdentity.schemaMigrationVersion ?? null,
        workspaceMode: options.projectIdentity.workspaceMode ?? null,
      },
      scopeId: buildResidentServiceScopeId(options.projectIdentity),
    },
  });
}

export function resolveDaemonFileMonitorRuntimeStatus(options: {
  container: ReturnType<typeof getServiceContainer>;
  mode: 'api' | 'daemon';
}): DaemonFileMonitorRuntimeStatus {
  if (process.env.ALEMBIC_DAEMON_FILE_CHANGES === '0') {
    return createDisabledFileMonitorStatus('disabled-by-env');
  }
  if (options.mode !== 'daemon') {
    return createUnsupportedFileMonitorStatus('daemon-mode-required');
  }

  const singletons = (options.container as { singletons?: Record<string, unknown> | undefined })
    .singletons;
  const collector = singletons?.daemonFileChangeCollector;
  if (hasFileMonitorStatus(collector)) {
    return collector.getStatus();
  }
  const status = singletons?.daemonFileChangeCollectorStatus;
  if (isDaemonFileMonitorRuntimeStatus(status)) {
    return status;
  }
  return createStartingFileMonitorStatus('collector-status-unavailable');
}

export function buildResidentSearchCapability(): ResidentSearchCapability {
  return {
    available: true,
    endpoint: `${API_PREFIX}/search`,
    modes: ['keyword', 'bm25', 'semantic'],
    owner: 'alembic',
    route: 'resident-search',
    telemetry: {
      exposesActualMode: true,
      exposesDegradedReason: true,
      exposesDurationMs: true,
      exposesVectorStats: true,
      exposesWorkspaceIdentity: true,
    },
  };
}

function buildResidentServiceScopeId(identity: AlembicRuntimeProjectIdentity): string {
  if (identity.projectScopeId) {
    return `project-scope:${identity.projectScopeId}`;
  }
  if (identity.projectId) {
    return `project:${identity.projectId}`;
  }
  const workspaceMode = identity.workspaceMode ?? 'standard';
  return `workspace:${workspaceMode}:${identity.dataRootSource}`;
}

function buildApiAiJobMessage(
  operation: 'bootstrap' | 'rescan',
  apiAi: AlembicApiAiCapability
): string {
  if (apiAi.available) {
    return `Alembic local daemon can enqueue API AI ${operation} jobs.`;
  }
  return `Alembic local daemon exposes API AI ${operation} job routes; provider config is ${apiAi.configSource}.`;
}

function buildLegacyFileMonitorStatus(available: boolean): DaemonFileMonitorRuntimeStatus {
  return available
    ? createGitFallbackFileMonitorStatus({ intervalMs: null })
    : createDisabledFileMonitorStatus('file-monitor-unavailable');
}

function buildFileMonitorCapabilityMessage(fileMonitor: RuntimeFileMonitorCapability): string {
  if (fileMonitor.activeEventSource === 'native-watch' && fileMonitor.status === 'running') {
    return 'Alembic daemon native file monitor is running; git worktree fallback is inactive.';
  }
  if (fileMonitor.available) {
    return `Alembic daemon file monitor is ${fileMonitor.status} via ${fileMonitor.activeEventSource} mode.`;
  }
  if (fileMonitor.lastError) {
    return `Alembic daemon file monitor is ${fileMonitor.status}: ${fileMonitor.lastError}`;
  }
  return `Alembic daemon file monitor is ${fileMonitor.status}.`;
}

function resolveFileMonitorMode(
  status: DaemonFileMonitorRuntimeStatus
): AlembicRuntimeCapabilities['fileMonitor']['mode'] {
  if (status.activeEventSource === 'native-watch') {
    return 'host-event-bridge';
  }
  if (status.activeEventSource === 'git-worktree') {
    return 'daemon-git-worktree';
  }
  return 'disabled';
}

function hasFileMonitorStatus(
  value: unknown
): value is { getStatus(): DaemonFileMonitorRuntimeStatus } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getStatus?: unknown }).getStatus === 'function'
  );
}

function isDaemonFileMonitorRuntimeStatus(value: unknown): value is DaemonFileMonitorRuntimeStatus {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DaemonFileMonitorRuntimeStatus).state === 'string' &&
    (value as DaemonFileMonitorRuntimeStatus).producerKind === 'alembic-file-monitor'
  );
}

function getApiAiCapability(projectRoot: string): AlembicApiAiCapability {
  try {
    const settingsConfig = WorkspaceSettingsStore.fromProject(projectRoot).readAiConfig();
    const processConfig = collectAiEnvOverrides(settingsConfig.env, process.env);
    const rawVars = {
      ...settingsConfig.env,
      ...processConfig,
    };
    const hasSettings = settingsConfig.hasSettingsFile || settingsConfig.hasSecretsFile;
    const hasProcessConfig = Object.keys(processConfig).length > 0;
    return {
      available: isAiEnvReady(rawVars),
      configSource: hasProcessConfig ? 'process-env' : hasSettings ? 'workspace-settings' : 'empty',
      model: rawVars.ALEMBIC_AI_MODEL || null,
      provider: rawVars.ALEMBIC_AI_PROVIDER || null,
    };
  } catch {
    return { available: false, configSource: 'empty', model: null, provider: null };
  }
}

function buildRequestOrigin(req: Request): string | null {
  const host = req.get('host');
  if (!host) {
    return null;
  }
  const protocol = typeof req.protocol === 'string' && req.protocol ? req.protocol : 'http';
  return `${protocol}://${host}`;
}

function getSchemaMigrationVersion(
  container: ReturnType<typeof getServiceContainer>
): string | null {
  return readLatestSchemaMigrationVersion(container.get('database'));
}

export default router;
