#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const scenario = readOption(args, '--scenario');
const mode = readOption(args, '--mode') || 'in-process';
const projectRoot = readOption(args, '--project-root');
const runRoot = readOption(args, '--run-root');
const waitDaemonReadyMs = readOption(args, '--wait-daemon-ready-ms');
const waitJobTimeoutMs = readOption(args, '--wait-job-timeout-ms');
const jobPollIntervalMs = readOption(args, '--job-poll-interval-ms');
const useRealAlembicHome = args.includes('--real-alembic-home');
const resolvedProjectRoot = projectRoot ? resolve(projectRoot) : '';

if (mode !== 'in-process' && mode !== 'live-local') {
  console.error(`Unsupported mode for the current Alembic verifier: ${mode}`);
  console.error('Supported modes: in-process, live-local.');
  process.exit(2);
}

if (mode === 'live-local' && (!scenario || !resolvedProjectRoot || !useRealAlembicHome)) {
  console.error(
    '--mode live-local requires --scenario, --project-root, and --real-alembic-home so real ~/.asd writes are bound to one explicit test project.'
  );
  process.exit(2);
}

if (useRealAlembicHome) {
  if (!scenario || !resolvedProjectRoot) {
    console.error(
      '--real-alembic-home requires both --scenario and --project-root so real ~/.asd writes are bound to one explicit test project.'
    );
    process.exit(2);
  }
  if (resolvedProjectRoot === resolve(process.cwd())) {
    console.error(
      '--real-alembic-home must not target the Alembic development repository. Use a disposable test project.'
    );
    process.exit(2);
  }
}

const vitestBin = resolve('node_modules/vitest/vitest.mjs');
if (!existsSync(vitestBin)) {
  console.error('Vitest is not installed. Run npm install before verification.');
  process.exit(2);
}

const env = { ...process.env };
if (scenario) {
  env.CODEX_SESSION_SCENARIO_FILTER = scenario;
}
if (resolvedProjectRoot) {
  env.CODEX_SESSION_PROJECT_ROOT = resolvedProjectRoot;
  env.CODEX_SESSION_PROJECT_ROOT_SOURCE = 'cli-option';
}
if (runRoot) {
  env.CODEX_SESSION_RUN_ROOT = resolve(runRoot);
}
env.CODEX_SESSION_HARNESS_MODE = mode;
if (useRealAlembicHome) {
  env.CODEX_SESSION_USE_REAL_ALEMBIC_HOME = '1';
}
if (waitDaemonReadyMs) {
  env.CODEX_SESSION_WAIT_DAEMON_READY_MS = waitDaemonReadyMs;
}
if (waitJobTimeoutMs) {
  env.CODEX_SESSION_WAIT_JOB_TIMEOUT_MS = waitJobTimeoutMs;
}
if (jobPollIntervalMs) {
  env.CODEX_SESSION_JOB_POLL_INTERVAL_MS = jobPollIntervalMs;
}
if (mode === 'live-local') {
  const timeout = Number(waitJobTimeoutMs || 600_000);
  env.CODEX_SESSION_WAIT_JOB_TIMEOUT_MS = String(timeout);
  env.CODEX_SESSION_JOB_POLL_INTERVAL_MS = jobPollIntervalMs || '2000';
  env.CODEX_SESSION_WAIT_DAEMON_READY_MS = waitDaemonReadyMs || '30000';
  env.CODEX_SESSION_TEST_TIMEOUT_MS = String(Math.max(timeout + 120_000, 180_000));
  env.ALEMBIC_QUIET = env.ALEMBIC_QUIET || '1';
}

const result = spawnSync(
  process.execPath,
  [vitestBin, 'run', 'test/unit/CodexSessionScenarioRunner.test.ts'],
  { env, stdio: 'inherit' }
);

process.exit(result.status ?? 1);

function readOption(values, name) {
  const index = values.indexOf(name);
  if (index < 0) {
    return '';
  }
  return values[index + 1] || '';
}
