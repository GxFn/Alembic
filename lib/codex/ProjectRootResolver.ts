import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { getPackageVersion } from '../daemon/DaemonState.js';
import { PACKAGE_ROOT } from '../shared/package-root.js';
import { WorkspaceResolver } from '../shared/WorkspaceResolver.js';
import { CODEX_PLUGIN_ROOT_ENV, CODEX_SETUP_PROFILE } from './RuntimeContext.js';

export type CodexProjectRootSource =
  | 'explicit-option'
  | 'ALEMBIC_PROJECT_DIR'
  | 'CODEX_WORKSPACE_DIR'
  | 'CODEX_WORKSPACE_ROOT'
  | 'saved-project-root'
  | 'INIT_CWD'
  | 'PWD'
  | 'process.cwd';

export type CodexProjectRootTrust = 'fallback' | 'rejected' | 'trusted';

export interface CodexProjectRootCandidate {
  path: string;
  source: CodexProjectRootSource;
  trust: Exclude<CodexProjectRootTrust, 'rejected'>;
}

export interface CodexProjectRootResolution {
  candidates: CodexProjectRootCandidate[];
  path: string | null;
  reason: string;
  rejected: boolean;
  source: CodexProjectRootSource | null;
  trust: CodexProjectRootTrust;
}

export interface CodexSavedProjectRoot {
  projectRealpath: string;
  projectRoot: string;
  savedAt: string;
  schemaVersion: 1;
  source: 'explicit-projectRoot';
}

export interface CodexInitMarker {
  dataRoot: string;
  ghost: boolean;
  initializedAt: string;
  initializedBy: 'alembic_codex_init' | 'codex-plugin-init-on-demand';
  pluginVersion: string;
  profile: typeof CODEX_SETUP_PROFILE;
  projectRoot: string;
  requestedTool?: string;
  results: Array<Record<string, unknown>>;
  route: 'explicit' | 'tool-call';
  schemaVersion: 1;
}

export interface ResolveCodexProjectRootOptions {
  env?: NodeJS.ProcessEnv;
  projectRoot?: string;
}

const PROJECT_ROOT_REQUIRED_ACTIONS = [
  'Provide the target project root as an absolute path.',
  'Pass the current workspace directory as the projectRoot argument on the Alembic tool call.',
  'Rerun the Alembic tool after the project root is available.',
];

export function resolveCodexProjectRoot(
  options: ResolveCodexProjectRootOptions = {}
): CodexProjectRootResolution {
  const env = options.env || process.env;
  const candidates = buildProjectRootCandidates(options.projectRoot, env);
  if (candidates.length === 0) {
    return {
      candidates,
      path: null,
      reason:
        'No project root candidate was provided by Alembic or Codex. Alembic project workflows require an explicit absolute project root.',
      rejected: true,
      source: null,
      trust: 'rejected',
    };
  }

  const first = candidates[0];
  const rejection = getProjectRootRejectionReason(first.path, env);
  if (rejection) {
    return {
      candidates,
      path: first.path,
      reason: rejection,
      rejected: true,
      source: first.source,
      trust: 'rejected',
    };
  }

  if (first.trust === 'trusted') {
    return {
      candidates,
      path: first.path,
      reason: `Project root is trusted from ${first.source}.`,
      rejected: false,
      source: first.source,
      trust: 'trusted',
    };
  }

  return {
    candidates,
    path: first.path,
    reason: `Project root came from fallback ${first.source}; Alembic cannot treat it as the target project directory. Pass the current workspace directory as an explicit projectRoot.`,
    rejected: false,
    source: first.source,
    trust: 'fallback',
  };
}

export function buildCodexProjectRootRequiredMessage(
  resolution: CodexProjectRootResolution
): string {
  const candidate = resolution.path
    ? ` Current candidate from ${resolution.source || 'unknown'} was: ${resolution.path}.`
    : '';
  return `Alembic Codex cannot determine the target project directory, so project workflows cannot be used yet. Pass the current workspace directory as an absolute projectRoot argument.${candidate} Reason: ${resolution.reason}`;
}

export function buildCodexProjectRootRequiredActions(): string[] {
  return [...PROJECT_ROOT_REQUIRED_ACTIONS];
}

export function getCodexSavedProjectRootPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(getCodexGlobalRoot(env), 'codex-project-root.json');
}

