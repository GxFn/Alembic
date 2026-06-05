import { resolve } from 'node:path';
import type {
  AlembicRuntimeCapabilities,
  AlembicRuntimeMode,
  AlembicRuntimeProjectIdentity,
  ProjectConnectionState,
  ProjectRuntimeControlState,
  ProjectRuntimeDaemonStatus,
  ProjectRuntimeScopeSummary,
} from '@alembic/core/daemon';

export const PROJECT_RUNTIME_SOURCE_OF_TRUTH_CONTRACT_VERSION = 1;

export type ProjectRuntimeSourceOfTruthRoute = 'daemon-health' | 'project-runtime-control';

export type ProjectRuntimeSourceOfTruthReason =
  | 'ready'
  | 'daemon-failed'
  | 'daemon-missing'
  | 'daemon-mode-required'
  | 'daemon-not-running'
  | 'daemon-stale'
  | 'daemon-starting'
  | 'project-missing'
  | 'runtime-control-active-stale'
  | 'runtime-control-selected-mismatch'
  | 'unavailable';

export interface ProjectRuntimeSourceOfTruthOperation {
  explicitRuntimeActionRequired: true;
  implicitRuntimeActionAllowed: false;
  mode: 'diagnostics-read';
  readOnly: true;
}

export interface ProjectRuntimeSourceOfTruthWritePolicy {
  activeStateWriteAllowed: false;
  daemonLifecycleWriteAllowed: false;
  jobStoreWriteAllowed: false;
  projectScopeRegistryWriteAllowed: false;
  selectedStateWriteAllowed: false;
  writeOwner: 'alembic';
}

export interface ProjectRuntimeExplicitActionSurface {
  daemonLifecycle: string[];
  projectScopeRegistry: string[];
  runtimeControl: string[];
}

export interface ProjectRuntimeCapabilitySnapshot {
  apiAiAvailable: boolean | null;
  dashboardAvailable: boolean | null;
  dashboardUrl: string | null;
  fileMonitorAvailable: boolean | null;
  fileMonitorMode: string | null;
  jobsAvailable: boolean | null;
  projectScopeAvailable: boolean | null;
}

export interface ProjectRuntimeProjectRef {
  activeRuntime: boolean;
  dataRoot: string | null;
  dataRootSource: string | null;
  projectId: string | null;
  projectRoot: string;
  projectScopeId: string | null;
  ready: boolean;
  selected: boolean;
  stale: boolean;
  status: ProjectConnectionState;
}

export interface ProjectRuntimeControlSource {
  activeMatchesCurrentProject: boolean;
  activeProject: ProjectRuntimeProjectRef | null;
  activeReadyProject: ProjectRuntimeProjectRef | null;
  activeStateTrusted: boolean;
  diagnostics: ProjectRuntimeControlDiagnostic[];
  projects: {
    missing: number;
    ready: number;
    stale: number;
    total: number;
    unavailable: number;
  };
  readOnly: true;
  selectedMatchesCurrentProject: boolean;
  selectedProject: ProjectRuntimeProjectRef | null;
  state: Pick<
    ProjectRuntimeControlState,
    | 'activeProjectId'
    | 'activeProjectRoot'
    | 'schemaVersion'
    | 'selectedAt'
    | 'selectedProjectId'
    | 'selectedProjectRoot'
    | 'updatedAt'
  >;
  stateCleanup: ProjectRuntimeControlStateCleanup;
  statePath: string;
}

export interface ProjectRuntimeReadiness {
  capabilities: ProjectRuntimeCapabilitySnapshot;
  daemon: {
    dashboardUrl: string | null;
    logPath: string | null;
    message: string | null;
    pidAlive: boolean | null;
    ready: boolean;
    statePath: string | null;
    status: ProjectRuntimeDaemonStatus | 'daemon-health-ready';
    url: string | null;
  };
  ready: boolean;
  reasonCode: ProjectRuntimeSourceOfTruthReason;
  stale: boolean;
  status: ProjectConnectionState;
}

export interface ProjectRuntimeFailureEnvelope {
  blockedFallbacks: string[];
  blockingCondition: string;
  diagnostics: ProjectRuntimeControlDiagnostic[];
  nextActions: string[];
  observedSource: 'alembic-source-of-truth';
  reasonCode: ProjectRuntimeSourceOfTruthReason;
  retryable: boolean;
}

