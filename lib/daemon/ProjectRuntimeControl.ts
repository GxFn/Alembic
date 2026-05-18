import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { type DaemonJobStatus, resolveDaemonPaths } from '@alembic/core/daemon';
import { collectAiEnvOverrides, isAiEnvReady, WorkspaceSettingsStore } from '@alembic/core/shared';
import {
  getProjectRegistryDir,
  type ProjectEntry,
  ProjectRegistry,
  type WorkspaceFacts,
  WorkspaceResolver,
} from '@alembic/core/workspace';
import { type DaemonStatus, type DaemonStatusKind, DaemonSupervisor } from './DaemonSupervisor.js';

const STATE_SCHEMA_VERSION = 1;
const DEFAULT_JOB_STATUSES: DaemonJobStatus[] = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
];

export type ProjectConnectionState = DaemonStatusKind | 'missing' | 'unavailable';

export interface ProjectRuntimeTarget {
  projectId?: string;
  projectRoot?: string;
}

export interface ProjectRuntimeControlState {
  activeProjectId: string | null;
  activeProjectRoot: string | null;
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  selectedAt: string | null;
  selectedProjectId: string | null;
  selectedProjectRoot: string | null;
  updatedAt: string;
}

export interface ProjectRuntimeJobsSummary {
  active: number;
  byStatus: Partial<Record<DaemonJobStatus, number>>;
  jobsDir: string;
  latestJobId: string | null;
  latestUpdatedAt: string | null;
  total: number;
}

export interface ProjectRuntimeFileMonitorSummary {
  acceptedEventSources: string[];
  available: boolean;
  endpoint: string | null;
  mode: string;
}

export interface ProjectRuntimeInternalAiSummary {
  available: boolean;
  configSource: 'empty' | 'process-env' | 'workspace-settings' | 'unavailable';
  model: string | null;
  provider: string | null;
}

export interface ProjectRuntimeDaemonSummary {
  dashboardUrl: string | null;
  logPath: string;
  message: string | null;
  pid: number | null;
  pidAlive: boolean;
  ready: boolean;
  statePath: string;
  status: DaemonStatusKind | 'not-checked';
  url: string | null;
}

export interface ProjectRuntimeScopeSummary {
  cacheKey: string;
  daemon: ProjectRuntimeDaemonSummary;
  dashboardUrl: string | null;
  dataRoot: string;
  dataRootSource: WorkspaceFacts['dataRootSource'];
  databasePath: string;
  displayName: string;
  fileMonitor: ProjectRuntimeFileMonitorSummary;
  flags: {
    activeRuntime: boolean;
    missing: boolean;
    selected: boolean;
    stale: boolean;
    unavailable: boolean;
  };
  ghost: boolean;
  initializedBy: 'project-registry';
  internalAi: ProjectRuntimeInternalAiSummary;
  jobs: ProjectRuntimeJobsSummary;
  mode: WorkspaceFacts['mode'];
  projectExists: boolean;
  projectId: string | null;
  projectRealpath: string;
  projectRoot: string;
  registered: boolean;
  registry: {
    createdAt: string | null;
    id: string | null;
  };
  runtimeDir: string;
  scope: {
    controlPlaneOwner: 'alembic';
    daemonOwner: 'per-project-daemon';
    jobStoreOwner: '@alembic/core/daemon/JobStore';
    runtimeOwner: 'alembic';
  };
  status: ProjectConnectionState;
  workspaceExists: boolean;
}

export interface ProjectRuntimeControlSnapshot {
  activeRuntimeProject: ProjectRuntimeScopeSummary | null;
  generatedAt: string;
  projects: ProjectRuntimeScopeSummary[];
  selectedProject: ProjectRuntimeScopeSummary | null;
  state: ProjectRuntimeControlState;
}

interface BuildProjectSummaryOptions {
  entry: ProjectEntry | null;
  projectRoot: string;
  selectedProjectRoot?: string | null;
}

