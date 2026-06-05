#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..');
const cliPath = join(repoRoot, 'dist', 'bin', 'cli.js');

const smokeRoot = mkdtempSync(join(tmpdir(), 'alembic-multi-project-smoke-'));
const alembicHome = join(smokeRoot, 'home');
const projectA = join(smokeRoot, 'project-a');
const projectB = join(smokeRoot, 'project-b');
const env = {
  ...process.env,
  ALEMBIC_HOME: alembicHome,
  ALEMBIC_QUIET: '1',
  NO_COLOR: '1',
};

const evidence = {
  cleanup: {},
  http: {},
  projects: {},
  setup: {},
};

let projectAId = null;
let projectBId = null;
let smokeSucceeded = false;

try {
  assert(existsSync(cliPath), `CLI build not found: ${cliPath}. Run npm run build first.`);
  createProject(projectA, 'alembic-smoke-a');
  createProject(projectB, 'alembic-smoke-b');

  await runCli(['setup', '--ghost', '--force', '--dir', projectA], { parseJson: false });
  await runCli(['setup', '--ghost', '--force', '--dir', projectB], { parseJson: false });
  evidence.setup = { ghost: true, isolatedHome: true, projectCount: 2 };

  const initialSnapshot = await runCli(['projects', 'list', '--json'], { parseJson: true });
  const projectASummary = findProject(initialSnapshot, 'project-a');
  const projectBSummary = findProject(initialSnapshot, 'project-b');
  projectAId = requireString(projectASummary.projectId, 'project-a projectId');
  projectBId = requireString(projectBSummary.projectId, 'project-b projectId');

  assert(
    initialSnapshot.projects.length === 2,
    'expected exactly two isolated registered projects'
  );
  assert(
    projectASummary.ghost === true && projectBSummary.ghost === true,
    'expected ghost projects'
  );
  evidence.projects = {
    projectA: {
      ghost: projectASummary.ghost,
      mode: projectASummary.mode,
      projectId: projectAId,
      status: projectASummary.status,
    },
    projectB: {
      ghost: projectBSummary.ghost,
      mode: projectBSummary.mode,
      projectId: projectBId,
      status: projectBSummary.status,
    },
    registeredCount: initialSnapshot.projects.length,
  };

  const startA = await runCli(
    ['projects', 'start', projectAId, '--json', '--wait', '10000', '--stop-wait', '5000'],
    { parseJson: true }
  );
  assert(startA.ok === true, 'project-a start action failed');
  assert(startA.targetProject?.projectId === projectAId, 'project-a start target mismatch');
  assert(startA.snapshot?.activeRuntimeProject?.projectId === projectAId, 'project-a not active');

  const apiA = requireString(startA.handoff?.apiBaseUrl, 'project-a API handoff');
  const dashboardA = requireString(startA.handoff?.dashboardUrl, 'project-a dashboard handoff');
  evidence.http.startA = {
    activeProjectId: startA.snapshot.activeRuntimeProject.projectId,
    apiOrigin: originOf(apiA),
    dashboardOrigin: originOf(dashboardA),
    ok: startA.ok,
    selectedProjectId: startA.snapshot.selectedProject?.projectId ?? null,
  };

  const listFromA = await fetchJson(`${apiA}/api/v1/projects`);
  assert(listFromA.status === 200 && listFromA.body?.success === true, 'project-a list failed');
  assert(listFromA.body.data.projects.length === 2, 'project-a list did not include two projects');
  assert(
    listFromA.body.data.activeRuntimeProject?.projectId === projectAId,
    'project-a list active mismatch'
  );

  const currentFromA = await fetchJson(`${apiA}/api/v1/projects/current`);
  assert(
    currentFromA.status === 200 &&
      currentFromA.body?.data?.selectedProject?.projectId === projectAId &&
      currentFromA.body?.data?.activeRuntimeProject?.projectId === projectAId,
    'project-a current state mismatch'
  );
  const sourceOfTruthA = currentFromA.body.data.sourceOfTruth;
  assert(
    sourceOfTruthA?.readiness?.ready === true &&
      sourceOfTruthA?.failure === null &&
      sourceOfTruthA?.runtimeControl?.stateCleanup?.activeState?.cleaned === false,
    'project-a source-of-truth ready contract mismatch'
  );

  const openA = await postJson(`${apiA}/api/v1/projects/${projectAId}/open-dashboard`, {
    waitUntilReadyMs: 10000,
    stopWaitMs: 5000,
  });
  assert(openA.status === 200 && openA.body?.data?.ok === true, 'project-a open-dashboard failed');
  assert(
    openA.body.data.handoff?.dashboardUrl === dashboardA,
    'same-project open-dashboard changed dashboard URL unexpectedly'
  );

  const invalidSwitch = await postJson(`${apiA}/api/v1/projects/not-a-real-project/switch`, {
    waitUntilReadyMs: 10000,
    stopWaitMs: 5000,
  });
  assert(invalidSwitch.status === 404, 'invalid switch should return 404');
  const currentAfterInvalid = await fetchJson(`${apiA}/api/v1/projects/current`);
  assert(
    currentAfterInvalid.body?.data?.activeRuntimeProject?.projectId === projectAId,
    'invalid switch changed active project'
  );

  const switchToB = await postJson(`${apiA}/api/v1/projects/${projectBId}/switch`, {
    waitUntilReadyMs: 10000,
    stopWaitMs: 5000,
  });
  assert(switchToB.status === 200 && switchToB.body?.data?.ok === true, 'project-b switch failed');
  assert(
    switchToB.body.data.targetProject?.projectId === projectBId,
    'project-b switch target mismatch'
  );
  assert(
    switchToB.body.data.deferredStopProject?.projectId === projectAId,
    'project-b switch did not defer project-a stop'
  );

  const apiB = requireString(switchToB.body.data.handoff?.apiBaseUrl, 'project-b API handoff');
  const dashboardB = requireString(
    switchToB.body.data.handoff?.dashboardUrl,
    'project-b dashboard handoff'
  );
  const projectAStoppedAfterSwitch = await waitUntilUnreachable(
    `${apiA}/api/v1/projects/current`,
    5000
  );
  assert(projectAStoppedAfterSwitch, 'project-a API stayed reachable after deferred stop');

  const currentFromB = await fetchJson(`${apiB}/api/v1/projects/current`);
  assert(
    currentFromB.status === 200 &&
      currentFromB.body?.data?.selectedProject?.projectId === projectBId &&
      currentFromB.body?.data?.activeRuntimeProject?.projectId === projectBId,
    'project-b current state mismatch'
  );
  const sourceOfTruthB = currentFromB.body.data.sourceOfTruth;
  assert(
    sourceOfTruthB?.readiness?.ready === true &&
      sourceOfTruthB?.failure === null &&
      sourceOfTruthB?.runtimeControl?.stateCleanup?.activeState?.cleaned === false,
    'project-b source-of-truth ready contract mismatch'
  );

  const listFromB = await fetchJson(`${apiB}/api/v1/projects`);
  assert(listFromB.status === 200 && listFromB.body?.success === true, 'project-b list failed');
  const projectAFromBList = findProject(listFromB.body.data, 'project-a');
  assert(projectAFromBList.flags.activeRuntime === false, 'project-a should no longer be active');

  const openB = await postJson(`${apiB}/api/v1/projects/${projectBId}/open-dashboard`, {
    waitUntilReadyMs: 10000,
    stopWaitMs: 5000,
  });
  assert(openB.status === 200 && openB.body?.data?.ok === true, 'project-b open-dashboard failed');
  assert(
    openB.body.data.handoff?.dashboardUrl === dashboardB,
    'same-project project-b open-dashboard changed dashboard URL unexpectedly'
  );

  const stopB = await postJson(`${apiB}/api/v1/projects/${projectBId}/stop`, {
    stopWaitMs: 5000,
  });
  assert(stopB.status === 200 && stopB.body?.data?.ok === true, 'project-b stop failed');
  assert(
    stopB.body.data.deferredStopProject?.projectId === projectBId,
    'project-b stop did not defer self stop'
  );
  assert(
    stopB.body.data.snapshot?.activeRuntimeProject === null,
    'project-b stop kept active runtime'
  );
  const projectBStoppedAfterStop = await waitUntilUnreachable(
    `${apiB}/api/v1/projects/current`,
    5000
  );
  assert(projectBStoppedAfterStop, 'project-b API stayed reachable after self stop');

  const cliCurrentAfterStop = await runCli(['projects', 'current', '--json'], { parseJson: true });
  assert(
    cliCurrentAfterStop.activeRuntimeProject === null &&
      cliCurrentAfterStop.selectedProject?.projectId === projectBId,
    'CLI current state after stop mismatch'
  );
  assert(
    cliCurrentAfterStop.sourceOfTruth?.failure?.blockedFallbacks?.includes(
      'plugin-selected-root-fallback'
    ) && cliCurrentAfterStop.sourceOfTruth?.failure?.observedSource === 'alembic-source-of-truth',
    'CLI current failure envelope missing blocked fallback contract'
  );

  evidence.http.projectsApi = {
    listCountFromA: listFromA.body.data.projects.length,
    listCountFromB: listFromB.body.data.projects.length,
    selectedFromA: currentFromA.body.data.selectedProject.projectId,
    selectedFromB: currentFromB.body.data.selectedProject.projectId,
  };
  evidence.http.sourceOfTruth = {
    projectAReadyReason: sourceOfTruthA.readiness.reasonCode,
    projectAStateCleanup: sourceOfTruthA.runtimeControl.stateCleanup.activeState.cleaned,
    projectBReadyReason: sourceOfTruthB.readiness.reasonCode,
    projectBStateCleanup: sourceOfTruthB.runtimeControl.stateCleanup.activeState.cleaned,
  };
  evidence.http.openDashboard = {
    sameProjectAReusedDashboardUrl: openA.body.data.handoff.dashboardUrl === dashboardA,
    sameProjectBReusedDashboardUrl: openB.body.data.handoff.dashboardUrl === dashboardB,
  };
  evidence.http.switchToB = {
    dashboardOriginChanged: originOf(dashboardA) !== originOf(dashboardB),
    deferredStopProjectId: switchToB.body.data.deferredStopProject.projectId,
    oldApiStoppedAfterResponse: projectAStoppedAfterSwitch,
    previousActiveProjectId: switchToB.body.data.previousActiveProject?.projectId ?? null,
    targetProjectId: switchToB.body.data.targetProject.projectId,
    targetReady: switchToB.body.data.targetProject.daemon.ready,
    targetStatus: switchToB.body.data.targetProject.status,
  };
  evidence.http.stopB = {
    activeRuntimeProjectAfterAction: stopB.body.data.snapshot.activeRuntimeProject,
    selectedProjectAfterAction: stopB.body.data.snapshot.selectedProject?.projectId ?? null,
    selfApiStoppedAfterResponse: projectBStoppedAfterStop,
  };
  evidence.http.failurePath = {
    invalidSwitchStatus: invalidSwitch.status,
    invalidSwitchKeptActiveProjectId: currentAfterInvalid.body.data.activeRuntimeProject.projectId,
  };
  evidence.postConditions = {
    activeRuntimeProject: cliCurrentAfterStop.activeRuntimeProject,
    selectedProjectId: cliCurrentAfterStop.selectedProject.projectId,
    sourceOfTruthFailure: {
      blockedFallbacks: cliCurrentAfterStop.sourceOfTruth.failure.blockedFallbacks,
      reasonCode: cliCurrentAfterStop.sourceOfTruth.failure.reasonCode,
      stateCleanup: cliCurrentAfterStop.sourceOfTruth.runtimeControl.stateCleanup.activeState,
    },
  };

  smokeSucceeded = true;
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exitCode = 1;
} finally {
  const stopped = [];
  for (const projectId of [projectAId, projectBId].filter(Boolean)) {
    try {
      await runCli(['projects', 'stop', projectId, '--json', '--wait', '5000'], {
        parseJson: true,
      });
      stopped.push(projectId);
    } catch {
      /* best-effort cleanup */
    }
  }
  evidence.cleanup.stoppedProjectIds = stopped;
  try {
    rmSync(smokeRoot, { recursive: true, force: true });
    evidence.cleanup.removedSmokeRoot = true;
  } catch {
    evidence.cleanup.removedSmokeRoot = false;
  }
  if (smokeSucceeded) {
    process.stdout.write(`${JSON.stringify({ success: true, evidence }, null, 2)}\n`);
  }
}