export type ProjectRuntimeControlDiagnosticCode =
  | 'active-runtime-state-stale'
  | 'daemon-state-missing'
  | 'selected-active-mismatch'
  | 'selected-project-missing';

export type ProjectRuntimeControlDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface ProjectRuntimeControlDiagnostic {
  action: 'cleared-active-state' | 'explicit-runtime-action-required' | 'reported-read-only';
  code: ProjectRuntimeControlDiagnosticCode;
  message: string;
  projectId: string | null;
  projectRoot: string | null;
  reasonCode: ProjectRuntimeSourceOfTruthReason;
  severity: ProjectRuntimeControlDiagnosticSeverity;
  source: 'daemon-status' | 'runtime-control-state';
}

export interface ProjectRuntimeControlStateCleanup {
  activeState:
    | {
        cleaned: true;
        cleanedAt: string;
        message: string;
        previousProjectId: string | null;
        previousProjectRoot: string | null;
        reasonCode: ProjectRuntimeSourceOfTruthReason;
      }
    | {
        cleaned: false;
        message: string | null;
        previousProjectId: string | null;
        previousProjectRoot: string | null;
        reasonCode: ProjectRuntimeSourceOfTruthReason | null;
      };
}

export interface ProjectRuntimeRequiredService {
  kind: 'local-alembic-daemon' | 'project-runtime-control';
  owner: 'alembic';
  route: 'local-alembic-daemon' | 'project-runtime-control';
}

export interface ProjectRuntimeSourceOfTruth {
  contractVersion: typeof PROJECT_RUNTIME_SOURCE_OF_TRUTH_CONTRACT_VERSION;
  diagnostics: ProjectRuntimeControlDiagnostic[];
  explicitActions: ProjectRuntimeExplicitActionSurface;
  failure: ProjectRuntimeFailureEnvelope | null;
  generatedAt: string;
  operation: ProjectRuntimeSourceOfTruthOperation;
  owner: 'alembic';
  projectIdentity: AlembicRuntimeProjectIdentity | null;
  readiness: ProjectRuntimeReadiness;
  requiredService: ProjectRuntimeRequiredService;
  route: ProjectRuntimeSourceOfTruthRoute;
  runtimeControl: ProjectRuntimeControlSource;
  targetProject: ProjectRuntimeProjectRef | null;
  writePolicy: ProjectRuntimeSourceOfTruthWritePolicy;
}

export interface BuildDaemonRuntimeSourceOfTruthOptions {
  capabilities: AlembicRuntimeCapabilities;
  dashboardUrl: string | null;
  generatedAt?: string;
  mode: AlembicRuntimeMode;
  origin: string | null;
  projectIdentity: AlembicRuntimeProjectIdentity;
  runtimeControlState: ProjectRuntimeControlState;
  runtimeControlStatePath: string;
  statePath: string;
}

export interface BuildProjectRuntimeControlSourceOfTruthOptions {
  activeRuntimeProject: ProjectRuntimeScopeSummary | null;
  generatedAt?: string;
  diagnostics?: ProjectRuntimeControlDiagnostic[];
  projects: ProjectRuntimeScopeSummary[];
  selectedProject: ProjectRuntimeScopeSummary | null;
  state: ProjectRuntimeControlState;
  stateCleanup?: ProjectRuntimeControlStateCleanup;
  statePath: string;
}

const EXPLICIT_ACTIONS: ProjectRuntimeExplicitActionSurface = {
  daemonLifecycle: [
    'POST /api/v1/projects/:projectId/start',
    'POST /api/v1/projects/:projectId/stop',
    'POST /api/v1/projects/:projectId/switch',
    'POST /api/v1/projects/:projectId/open-dashboard',
  ],
  projectScopeRegistry: ['POST /api/v1/project-scope/folders'],
  runtimeControl: ['POST /api/v1/projects/select', 'DELETE /api/v1/projects/select'],
};

export function createReadOnlySourceOfTruthOperation(): ProjectRuntimeSourceOfTruthOperation {
  return {
    explicitRuntimeActionRequired: true,
    implicitRuntimeActionAllowed: false,
    mode: 'diagnostics-read',
    readOnly: true,
  };
}

export function createReadOnlyWritePolicy(): ProjectRuntimeSourceOfTruthWritePolicy {
  return {
    activeStateWriteAllowed: false,
    daemonLifecycleWriteAllowed: false,
    jobStoreWriteAllowed: false,
    projectScopeRegistryWriteAllowed: false,
    selectedStateWriteAllowed: false,
    writeOwner: 'alembic',
  };
}

