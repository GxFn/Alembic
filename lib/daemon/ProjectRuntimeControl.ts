import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  type ProjectRuntimeControlSnapshot as CoreProjectRuntimeControlSnapshot,
  type ProjectRuntimeScopeSummary as CoreProjectRuntimeScopeSummary,
  createProjectRuntimeControlState,
  type DaemonJobStatus,
  isProjectRuntimeTarget,
  PROJECT_RUNTIME_CONTROL_STATE_SCHEMA_VERSION,
  type ProjectConnectionState,
  type ProjectRuntimeApiAiSummary,
  type ProjectRuntimeControlState,
  type ProjectRuntimeDaemonSummary,
  type ProjectRuntimeFileMonitorSummary,
  type ProjectRuntimeJobsSummary,
  type ProjectRuntimeTarget,
} from '@alembic/core/daemon';
import { collectAiEnvOverrides, isAiEnvReady, WorkspaceSettingsStore } from '@alembic/core/shared';
import {
  getProjectRegistryDir,
  type ProjectEntry,
  ProjectRegistry,
  type WorkspaceFacts,
} from '@alembic/core/workspace';
import {
  ProjectScopeRegistryStore,
  resolveAlembicDaemonPaths,
  resolveAlembicWorkspace,
} from '../project-scope/ProjectScopeRegistry.js';
import { type DaemonStatus, DaemonSupervisor } from './DaemonSupervisor.js';
import {
  buildProjectRuntimeControlSourceOfTruth,
  type ProjectRuntimeSourceOfTruth,
} from './ProjectRuntimeSourceOfTruth.js';

export type {
  ProjectConnectionState,
  ProjectRuntimeControlState,
  ProjectRuntimeDaemonSummary,
  ProjectRuntimeFileMonitorSummary,
  ProjectRuntimeJobsSummary,
  ProjectRuntimeTarget,
} from '@alembic/core/daemon';

export type ProjectRuntimeScopeSummary = CoreProjectRuntimeScopeSummary;
export type ProjectRuntimeControlSnapshot = Omit<
  CoreProjectRuntimeControlSnapshot,
  'activeRuntimeProject' | 'projects' | 'selectedProject'
> & {
  activeRuntimeProject: ProjectRuntimeScopeSummary | null;
  projects: ProjectRuntimeScopeSummary[];
  selectedProject: ProjectRuntimeScopeSummary | null;
  sourceOfTruth: ProjectRuntimeSourceOfTruth;
};

const DEFAULT_JOB_STATUSES: DaemonJobStatus[] = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
];

interface BuildProjectSummaryOptions {
  activeProjectRoot?: string | null;
  entry: ProjectEntry | null;
  projectRoot: string;
  selectedProjectRoot?: string | null;
}

export interface ProjectRuntimeControlOptions {
  deferSelfDaemonStop?: boolean;
  restart?: boolean;
  stopWaitMs?: number;
  waitUntilReadyMs?: number;
}

export interface ProjectRuntimeHandoff {
  apiBaseUrl: string | null;
  dashboardUrl: string | null;
  projectId: string | null;
  projectRoot: string;
  status: ProjectConnectionState;
}