export function getProjectRuntimeControlStatePath(): string {
  return join(getProjectRegistryDir(), 'runtime-control.json');
}

export class ProjectRuntimeControl {
  readonly statePath: string;

  #supervisor: DaemonSupervisor;

  constructor(options: { statePath?: string; supervisor?: DaemonSupervisor } = {}) {
    this.statePath = options.statePath ?? getProjectRuntimeControlStatePath();
    this.#supervisor = options.supervisor ?? new DaemonSupervisor();
  }

  readState(): ProjectRuntimeControlState {
    try {
      const parsed = JSON.parse(
        readFileSync(this.statePath, 'utf8')
      ) as Partial<ProjectRuntimeControlState>;
      if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) {
        return emptyState();
      }
      return {
        activeProjectId: nullableString(parsed.activeProjectId),
        activeProjectRoot: nullableString(parsed.activeProjectRoot),
        schemaVersion: STATE_SCHEMA_VERSION,
        selectedAt: nullableString(parsed.selectedAt),
        selectedProjectId: nullableString(parsed.selectedProjectId),
        selectedProjectRoot: nullableString(parsed.selectedProjectRoot),
        updatedAt: nullableString(parsed.updatedAt) ?? new Date(0).toISOString(),
      };
    } catch {
      return emptyState();
    }
  }

  async listProjects(): Promise<ProjectRuntimeScopeSummary[]> {
    const state = this.readState();
    const projects = ProjectRegistry.list().sort((a, b) =>
      a.projectRoot.localeCompare(b.projectRoot)
    );
    return Promise.all(
      projects.map((project) =>
        this.buildProjectSummary({
          entry: project.entry,
          projectRoot: project.projectRoot,
          selectedProjectRoot: state.selectedProjectRoot,
        })
      )
    );
  }

  async inspectProject(target: ProjectRuntimeTarget): Promise<ProjectRuntimeScopeSummary> {
    const state = this.readState();
    const project = this.resolveTarget(target, { requireRegistered: false });
    return this.buildProjectSummary({
      entry: project.entry,
      projectRoot: project.projectRoot,
      selectedProjectRoot: state.selectedProjectRoot,
    });
  }

  async snapshot(): Promise<ProjectRuntimeControlSnapshot> {
    const projects = await this.listProjects();
    const state = this.withActiveProject(this.readState(), projects);
    const selectedProject =
      projects.find((project) => sameProjectRoot(project.projectRoot, state.selectedProjectRoot)) ??
      null;
    const activeRuntimeProject =
      selectedProject?.daemon.ready === true && selectedProject.flags.activeRuntime
        ? selectedProject
        : null;

    return {
      activeRuntimeProject,
      generatedAt: new Date().toISOString(),
      projects,
      selectedProject,
      state,
    };
  }

  async selectProject(target: ProjectRuntimeTarget): Promise<ProjectRuntimeControlSnapshot> {
    const project = this.resolveTarget(target, { requireRegistered: true });
    const now = new Date().toISOString();
    this.writeState({
      activeProjectId: null,
      activeProjectRoot: null,
      schemaVersion: STATE_SCHEMA_VERSION,
      selectedAt: now,
      selectedProjectId: project.entry?.id ?? null,
      selectedProjectRoot: project.projectRoot,
      updatedAt: now,
    });
    return this.snapshot();
  }

  async clearSelection(): Promise<ProjectRuntimeControlSnapshot> {
    this.writeState(emptyState(new Date().toISOString()));
    return this.snapshot();
  }

  async buildProjectSummary(
    options: BuildProjectSummaryOptions
  ): Promise<ProjectRuntimeScopeSummary> {
    const projectRoot = resolve(options.projectRoot);
    const inspection = ProjectRegistry.inspect(projectRoot);
    const resolver = WorkspaceResolver.fromProject(projectRoot);
    const facts = resolver.toFacts();
    const projectExists = existsSync(projectRoot);
    const selected = sameProjectRoot(projectRoot, options.selectedProjectRoot ?? null);
    const daemon = projectExists ? await this.safeDaemonStatus(projectRoot) : null;
    const status = projectExists ? (daemon?.status ?? 'unavailable') : 'missing';
    const healthData = asRecord(daemon?.health?.data);
    const dashboardUrl = firstString(healthData?.dashboardUrl, daemon?.state?.dashboardUrl);
    const activeRuntime = selected && daemon?.ready === true;

    return {
      cacheKey: `project:${facts.projectId ?? facts.expectedProjectId}`,
      daemon: summarizeDaemonStatus(daemon, facts),
      dashboardUrl,
      dataRoot: facts.dataRoot,
      dataRootSource: facts.dataRootSource,
      databasePath: facts.databasePath,
      displayName: basename(facts.targetProjectRoot),
      fileMonitor: summarizeFileMonitor(healthData),
      flags: {
        activeRuntime,
        missing: !projectExists,
        selected,
        stale: status === 'stale',
        unavailable: status === 'unavailable' || status === 'failed',
      },
      ghost: facts.ghost,
      initializedBy: 'project-registry',
      internalAi: summarizeInternalAi(projectRoot, healthData),
      jobs: summarizeJobs(resolveDaemonPaths(projectRoot).jobsDir),
      mode: facts.mode,
      projectExists,
      projectId: facts.projectId ?? options.entry?.id ?? inspection.projectId,
      projectRealpath: facts.projectRealpath,
      projectRoot: facts.targetProjectRoot,
      registered: options.entry !== null || inspection.registered,
      registry: {
        createdAt: options.entry?.createdAt ?? inspection.entry?.createdAt ?? null,
        id: options.entry?.id ?? inspection.projectId,
      },
      runtimeDir: facts.runtimeDir,
      scope: {
        controlPlaneOwner: 'alembic',
        daemonOwner: 'per-project-daemon',
        jobStoreOwner: '@alembic/core/daemon/JobStore',
        runtimeOwner: 'alembic',
      },
      status,
      workspaceExists: facts.workspaceExists,
    };
  }

  resolveTarget(
    target: ProjectRuntimeTarget,
    options: { requireRegistered: boolean }
  ): { entry: ProjectEntry | null; projectRoot: string } {
    if (target.projectId) {
      const match = ProjectRegistry.list().find(({ entry }) => entry.id === target.projectId);
      if (!match) {
        throw new Error(`Project is not registered: ${target.projectId}`);
      }
      return match;
    }

    if (!target.projectRoot) {
      throw new Error('Project target requires projectId or projectRoot');
    }

    const projectRoot = resolve(target.projectRoot);
    const entry = ProjectRegistry.get(projectRoot);
    if (options.requireRegistered && !entry) {
      throw new Error(`Project is not registered: ${projectRoot}`);
    }
    return { entry, projectRoot };
  }

  withActiveProject(
    state: ProjectRuntimeControlState,
    projects: ProjectRuntimeScopeSummary[]
  ): ProjectRuntimeControlState {
    const selectedProject =
      projects.find((project) => sameProjectRoot(project.projectRoot, state.selectedProjectRoot)) ??
      null;
    const activeProject =
      selectedProject?.daemon.ready === true && selectedProject.flags.activeRuntime
        ? selectedProject
        : null;
    return {
      ...state,
      activeProjectId: activeProject?.projectId ?? null,
      activeProjectRoot: activeProject?.projectRoot ?? null,
    };
  }

  async safeDaemonStatus(projectRoot: string): Promise<DaemonStatus | null> {
    try {
      return await this.#supervisor.status(projectRoot);
    } catch {
      return null;
    }
  }

  writeState(state: ProjectRuntimeControlState): void {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmpPath, this.statePath);
  }
}