export function buildDaemonProjectRuntimeSourceOfTruth(
  options: BuildDaemonRuntimeSourceOfTruthOptions
): ProjectRuntimeSourceOfTruth {
  const readiness = buildDaemonHealthReadiness(options);
  const targetProject = projectRefFromIdentity(options.projectIdentity, readiness.status);
  const diagnostics: ProjectRuntimeControlDiagnostic[] = [];
  const stateCleanup = emptyStateCleanup();

  return {
    contractVersion: PROJECT_RUNTIME_SOURCE_OF_TRUTH_CONTRACT_VERSION,
    diagnostics,
    explicitActions: cloneExplicitActions(),
    failure: failureFromReadiness(readiness, diagnostics),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    operation: createReadOnlySourceOfTruthOperation(),
    owner: 'alembic',
    projectIdentity: options.projectIdentity,
    readiness,
    requiredService: {
      kind: 'local-alembic-daemon',
      owner: 'alembic',
      route: 'local-alembic-daemon',
    },
    route: 'daemon-health',
    runtimeControl: buildRuntimeControlSource({
      activeRuntimeProject: null,
      currentProjectIdentity: options.projectIdentity,
      diagnostics,
      projects: [targetProject],
      selectedProject: null,
      state: options.runtimeControlState,
      stateCleanup,
      statePath: options.runtimeControlStatePath,
    }),
    targetProject,
    writePolicy: createReadOnlyWritePolicy(),
  };
}

export function buildProjectRuntimeControlSourceOfTruth(
  options: BuildProjectRuntimeControlSourceOfTruthOptions
): ProjectRuntimeSourceOfTruth {
  const diagnostics = options.diagnostics ?? [];
  const stateCleanup = options.stateCleanup ?? emptyStateCleanup();
  const targetProject = options.selectedProject ?? options.activeRuntimeProject;
  const readiness = buildProjectReadiness(targetProject, diagnostics);

  return {
    contractVersion: PROJECT_RUNTIME_SOURCE_OF_TRUTH_CONTRACT_VERSION,
    diagnostics,
    explicitActions: cloneExplicitActions(),
    failure: failureFromReadiness(readiness, diagnostics),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    operation: createReadOnlySourceOfTruthOperation(),
    owner: 'alembic',
    projectIdentity: null,
    readiness,
    requiredService: {
      kind: 'project-runtime-control',
      owner: 'alembic',
      route: 'project-runtime-control',
    },
    route: 'project-runtime-control',
    runtimeControl: buildRuntimeControlSource({
      activeRuntimeProject: options.activeRuntimeProject,
      diagnostics,
      projects: options.projects.map(projectRefFromSummary),
      selectedProject: options.selectedProject,
      state: options.state,
      stateCleanup,
      statePath: options.statePath,
    }),
    targetProject: targetProject ? projectRefFromSummary(targetProject) : null,
    writePolicy: createReadOnlyWritePolicy(),
  };
}

function buildDaemonHealthReadiness(
  options: BuildDaemonRuntimeSourceOfTruthOptions
): ProjectRuntimeReadiness {
  const ready = options.mode === 'daemon';
  const status: ProjectConnectionState = ready ? 'ready' : 'unavailable';
  const reasonCode: ProjectRuntimeSourceOfTruthReason = ready ? 'ready' : 'daemon-mode-required';
  return {
    capabilities: capabilitySnapshot(options.capabilities, options.dashboardUrl),
    daemon: {
      dashboardUrl: options.dashboardUrl,
      logPath: null,
      message: ready ? null : 'Alembic local daemon mode is required for resident service handoff.',
      pidAlive: null,
      ready,
      statePath: options.statePath,
      status: 'daemon-health-ready',
      url: options.origin,
    },
    ready,
    reasonCode,
    stale: false,
    status,
  };
}

