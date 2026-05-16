import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pathGuard from '../../../lib/shared/PathGuard.js';
import { ProjectRegistry } from '../../../lib/shared/ProjectRegistry.js';
import { WorkspaceResolver } from '../../../lib/shared/WorkspaceResolver.js';
import { WorkspaceSettingsStore } from '../../../lib/shared/WorkspaceSettingsStore.js';
import type {
  CodexScenarioFixtureRunConfig,
  CodexScenarioRunOptions,
  CodexSessionScenario,
} from './ScenarioTypes.js';

const ENV_KEYS = [
  'ALEMBIC_AI_PROVIDER',
  'ALEMBIC_DEEPSEEK_API_KEY',
  'ALEMBIC_HOME',
  'ALEMBIC_PROJECT_DIR',
  'CODEX_WORKSPACE_DIR',
  'CODEX_WORKSPACE_ROOT',
  'CODEX_SESSION_PROJECT_ROOT',
  'CODEX_SESSION_PROJECT_ROOT_SOURCE',
  'CODEX_SESSION_RUN_ROOT',
  'CODEX_SESSION_HARNESS_MODE',
  'CODEX_SESSION_JOB_POLL_INTERVAL_MS',
  'CODEX_SESSION_USE_REAL_ALEMBIC_HOME',
  'CODEX_SESSION_WAIT_DAEMON_READY_MS',
  'CODEX_SESSION_WAIT_JOB_TIMEOUT_MS',
  'INIT_CWD',
  'PWD',
];

export interface CodexScenarioFixtureContext {
  restore(): void;
  config: CodexScenarioFixtureRunConfig;
  runDir: string;
  projectRoot: string;
  redactions: string[];
}

export function setupCodexScenarioFixture(
  scenario: CodexSessionScenario,
  options: CodexScenarioRunOptions = {}
): CodexScenarioFixtureContext {
  const previousEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  pathGuard._reset();
  const runRoot = resolveRunRoot(options.runRoot);
  fs.mkdirSync(runRoot, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(runRoot, `${timestampPrefix()}-${safeId(scenario.id)}-`));
  const project = resolveProjectRoot(scenario, runDir, options);
  const harnessMode = resolveHarnessMode(options.mode);
  const waitJobTimeoutMs = resolvePositiveInteger(
    options.waitJobTimeoutMs,
    process.env.CODEX_SESSION_WAIT_JOB_TIMEOUT_MS,
    harnessMode === 'live-local' ? 600_000 : 0
  );
  const jobPollIntervalMs = resolvePositiveInteger(
    options.jobPollIntervalMs,
    process.env.CODEX_SESSION_JOB_POLL_INTERVAL_MS,
    harnessMode === 'live-local' ? 2_000 : 0
  );
  const waitUntilReadyMs = resolvePositiveInteger(
    options.waitUntilReadyMs,
    process.env.CODEX_SESSION_WAIT_DAEMON_READY_MS,
    harnessMode === 'live-local' ? 30_000 : 3_000
  );

  const useRealAlembicHome =
    options.useRealAlembicHome ??
    scenario.fixture.useRealAlembicHome ??
    process.env.CODEX_SESSION_USE_REAL_ALEMBIC_HOME === '1';
  const alembicHomeRoot = useRealAlembicHome ? os.homedir() : path.join(runDir, 'alembic-home');
  const alembicHome = path.join(alembicHomeRoot, '.asd');
  if (useRealAlembicHome) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = alembicHomeRoot;
  }
  delete process.env.ALEMBIC_PROJECT_DIR;
  delete process.env.CODEX_WORKSPACE_DIR;
  delete process.env.CODEX_WORKSPACE_ROOT;
  delete process.env.INIT_CWD;
  delete process.env.ALEMBIC_AI_PROVIDER;
  delete process.env.ALEMBIC_DEEPSEEK_API_KEY;
  ProjectRegistry.register(project.projectRoot, true);

  const redactions = [...(scenario.fixture.redactions || [])];
  if (scenario.fixture.ai === 'deepseek') {
    process.env.ALEMBIC_AI_PROVIDER = 'deepseek';
    process.env.ALEMBIC_DEEPSEEK_API_KEY = 'scenario-secret-deepseek-key';
    redactions.push('scenario-secret-deepseek-key');
  }

  prepareKnowledgeFixture(project.projectRoot, scenario);

  return {
    config: {
      alembicHome,
      alembicHomeMode: useRealAlembicHome ? 'real' : 'isolated',
      harnessMode,
      jobPollIntervalMs,
      projectRoot: project.projectRoot,
      projectRootSource: project.source,
      runRoot,
      waitJobTimeoutMs,
      waitUntilReadyMs,
    },
    projectRoot: project.projectRoot,
    redactions,
    runDir,
    restore() {
      pathGuard._reset();
      for (const key of ENV_KEYS) {
        const previous = previousEnv.get(key);
        if (previous === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous;
        }
      }
    },
  };
}