export interface ProjectRuntimeControlActionResult {
  action: 'start' | 'stop' | 'open-dashboard' | 'switch';
  error: string | null;
  deferredStopProject: ProjectRuntimeScopeSummary | null;
  handoff: ProjectRuntimeHandoff | null;
  ok: boolean;
  previousActiveProject: ProjectRuntimeScopeSummary | null;
  snapshot: ProjectRuntimeControlSnapshot;
  stoppedProject: ProjectRuntimeScopeSummary | null;
  targetProject: ProjectRuntimeScopeSummary | null;
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
      if (parsed.schemaVersion !== PROJECT_RUNTIME_CONTROL_STATE_SCHEMA_VERSION) {
        return emptyState();
      }
      return createProjectRuntimeControlState({
        activeProjectId: nullableString(parsed.activeProjectId),
        activeProjectRoot: nullableString(parsed.activeProjectRoot),
        selectedAt: nullableString(parsed.selectedAt),
        selectedProjectId: nullableString(parsed.selectedProjectId),
        selectedProjectRoot: nullableString(parsed.selectedProjectRoot),
        updatedAt: nullableString(parsed.updatedAt) ?? new Date(0).toISOString(),
      });
    } catch {
      return emptyState();
    }
  }

  async listProjects(): Promise<ProjectRuntimeScopeSummary[]> {
    const state = this.readState();
    const projects = collectRuntimeProjectTargets();
    return Promise.all(
      projects.map((project) =>
        this.buildProjectSummary({
          activeProjectRoot: state.activeProjectRoot,
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
      activeProjectRoot: state.activeProjectRoot,
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
      sourceOfTruth: buildProjectRuntimeControlSourceOfTruth({
        activeRuntimeProject,
        projects,
        selectedProject,
        state,
        statePath: this.statePath,
      }),
      state,
    };
  }

  async selectProject(target: ProjectRuntimeTarget): Promise<ProjectRuntimeControlSnapshot> {
    const project = this.resolveTarget(target, { requireRegistered: true });
    const now = new Date().toISOString();
    this.writeState(
      createProjectRuntimeControlState({
        activeProjectId: null,
        activeProjectRoot: null,
        selectedAt: now,
        selectedProjectId: project.entry?.id ?? null,
        selectedProjectRoot: project.projectRoot,
        updatedAt: now,
      })
    );
    return this.snapshot();
  }

  async clearSelection(): Promise<ProjectRuntimeControlSnapshot> {
    this.writeState(emptyState(new Date().toISOString()));
    return this.snapshot();
  }

  async startProject(
    target: ProjectRuntimeTarget,
    options: ProjectRuntimeControlOptions = {}
  ): Promise<ProjectRuntimeControlActionResult> {
    return this.activateProject('start', target, options);
  }

  async switchProject(
    target: ProjectRuntimeTarget,
    options: ProjectRuntimeControlOptions = {}
  ): Promise<ProjectRuntimeControlActionResult> {
    return this.activateProject('switch', target, options);
  }

  async openDashboard(
    target?: ProjectRuntimeTarget,
    options: ProjectRuntimeControlOptions = {}
  ): Promise<ProjectRuntimeControlActionResult> {
    const resolvedTarget = target ?? this.targetFromCurrentState();
    const result = await this.activateProject('open-dashboard', resolvedTarget, options);
    if (result.ok && !result.handoff?.dashboardUrl) {
      return {
        ...result,
        error: 'Dashboard URL is unavailable for the target project',
        ok: false,
      };
    }
    return result;
  }

  async stopProject(
    target: ProjectRuntimeTarget,
    options: ProjectRuntimeControlOptions = {}
  ): Promise<ProjectRuntimeControlActionResult> {
    const before = await this.snapshot();
    const resolved = this.resolveTarget(target, { requireRegistered: true });
    const targetBefore = await this.buildProjectSummary({
      activeProjectRoot: before.state.activeProjectRoot,
      entry: resolved.entry,
      projectRoot: resolved.projectRoot,
      selectedProjectRoot: before.state.selectedProjectRoot,
    });

    let error: string | null = null;
    let deferredStopProject: ProjectRuntimeScopeSummary | null = null;
    if (!targetBefore.projectExists) {
      error = `Project path is missing: ${targetBefore.projectRoot}`;
    } else if (options.deferSelfDaemonStop === true && isCurrentProcessDaemon(targetBefore)) {
      deferredStopProject = targetBefore;
    } else {
      try {
        await this.#supervisor.stop({
          projectRoot: targetBefore.projectRoot,
          waitMs: options.stopWaitMs,
        });
      } catch (caught: unknown) {
        error = errorMessage(caught);
      }
    }

    const state = this.readState();
    const targetWasSelected = sameProjectRoot(targetBefore.projectRoot, state.selectedProjectRoot);
    const targetWasActive = sameProjectRoot(targetBefore.projectRoot, state.activeProjectRoot);
    if (targetWasSelected || targetWasActive) {
      this.writeState(
        createProjectRuntimeControlState({
          activeProjectId: targetWasActive ? null : state.activeProjectId,
          activeProjectRoot: targetWasActive ? null : state.activeProjectRoot,
          selectedAt: state.selectedAt,
          selectedProjectId: state.selectedProjectId,
          selectedProjectRoot: state.selectedProjectRoot,
          updatedAt: new Date().toISOString(),
        })
      );
    }

    const snapshot = await this.snapshot();
    const targetProject = await this.buildProjectSummary({
      activeProjectRoot: snapshot.state.activeProjectRoot,
      entry: resolved.entry,
      projectRoot: resolved.projectRoot,
      selectedProjectRoot: snapshot.state.selectedProjectRoot,
    });

    return {
      action: 'stop',
      deferredStopProject,
      error,
      handoff: handoffFromProject(targetProject),
      ok: error === null,
      previousActiveProject: before.activeRuntimeProject,
      snapshot,
      stoppedProject: deferredStopProject ? null : targetProject,
      targetProject,
    };
  }

  async activateProject(
    action: ProjectRuntimeControlActionResult['action'],
    target: ProjectRuntimeTarget,
    options: ProjectRuntimeControlOptions
  ): Promise<ProjectRuntimeControlActionResult> {
    const before = await this.snapshot();
    const resolved = this.resolveTarget(target, { requireRegistered: true });
    const targetBefore = await this.buildProjectSummary({
      activeProjectRoot: before.state.activeProjectRoot,
      entry: resolved.entry,
      projectRoot: resolved.projectRoot,
      selectedProjectRoot: resolved.projectRoot,
    });

    if (!targetBefore.projectExists) {
      return this.actionResult({
        action,
        error: `Project path is missing: ${targetBefore.projectRoot}`,
        previousActiveProject: before.activeRuntimeProject,
        stoppedProject: null,
        targetProject: targetBefore,
      });
    }

    let stoppedProject: ProjectRuntimeScopeSummary | null = null;
    let deferredStopProject: ProjectRuntimeScopeSummary | null = null;
    const currentActive = before.activeRuntimeProject;
    const shouldStopCurrent =
      currentActive && !sameProjectRoot(currentActive.projectRoot, targetBefore.projectRoot);
    const shouldDeferCurrentStop =
      shouldStopCurrent &&
      options.deferSelfDaemonStop === true &&
      isCurrentProcessDaemon(currentActive);
    if (shouldStopCurrent && !shouldDeferCurrentStop) {
      try {
        await this.#supervisor.stop({
          projectRoot: currentActive.projectRoot,
          waitMs: options.stopWaitMs,
        });
      } catch (caught: unknown) {
        return this.actionResult({
          action,
          error: `Failed to stop active runtime ${currentActive.projectRoot}: ${errorMessage(caught)}`,
          previousActiveProject: currentActive,
          stoppedProject: null,
          targetProject: targetBefore,
        });
      }
      stoppedProject = await this.buildProjectSummary({
        activeProjectRoot: null,
        entry: ProjectRegistry.get(currentActive.projectRoot),
        projectRoot: currentActive.projectRoot,
        selectedProjectRoot: targetBefore.projectRoot,
      });
    } else if (shouldDeferCurrentStop) {
      deferredStopProject = currentActive;
    }

    let startError: string | null = null;
    try {
      await this.#supervisor.start({
        projectRoot: targetBefore.projectRoot,
        restart: options.restart,
        waitUntilReadyMs: options.waitUntilReadyMs,
      });
    } catch (caught: unknown) {
      startError = errorMessage(caught);
    }

    const targetAfterStart = await this.buildProjectSummary({
      activeProjectRoot: shouldDeferCurrentStop ? before.state.activeProjectRoot : null,
      entry: resolved.entry,
      projectRoot: resolved.projectRoot,
      selectedProjectRoot: targetBefore.projectRoot,
    });
    const daemonError = startError
      ? `Failed to start target runtime ${targetBefore.projectRoot}: ${startError}`
      : targetAfterStart.daemon.ready
        ? null
        : (targetAfterStart.daemon.message ?? 'Target daemon did not become ready');

    if (daemonError && shouldDeferCurrentStop) {
      return this.actionResult({
        action,
        error: daemonError,
        previousActiveProject: before.activeRuntimeProject,
        stoppedProject: null,
        targetProject: targetAfterStart,
      });
    }

    const now = new Date().toISOString();
    this.writeState(
      createProjectRuntimeControlState({
        activeProjectId: targetAfterStart.daemon.ready ? targetAfterStart.projectId : null,
        activeProjectRoot: targetAfterStart.daemon.ready ? targetAfterStart.projectRoot : null,
        selectedAt: now,
        selectedProjectId: targetAfterStart.projectId,
        selectedProjectRoot: targetAfterStart.projectRoot,
        updatedAt: now,
      })
    );

    const snapshot = await this.snapshot();
    const targetProject = snapshot.selectedProject ?? targetAfterStart;

    return {
      action,
      deferredStopProject: daemonError === null ? deferredStopProject : null,
      error: daemonError,
      handoff: handoffFromProject(targetProject),
      ok: daemonError === null,
      previousActiveProject: before.activeRuntimeProject,
      snapshot,
      stoppedProject,
      targetProject,
    };
  }

  async actionResult(options: {
    action: ProjectRuntimeControlActionResult['action'];
    error: string | null;
    deferredStopProject?: ProjectRuntimeScopeSummary | null;
    previousActiveProject: ProjectRuntimeScopeSummary | null;
    stoppedProject: ProjectRuntimeScopeSummary | null;
    targetProject: ProjectRuntimeScopeSummary | null;
  }): Promise<ProjectRuntimeControlActionResult> {
    const snapshot = await this.snapshot();
    return {
      action: options.action,
      deferredStopProject: options.deferredStopProject ?? null,
      error: options.error,
      handoff: options.targetProject ? handoffFromProject(options.targetProject) : null,
      ok: options.error === null,
      previousActiveProject: options.previousActiveProject,
      snapshot,
      stoppedProject: options.stoppedProject,
      targetProject: options.targetProject,
    };
  }

  targetFromCurrentState(): ProjectRuntimeTarget {
    const state = this.readState();
    const target = firstProjectRuntimeTarget(
      { projectId: state.activeProjectId ?? undefined },
      { projectRoot: state.activeProjectRoot ?? undefined },
      { projectId: state.selectedProjectId ?? undefined },
      { projectRoot: state.selectedProjectRoot ?? undefined }
    );
    if (!target) {
      throw new Error('No selected or active project runtime is available');
    }
    return target;
  }

  async buildProjectSummary(
    options: BuildProjectSummaryOptions
  ): Promise<ProjectRuntimeScopeSummary> {
    const projectRoot = resolve(options.projectRoot);
    const inspection = ProjectRegistry.inspect(projectRoot);
    const resolver = resolveAlembicWorkspace(projectRoot);
    const facts = resolver.toFacts();
    const projectExists = existsSync(projectRoot);
    const selected = sameProjectRoot(projectRoot, options.selectedProjectRoot ?? null);
    const activeRuntimeState = sameProjectRoot(projectRoot, options.activeProjectRoot ?? null);
    const daemon = projectExists ? await this.safeDaemonStatus(projectRoot) : null;
    const status = projectExists ? (daemon?.status ?? 'unavailable') : 'missing';
    const healthData = asRecord(daemon?.health?.data);
    const dashboardUrl = firstString(healthData?.dashboardUrl, daemon?.state?.dashboardUrl);
    const activeRuntime = activeRuntimeState && daemon?.ready === true;
    const apiAi = summarizeApiAi(projectRoot, healthData);

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
      apiAi,
      jobs: summarizeJobs(resolveAlembicDaemonPaths(projectRoot).jobsDir),
      mode: facts.mode,
      projectExists,
      projectId: facts.projectId ?? options.entry?.id ?? inspection.projectId,
      projectRealpath: facts.projectRealpath,
      projectRoot: facts.targetProjectRoot,
      projectScope: facts.projectScope,
      projectScopeId: facts.projectScopeId,
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
    if (!isProjectRuntimeTarget(target)) {
      throw new Error('Project target requires exactly one of projectId or projectRoot');
    }

    if (target.projectId) {
      const match = ProjectRegistry.list().find(({ entry }) => entry.id === target.projectId);
      if (!match) {
        const scope = new ProjectScopeRegistryStore()
          .listScopes()
          .find(
            (candidate) =>
              candidate.projectId === target.projectId ||
              candidate.projectScopeId === target.projectId
          );
        if (!scope) {
          throw new Error(`Project is not registered: ${target.projectId}`);
        }
        const projectRoot = scope.folders[0]?.path ?? scope.controlRoot.path;
        return { entry: ProjectRegistry.get(projectRoot), projectRoot };
      }
      return match;
    }

    if (!target.projectRoot) {
      throw new Error('Project target requires projectId or projectRoot');
    }

    const projectRoot = resolve(target.projectRoot);
    const entry = ProjectRegistry.get(projectRoot);
    const projectScopeMatch = new ProjectScopeRegistryStore().resolveFolder(projectRoot);
    if (options.requireRegistered && !entry && !projectScopeMatch) {
      throw new Error(`Project is not registered: ${projectRoot}`);
    }
    return { entry, projectRoot };
  }

  withActiveProject(
    state: ProjectRuntimeControlState,
    projects: ProjectRuntimeScopeSummary[]
  ): ProjectRuntimeControlState {
    const activeProject =
      projects.find(
        (project) =>
          sameProjectRoot(project.projectRoot, state.activeProjectRoot) &&
          project.daemon.ready === true &&
          project.flags.activeRuntime
      ) ?? null;
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

function summarizeApiAi(
  projectRoot: string,
  healthData: Record<string, unknown> | null
): ProjectRuntimeApiAiSummary {
  const capabilities = asRecord(healthData?.capabilities);
  const apiAi = asRecord(capabilities?.apiAi);
  if (apiAi) {
    return {
      available: apiAi.available === true,
      configSource: normalizeApiAiSource(apiAi.configSource),
      model: firstString(apiAi.model),
      provider: firstString(apiAi.provider),
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

function normalizeApiAiSource(value: unknown): ProjectRuntimeApiAiSummary['configSource'] {
  if (value === 'empty' || value === 'process-env' || value === 'workspace-settings') {
    return value;
  }
  return 'unavailable';
}

function collectRuntimeProjectTargets(): Array<{
  entry: ProjectEntry | null;
  projectRoot: string;
}> {
  const byRoot = new Map<string, { entry: ProjectEntry | null; projectRoot: string }>();
  for (const project of ProjectRegistry.list()) {
    byRoot.set(comparableProjectRoot(project.projectRoot), project);
  }
  for (const scope of new ProjectScopeRegistryStore().listScopes()) {
    for (const folder of scope.folders) {
      const key = comparableProjectRoot(folder.path);
      if (!byRoot.has(key)) {
        byRoot.set(key, { entry: ProjectRegistry.get(folder.path), projectRoot: folder.path });
      }
    }
  }
  return [...byRoot.values()].sort((left, right) =>
    left.projectRoot.localeCompare(right.projectRoot)
  );
}

function emptyState(updatedAt = new Date(0).toISOString()): ProjectRuntimeControlState {
  return createProjectRuntimeControlState({ updatedAt });
}

function sameProjectRoot(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  return (
    typeof left === 'string' &&
    typeof right === 'string' &&
    comparableProjectRoot(left) === comparableProjectRoot(right)
  );
}

function comparableProjectRoot(value: string): string {
  const resolved = resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
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

function handoffFromProject(project: ProjectRuntimeScopeSummary): ProjectRuntimeHandoff {
  return {
    apiBaseUrl: project.daemon.url,
    dashboardUrl: project.dashboardUrl,
    projectId: project.projectId,
    projectRoot: project.projectRoot,
    status: project.status,
  };
}

function firstProjectRuntimeTarget(
  ...targets: Array<Partial<ProjectRuntimeTarget>>
): ProjectRuntimeTarget | null {
  for (const target of targets) {
    if (isProjectRuntimeTarget(target)) {
      return target;
    }
  }
  return null;
}

function isCurrentProcessDaemon(project: ProjectRuntimeScopeSummary): boolean {
  if (process.env.ALEMBIC_DAEMON_MODE !== '1') {
    return false;
  }
  if (!sameProjectRoot(project.projectRoot, process.env.ALEMBIC_PROJECT_DIR)) {
    return false;
  }
  if (project.daemon.pid === process.pid) {
    return true;
  }
  return (
    typeof process.env.ALEMBIC_DAEMON_STATE_PATH === 'string' &&
    resolve(process.env.ALEMBIC_DAEMON_STATE_PATH) === resolve(project.daemon.statePath)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