function buildProjectReadiness(
  project: ProjectRuntimeScopeSummary | null,
  diagnostics: ProjectRuntimeControlDiagnostic[]
): ProjectRuntimeReadiness {
  const blockingDiagnostic = diagnostics.find((diagnostic) => diagnostic.severity === 'error');
  if (blockingDiagnostic) {
    return {
      capabilities: project ? capabilitySnapshotFromProject(project) : emptyCapabilities(),
      daemon: project
        ? daemonReadinessFromProject(project)
        : emptyDaemonReadiness(blockingDiagnostic),
      ready: false,
      reasonCode: blockingDiagnostic.reasonCode,
      stale:
        blockingDiagnostic.reasonCode === 'runtime-control-active-stale' ||
        blockingDiagnostic.reasonCode === 'runtime-control-selected-mismatch' ||
        blockingDiagnostic.reasonCode === 'daemon-stale',
      status:
        blockingDiagnostic.reasonCode === 'runtime-control-active-stale' ||
        blockingDiagnostic.reasonCode === 'runtime-control-selected-mismatch'
          ? 'stale'
          : (project?.status ?? 'unavailable'),
    };
  }

  if (!project) {
    return {
      capabilities: emptyCapabilities(),
      daemon: {
        dashboardUrl: null,
        logPath: null,
        message: 'No selected or active project runtime is available.',
        pidAlive: null,
        ready: false,
        statePath: null,
        status: 'not-checked',
        url: null,
      },
      ready: false,
      reasonCode: 'unavailable',
      stale: false,
      status: 'unavailable',
    };
  }

  const reasonCode = reasonFromProject(project);
  return {
    capabilities: capabilitySnapshotFromProject(project),
    daemon: daemonReadinessFromProject(project),
    ready: project.status === 'ready' && project.daemon.ready,
    reasonCode,
    stale: project.flags.stale || project.status === 'stale',
    status: project.status,
  };
}

function buildRuntimeControlSource(options: {
  activeRuntimeProject: ProjectRuntimeScopeSummary | null;
  currentProjectIdentity?: AlembicRuntimeProjectIdentity | null;
  diagnostics: ProjectRuntimeControlDiagnostic[];
  projects: ProjectRuntimeProjectRef[];
  selectedProject: ProjectRuntimeScopeSummary | null;
  state: ProjectRuntimeControlState;
  stateCleanup: ProjectRuntimeControlStateCleanup;
  statePath: string;
}): ProjectRuntimeControlSource {
  const currentRoot = options.currentProjectIdentity?.projectRoot ?? null;
  const currentProjectId = options.currentProjectIdentity?.projectId ?? null;
  const selectedProject = options.selectedProject
    ? projectRefFromSummary(options.selectedProject)
    : null;
  const activeReadyProject = options.activeRuntimeProject
    ? projectRefFromSummary(options.activeRuntimeProject)
    : null;
  const activeProject =
    activeReadyProject ??
    projectRefFromState(options.state.activeProjectId, options.state.activeProjectRoot);

  return {
    activeMatchesCurrentProject: matchesProject(
      options.state.activeProjectId,
      options.state.activeProjectRoot,
      currentProjectId,
      currentRoot
    ),
    activeProject,
    activeReadyProject,
    activeStateTrusted:
      activeReadyProject !== null &&
      matchesProject(
        options.state.activeProjectId,
        options.state.activeProjectRoot,
        activeReadyProject.projectId,
        activeReadyProject.projectRoot
      ),
    diagnostics: options.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    projects: countRuntimeProjects(options.projects),
    readOnly: true,
    selectedMatchesCurrentProject: matchesProject(
      options.state.selectedProjectId,
      options.state.selectedProjectRoot,
      currentProjectId,
      currentRoot
    ),
    selectedProject,
    state: {
      activeProjectId: options.state.activeProjectId,
      activeProjectRoot: options.state.activeProjectRoot,
      schemaVersion: options.state.schemaVersion,
      selectedAt: options.state.selectedAt,
      selectedProjectId: options.state.selectedProjectId,
      selectedProjectRoot: options.state.selectedProjectRoot,
      updatedAt: options.state.updatedAt,
    },
    stateCleanup: cloneStateCleanup(options.stateCleanup),
    statePath: options.statePath,
  };
}

function failureFromReadiness(
  readiness: ProjectRuntimeReadiness,
  diagnostics: ProjectRuntimeControlDiagnostic[]
): ProjectRuntimeFailureEnvelope | null {
  if (readiness.ready) {
    return null;
  }
  const matchingDiagnostic =
    diagnostics.find((diagnostic) => diagnostic.reasonCode === readiness.reasonCode) ??
    diagnostics.find((diagnostic) => diagnostic.severity === 'error') ??
    null;

  return {
    blockedFallbacks: ['plugin-selected-root-fallback', 'implicit-runtime-control-write'],
    blockingCondition:
      matchingDiagnostic?.message ?? readiness.daemon.message ?? readiness.reasonCode,
    diagnostics: diagnostics.map((diagnostic) => ({ ...diagnostic })),
    nextActions: nextActionsForReason(readiness.reasonCode),
    observedSource: 'alembic-source-of-truth',
    reasonCode: readiness.reasonCode,
    retryable: !['project-missing', 'runtime-control-selected-mismatch'].includes(
      readiness.reasonCode
    ),
  };
}