function resolveHarnessMode(
  mode?: CodexScenarioRunOptions['mode']
): CodexScenarioFixtureRunConfig['harnessMode'] {
  const value = mode || process.env.CODEX_SESSION_HARNESS_MODE || 'in-process';
  if (value === 'live-local' || value === 'in-process') {
    return value;
  }
  throw new Error(`Unsupported Codex session harness mode: ${value}`);
}

function resolvePositiveInteger(
  optionValue: number | undefined,
  envValue: string | undefined,
  fallback: number
): number {
  const value = optionValue ?? (envValue ? Number(envValue) : fallback);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Expected non-negative millisecond value, got: ${String(value)}`);
  }
  return Math.floor(value);
}

export function readScenarioSecretWritten(projectRoot: string): boolean {
  const store = WorkspaceSettingsStore.fromProject(projectRoot);
  return fs.existsSync(store.secretsPath);
}

function prepareKnowledgeFixture(projectRoot: string, scenario: CodexSessionScenario): void {
  const knowledge = scenario.fixture.knowledge || 'none';
  if (!scenario.fixture.initialized && knowledge === 'none') {
    return;
  }
  makeInitializedWorkspace(projectRoot);
  if (knowledge === 'usable') {
    const resolver = WorkspaceResolver.fromProject(projectRoot);
    fs.mkdirSync(resolver.recipesDir, { recursive: true });
    fs.writeFileSync(
      path.join(resolver.recipesDir, 'project-http-client.md'),
      '---\ntitle: Project HTTP Client\n---\nUse the shared HTTP client.\n'
    );
  }
}

function makeInitializedWorkspace(projectRoot: string): void {
  const resolver = WorkspaceResolver.fromProject(projectRoot);
  fs.mkdirSync(resolver.runtimeDir, { recursive: true });
  fs.writeFileSync(resolver.configPath, '{}\n');
  fs.writeFileSync(resolver.databasePath, '');
  fs.mkdirSync(resolver.recipesDir, { recursive: true });
  fs.mkdirSync(resolver.skillsDir, { recursive: true });
}

function writeMinimalNodeProject(projectRoot: string): void {
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    `${JSON.stringify({ name: 'scenario-project', type: 'module' }, null, 2)}\n`
  );
  fs.writeFileSync(path.join(projectRoot, 'src', 'index.ts'), 'export const value = 1;\n');
}

function resolveProjectRoot(
  scenario: CodexSessionScenario,
  runDir: string,
  options: CodexScenarioRunOptions
): { projectRoot: string; source: CodexScenarioFixtureRunConfig['projectRootSource'] } {
  const configuredRoot =
    options.projectRoot ||
    expandProjectPath(scenario.fixture.projectPath || '') ||
    process.env.CODEX_SESSION_PROJECT_ROOT ||
    '';
  if (configuredRoot) {
    const projectRoot = path.resolve(configuredRoot);
    if (!fs.existsSync(projectRoot)) {
      throw new Error(`Configured scenario projectRoot does not exist: ${projectRoot}`);
    }
    return {
      projectRoot: fs.realpathSync(projectRoot),
      source: options.projectRoot
        ? 'cli-option'
        : scenario.fixture.projectPath
          ? 'scenario-path'
          : process.env.CODEX_SESSION_PROJECT_ROOT_SOURCE === 'cli-option'
            ? 'cli-option'
            : 'env',
    };
  }
  if (scenario.fixture.project === 'local-path') {
    throw new Error(
      `Scenario ${scenario.id} requires fixture.projectPath or --project-root because project=local-path.`
    );
  }
  const projectRoot = path.join(runDir, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  writeMinimalNodeProject(projectRoot);
  return { projectRoot, source: 'generated-fixture' };
}

function resolveRunRoot(runRoot?: string): string {
  return path.resolve(
    runRoot ||
      process.env.CODEX_SESSION_RUN_ROOT ||
      path.join(os.tmpdir(), 'alembic-codex-session-runs')
  );
}

function expandProjectPath(value: string): string {
  if (!value) {
    return '';
  }
  if (value === '$CODEX_SESSION_PROJECT_ROOT') {
    return process.env.CODEX_SESSION_PROJECT_ROOT || '';
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 80) || 'scenario';
}

function timestampPrefix(): string {
  return new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
}