export function readCodexSavedProjectRoot(
  env: NodeJS.ProcessEnv = process.env
): CodexSavedProjectRoot | null {
  const markerPath = getCodexSavedProjectRootPath(env);
  if (!existsSync(markerPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as Partial<CodexSavedProjectRoot>;
    if (!isCodexSavedProjectRoot(parsed)) {
      return null;
    }
    const resolved = resolveCandidatePath(parsed.projectRoot, env);
    if (!resolved || getProjectRootRejectionReason(resolved, env)) {
      return null;
    }
    return {
      ...parsed,
      projectRoot: resolved,
      projectRealpath: safeRealpath(resolved),
    };
  } catch {
    return null;
  }
}

export function writeCodexSavedProjectRoot(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env
): CodexSavedProjectRoot {
  const resolved = resolveCandidatePath(projectRoot, env);
  if (!resolved || !isAbsolute(projectRoot)) {
    throw new Error('projectRoot must be an absolute path before it can be saved.');
  }
  const rejection = getProjectRootRejectionReason(resolved, env);
  if (rejection) {
    throw new Error(`Cannot save Codex project root: ${rejection}`);
  }
  const marker: CodexSavedProjectRoot = {
    schemaVersion: 1,
    savedAt: new Date().toISOString(),
    source: 'explicit-projectRoot',
    projectRoot: resolved,
    projectRealpath: safeRealpath(resolved),
  };
  const markerPath = getCodexSavedProjectRootPath(env);
  mkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 });
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  return marker;
}

export function isTrustedCodexProjectRoot(resolution: CodexProjectRootResolution): boolean {
  return Boolean(resolution.path) && resolution.trust === 'trusted' && !resolution.rejected;
}

export function summarizeCodexProjectRootResolution(
  resolution: CodexProjectRootResolution
): Record<string, unknown> {
  return {
    path: resolution.path,
    source: resolution.source,
    trust: resolution.trust,
    rejected: resolution.rejected,
    reason: resolution.reason,
    userMessage:
      resolution.trust === 'trusted' ? null : buildCodexProjectRootRequiredMessage(resolution),
    requiredActions: resolution.trust === 'trusted' ? [] : buildCodexProjectRootRequiredActions(),
    candidates: resolution.candidates.map((candidate) => ({
      source: candidate.source,
      trust: candidate.trust,
      path: candidate.path,
    })),
  };
}

export function getCodexInitMarkerPath(projectRoot: string): string {
  const resolver = WorkspaceResolver.fromProject(projectRoot);
  return resolve(resolver.runtimeDir, 'codex-init.json');
}