function nextActionsForReason(reason: ProjectRuntimeSourceOfTruthReason): string[] {
  switch (reason) {
    case 'daemon-mode-required':
      return ['Start the Alembic daemon for this exact project identity before resident handoff.'];
    case 'daemon-missing':
      return ['Run an explicit runtime start action so Alembic can create daemon state.'];
    case 'daemon-not-running':
      return ['Run an explicit runtime start action for the selected project.'];
    case 'daemon-stale':
      return ['Restart the Alembic daemon through an explicit runtime action.'];
    case 'daemon-starting':
      return ['Poll readiness until the daemon reaches ready or failed.'];
    case 'daemon-failed':
      return ['Inspect daemon logs and retry through an explicit runtime action.'];
    case 'project-missing':
      return ['Re-register or remove the missing project from Alembic project runtime control.'];
    case 'runtime-control-active-stale':
      return [
        'Alembic cleared stale active runtime state; start or switch explicitly before handoff.',
      ];
    case 'runtime-control-selected-mismatch':
      return [
        'Use an explicit switch/start action for the selected project, or clear and reselect runtime control.',
      ];
    case 'unavailable':
      return ['Select a project or start an explicit runtime action before handoff.'];
    case 'ready':
      return [];
  }
}

function reasonFromProject(project: ProjectRuntimeScopeSummary): ProjectRuntimeSourceOfTruthReason {
  if (project.status === 'ready' && project.daemon.ready) {
    return 'ready';
  }
  if (project.status === 'missing') {
    return 'project-missing';
  }
  if (project.status === 'stale') {
    return 'daemon-stale';
  }
  if (project.status === 'starting') {
    return 'daemon-starting';
  }
  if (project.status === 'failed') {
    return 'daemon-failed';
  }
  if (project.status === 'stopped') {
    return project.daemon.status === 'not-checked' || project.daemon.statePath.length > 0
      ? 'daemon-not-running'
      : 'daemon-missing';
  }
  return 'unavailable';
}

function projectRefFromIdentity(
  identity: AlembicRuntimeProjectIdentity,
  status: ProjectConnectionState
): ProjectRuntimeProjectRef {
  const ready = status === 'ready';
  return {
    activeRuntime: ready,
    dataRoot: identity.dataRoot,
    dataRootSource: identity.dataRootSource,
    projectId: identity.projectId,
    projectRoot: identity.projectRoot,
    projectScopeId: identity.projectScopeId ?? identity.projectScope?.projectScopeId ?? null,
    ready,
    selected: false,
    stale: status === 'stale',
    status,
  };
}

function projectRefFromSummary(project: ProjectRuntimeScopeSummary): ProjectRuntimeProjectRef {
  return {
    activeRuntime: project.flags.activeRuntime,
    dataRoot: project.dataRoot,
    dataRootSource: project.dataRootSource,
    projectId: project.projectId,
    projectRoot: project.projectRoot,
    projectScopeId: project.projectScopeId ?? project.projectScope?.projectScopeId ?? null,
    ready: project.daemon.ready,
    selected: project.flags.selected,
    stale: project.flags.stale,
    status: project.status,
  };
}

function projectRefFromState(
  projectId: string | null,
  projectRoot: string | null
): ProjectRuntimeProjectRef | null {
  if (!projectRoot) {
    return null;
  }
  return {
    activeRuntime: false,
    dataRoot: null,
    dataRootSource: null,
    projectId,
    projectRoot,
    projectScopeId: null,
    ready: false,
    selected: false,
    stale: true,
    status: 'stale',
  };
}

function matchesProject(
  leftProjectId: string | null,
  leftProjectRoot: string | null,
  rightProjectId: string | null,
  rightProjectRoot: string | null
): boolean {
  if (leftProjectId && rightProjectId && leftProjectId === rightProjectId) {
    return true;
  }
  if (!leftProjectRoot || !rightProjectRoot) {
    return false;
  }
  return resolve(leftProjectRoot) === resolve(rightProjectRoot);
}