function summarizeDaemonStatus(
  status: DaemonStatus | null,
  facts: WorkspaceFacts
): ProjectRuntimeDaemonSummary {
  return {
    dashboardUrl: firstString(status?.state?.dashboardUrl),
    logPath: status?.logPath ?? join(facts.runtimeDir, 'daemon.log'),
    message: status?.message ?? null,
    pid: status?.state?.pid ?? null,
    pidAlive: status?.pidAlive ?? false,
    ready: status?.ready ?? false,
    statePath: status?.statePath ?? join(facts.runtimeDir, 'daemon.json'),
    status: status?.status ?? 'not-checked',
    url: status?.state?.url ?? null,
  };
}

function summarizeFileMonitor(
  healthData: Record<string, unknown> | null
): ProjectRuntimeFileMonitorSummary {
  const capabilities = asRecord(healthData?.capabilities);
  const fileMonitor = asRecord(capabilities?.fileMonitor);
  return {
    acceptedEventSources: stringArray(fileMonitor?.acceptedEventSources),
    available: fileMonitor?.available === true,
    endpoint: firstString(fileMonitor?.endpoint),
    mode: firstString(fileMonitor?.mode) ?? 'disabled',
  };
}

function summarizeInternalAi(
  projectRoot: string,
  healthData: Record<string, unknown> | null
): ProjectRuntimeInternalAiSummary {
  const capabilities = asRecord(healthData?.capabilities);
  const internalAi = asRecord(capabilities?.internalAi);
  if (internalAi) {
    return {
      available: internalAi.available === true,
      configSource: normalizeInternalAiSource(internalAi.configSource),
      model: firstString(internalAi.model),
      provider: firstString(internalAi.provider),
    };
  }

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
    return { available: false, configSource: 'unavailable', model: null, provider: null };
  }
}