export function readCodexInitMarker(projectRoot: string): CodexInitMarker | null {
  let markerPath: string;
  try {
    markerPath = getCodexInitMarkerPath(projectRoot);
  } catch {
    return null;
  }
  if (!existsSync(markerPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as Partial<CodexInitMarker>;
    return isCodexInitMarker(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCodexInitMarker(
  projectRoot: string,
  input: Omit<
    CodexInitMarker,
    | 'dataRoot'
    | 'ghost'
    | 'initializedAt'
    | 'pluginVersion'
    | 'profile'
    | 'projectRoot'
    | 'schemaVersion'
  >
): CodexInitMarker {
  const resolver = WorkspaceResolver.fromProject(projectRoot);
  const marker: CodexInitMarker = {
    schemaVersion: 1,
    initializedAt: new Date().toISOString(),
    initializedBy: input.initializedBy,
    route: input.route,
    projectRoot: resolver.projectRoot,
    dataRoot: resolver.dataRoot,
    profile: CODEX_SETUP_PROFILE,
    ghost: resolver.ghost,
    pluginVersion: getPackageVersion(),
    results: input.results,
    ...(input.requestedTool ? { requestedTool: input.requestedTool } : {}),
  };
  const markerPath = getCodexInitMarkerPath(projectRoot);
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  return marker;
}

function buildProjectRootCandidates(
  projectRoot: string | undefined,
  env: NodeJS.ProcessEnv
): CodexProjectRootCandidate[] {
  const candidates: CodexProjectRootCandidate[] = [];
  pushCandidate(candidates, projectRoot, 'explicit-option', 'trusted', env);
  pushCandidate(candidates, env.ALEMBIC_PROJECT_DIR, 'ALEMBIC_PROJECT_DIR', 'trusted', env);
  pushCandidate(candidates, env.CODEX_WORKSPACE_DIR, 'CODEX_WORKSPACE_DIR', 'trusted', env);
  pushCandidate(candidates, env.CODEX_WORKSPACE_ROOT, 'CODEX_WORKSPACE_ROOT', 'trusted', env);
  pushCandidate(
    candidates,
    readCodexSavedProjectRoot(env)?.projectRoot,
    'saved-project-root',
    'trusted',
    env
  );
  pushCandidate(candidates, env.INIT_CWD, 'INIT_CWD', 'fallback', env);
  pushCandidate(candidates, env.PWD, 'PWD', 'fallback', env);
  pushCandidate(candidates, safeProcessCwd(), 'process.cwd', 'fallback', env);
  return candidates;
}

function pushCandidate(
  candidates: CodexProjectRootCandidate[],
  rawPath: string | undefined,
  source: CodexProjectRootSource,
  trust: Exclude<CodexProjectRootTrust, 'rejected'>,
  env: NodeJS.ProcessEnv
): void {
  const resolved = resolveCandidatePath(rawPath, env);
  if (!resolved) {
    return;
  }
  if (candidates.some((candidate) => candidate.path === resolved)) {
    return;
  }
  candidates.push({ path: resolved, source, trust });
}

function resolveCandidatePath(rawPath: string | undefined, env: NodeJS.ProcessEnv): string | null {
  const trimmed = rawPath?.trim();
  if (!trimmed) {
    return null;
  }
  if (isAbsolute(trimmed)) {
    return resolve(trimmed);
  }
  const base = safeProcessCwd() || absoluteEnvPath(env.PWD) || homedir();
  return resolve(base, trimmed);
}

function getProjectRootRejectionReason(path: string, env: NodeJS.ProcessEnv): string | null {
  if (!existsSync(path)) {
    return `Project root does not exist: ${path}`;
  }
  if (!safeIsDirectory(path)) {
    return `Project root is not a directory: ${path}`;
  }
  if (isFilesystemRoot(path)) {
    return 'Project root points to the filesystem root.';
  }
  if (path === resolve(homedir())) {
    return 'Project root points to the user home directory.';
  }
  if (path === resolve(tmpdir()) || path === '/tmp' || path === '/private/tmp') {
    return 'Project root points to a temporary root directory.';
  }
  if (isCodexPluginCachePath(path)) {
    return 'Project root points inside the Codex plugin cache.';
  }
  const pluginRoot = resolveConfiguredPluginRoot(env);
  if (pluginRoot && path === pluginRoot && isCodexPluginCachePath(pluginRoot)) {
    return 'Project root points to the installed Alembic Codex plugin root.';
  }
  const packageRoot = resolve(PACKAGE_ROOT);
  if (path === packageRoot && isCodexPluginCachePath(packageRoot)) {
    return 'Project root points to the Alembic runtime package root.';
  }
  return null;
}

function resolveConfiguredPluginRoot(env: NodeJS.ProcessEnv): string | null {
  return resolveCandidatePath(env[CODEX_PLUGIN_ROOT_ENV], env);
}

function isCodexPluginCachePath(path: string): boolean {
  const normalized = path.split('/').join(sep);
  const marker = `${sep}.codex${sep}plugins${sep}cache${sep}`;
  return normalized.includes(marker);
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFilesystemRoot(path: string): boolean {
  return dirname(path) === path;
}

function safeProcessCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

function absoluteEnvPath(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  return trimmed && isAbsolute(trimmed) ? trimmed : undefined;
}

function getCodexGlobalRoot(env: NodeJS.ProcessEnv): string {
  const root = env.ALEMBIC_HOME || env.HOME || env.USERPROFILE || homedir();
  return resolve(root, '.asd');
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isCodexSavedProjectRoot(
  value: Partial<CodexSavedProjectRoot>
): value is CodexSavedProjectRoot {
  return (
    value.schemaVersion === 1 &&
    value.source === 'explicit-projectRoot' &&
    typeof value.projectRoot === 'string' &&
    typeof value.projectRealpath === 'string' &&
    typeof value.savedAt === 'string'
  );
}

function isCodexInitMarker(value: Partial<CodexInitMarker>): value is CodexInitMarker {
  return (
    value.schemaVersion === 1 &&
    typeof value.initializedAt === 'string' &&
    (value.initializedBy === 'alembic_codex_init' ||
      value.initializedBy === 'codex-plugin-init-on-demand') &&
    (value.route === 'explicit' || value.route === 'tool-call') &&
    typeof value.projectRoot === 'string' &&
    typeof value.dataRoot === 'string' &&
    value.profile === CODEX_SETUP_PROFILE &&
    typeof value.ghost === 'boolean' &&
    typeof value.pluginVersion === 'string' &&
    Array.isArray(value.results)
  );
}