function capabilitySnapshot(
  capabilities: AlembicRuntimeCapabilities,
  dashboardUrl: string | null
): ProjectRuntimeCapabilitySnapshot {
  return {
    apiAiAvailable: capabilities.apiAi.available,
    dashboardAvailable: capabilities.dashboard.available,
    dashboardUrl: capabilities.dashboard.url ?? dashboardUrl,
    fileMonitorAvailable: capabilities.fileMonitor.available,
    fileMonitorMode: capabilities.fileMonitor.mode,
    jobsAvailable: capabilities.jobs.available,
    projectScopeAvailable: capabilities.projectScope.available,
  };
}

function capabilitySnapshotFromProject(
  project: ProjectRuntimeScopeSummary
): ProjectRuntimeCapabilitySnapshot {
  return {
    apiAiAvailable: project.apiAi.available,
    dashboardAvailable: Boolean(project.dashboardUrl),
    dashboardUrl: project.dashboardUrl,
    fileMonitorAvailable: project.fileMonitor.available,
    fileMonitorMode: project.fileMonitor.mode,
    jobsAvailable: project.jobs.total >= 0,
    projectScopeAvailable: Boolean(project.projectScopeId || project.projectScope),
  };
}

function emptyCapabilities(): ProjectRuntimeCapabilitySnapshot {
  return {
    apiAiAvailable: null,
    dashboardAvailable: null,
    dashboardUrl: null,
    fileMonitorAvailable: null,
    fileMonitorMode: null,
    jobsAvailable: null,
    projectScopeAvailable: null,
  };
}

function daemonReadinessFromProject(
  project: ProjectRuntimeScopeSummary
): ProjectRuntimeReadiness['daemon'] {
  return {
    dashboardUrl: project.daemon.dashboardUrl,
    logPath: project.daemon.logPath,
    message: project.daemon.message,
    pidAlive: project.daemon.pidAlive,
    ready: project.daemon.ready,
    statePath: project.daemon.statePath,
    status: project.daemon.status,
    url: project.daemon.url,
  };
}

function emptyDaemonReadiness(
  diagnostic: ProjectRuntimeControlDiagnostic
): ProjectRuntimeReadiness['daemon'] {
  return {
    dashboardUrl: null,
    logPath: null,
    message: diagnostic.message,
    pidAlive: null,
    ready: false,
    statePath: null,
    status: 'not-checked',
    url: null,
  };
}

function emptyStateCleanup(): ProjectRuntimeControlStateCleanup {
  return {
    activeState: {
      cleaned: false,
      message: null,
      previousProjectId: null,
      previousProjectRoot: null,
      reasonCode: null,
    },
  };
}

function cloneStateCleanup(
  cleanup: ProjectRuntimeControlStateCleanup
): ProjectRuntimeControlStateCleanup {
  return cleanup.activeState.cleaned
    ? {
        activeState: {
          cleaned: true,
          cleanedAt: cleanup.activeState.cleanedAt,
          message: cleanup.activeState.message,
          previousProjectId: cleanup.activeState.previousProjectId,
          previousProjectRoot: cleanup.activeState.previousProjectRoot,
          reasonCode: cleanup.activeState.reasonCode,
        },
      }
    : {
        activeState: {
          cleaned: false,
          message: cleanup.activeState.message,
          previousProjectId: cleanup.activeState.previousProjectId,
          previousProjectRoot: cleanup.activeState.previousProjectRoot,
          reasonCode: cleanup.activeState.reasonCode,
        },
      };
}

function countRuntimeProjects(
  projects: ProjectRuntimeProjectRef[]
): ProjectRuntimeControlSource['projects'] {
  return {
    missing: projects.filter((project) => project.status === 'missing').length,
    ready: projects.filter((project) => project.status === 'ready').length,
    stale: projects.filter((project) => project.stale || project.status === 'stale').length,
    total: projects.length,
    unavailable: projects.filter(
      (project) => project.status === 'unavailable' || project.status === 'failed'
    ).length,
  };
}

function cloneExplicitActions(): ProjectRuntimeExplicitActionSurface {
  return {
    daemonLifecycle: [...EXPLICIT_ACTIONS.daemonLifecycle],
    projectScopeRegistry: [...EXPLICIT_ACTIONS.projectScopeRegistry],
    runtimeControl: [...EXPLICIT_ACTIONS.runtimeControl],
  };
}