function summarizeJobs(jobsDir: string): ProjectRuntimeJobsSummary {
  const byStatus: Partial<Record<DaemonJobStatus, number>> = {};
  for (const status of DEFAULT_JOB_STATUSES) {
    byStatus[status] = 0;
  }
  if (!existsSync(jobsDir)) {
    return { active: 0, byStatus, jobsDir, latestJobId: null, latestUpdatedAt: null, total: 0 };
  }

  let latestJobId: string | null = null;
  let latestUpdatedAt: string | null = null;
  let total = 0;

  for (const name of readdirSync(jobsDir).filter((entry) => entry.endsWith('.json'))) {
    const job = readJob(join(jobsDir, name));
    if (!job) {
      continue;
    }
    total += 1;
    byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
    if (!latestUpdatedAt || job.updatedAt.localeCompare(latestUpdatedAt) > 0) {
      latestJobId = job.id;
      latestUpdatedAt = job.updatedAt;
    }
  }

  return {
    active: (byStatus.queued ?? 0) + (byStatus.running ?? 0),
    byStatus,
    jobsDir,
    latestJobId,
    latestUpdatedAt,
    total,
  };
}

function readJob(
  filePath: string
): { id: string; status: DaemonJobStatus; updatedAt: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const status = normalizeJobStatus(parsed.status);
    if (!status || typeof parsed.id !== 'string' || typeof parsed.updatedAt !== 'string') {
      return null;
    }
    return { id: parsed.id, status, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

function normalizeJobStatus(value: unknown): DaemonJobStatus | null {
  return typeof value === 'string' && DEFAULT_JOB_STATUSES.includes(value as DaemonJobStatus)
    ? (value as DaemonJobStatus)
    : null;
}

function normalizeInternalAiSource(
  value: unknown
): ProjectRuntimeInternalAiSummary['configSource'] {
  if (value === 'empty' || value === 'process-env' || value === 'workspace-settings') {
    return value;
  }
  return 'unavailable';
}

function emptyState(updatedAt = new Date(0).toISOString()): ProjectRuntimeControlState {
  return {
    activeProjectId: null,
    activeProjectRoot: null,
    schemaVersion: STATE_SCHEMA_VERSION,
    selectedAt: null,
    selectedProjectId: null,
    selectedProjectRoot: null,
    updatedAt,
  };
}

function sameProjectRoot(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  return typeof left === 'string' && typeof right === 'string' && resolve(left) === resolve(right);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