function createProject(projectRoot, name) {
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'package.json'), `${JSON.stringify({ name }, null, 2)}\n`);
  writeFileSync(join(projectRoot, 'README.md'), `# ${name}\n`);
}

async function runCli(args, options) {
  let result;
  try {
    result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    throw new Error(
      `CLI command failed: alembic ${args.join(' ')}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
    );
  }
  const { stdout, stderr } = result;
  if (options.parseJson) {
    try {
      return JSON.parse(stdout);
    } catch (error) {
      throw new Error(
        `Failed to parse CLI JSON for ${args.join(' ')}: ${
          error instanceof Error ? error.message : String(error)
        }\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
      );
    }
  }
  return { stderr, stdout };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5000),
  });
  return {
    body: await response.json(),
    status: response.status,
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  });
  return {
    body: await response.json(),
    status: response.status,
  };
}

async function waitUntilUnreachable(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) });
    } catch {
      return true;
    }
    await sleep(100);
  }
  return false;
}

function findProject(snapshot, displayName) {
  const project = snapshot.projects.find((candidate) => candidate.displayName === displayName);
  assert(project, `project not found in snapshot: ${displayName}`);
  return project;
}

function requireString(value, label) {
  assert(typeof value === 'string' && value.length > 0, `${label} is missing`);
  return value;
}

function originOf(value) {
  return new URL(value).origin;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}
