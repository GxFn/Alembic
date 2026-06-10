import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectRegistry } from '@alembic/core/workspace';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ProjectRuntimeControl } from '../../lib/daemon/ProjectRuntimeControl.js';
import projectsRouter from '../../lib/http/routes/projects.js';
import { getRouter, invokeRouter } from '../helpers/express.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;

function useTempAlembicHome(): void {
  process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-projects-route-'));
}

function makeProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-projects-route-project-'));
}

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
});

describe('projects route runtime source of truth', () => {
  test('GET /projects/current exposes read-only runtime source of truth', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, true);
    const control = new ProjectRuntimeControl();
    await control.selectProject({ projectId: entry.id });
    const beforeState = control.readState();

    const response = await getRouter(projectsRouter, '/api/v1/projects/current', {
      mountPath: '/api/v1/projects',
      timeoutMs: 3_000,
    });

    expect(response.status).toBe(200);
    const data = response.body.data as Record<string, unknown>;
    const sourceOfTruth = data.sourceOfTruth as Record<string, unknown>;
    expect(new ProjectRuntimeControl().readState()).toEqual(beforeState);
    expect(data.state).toMatchObject({
      activeProjectId: null,
      selectedProjectId: entry.id,
    });
    expect(sourceOfTruth).toMatchObject({
      owner: 'alembic',
      readiness: {
        reasonCode: 'daemon-not-running',
        status: 'stopped',
      },
      route: 'project-runtime-control',
      targetProject: {
        projectId: entry.id,
        selected: true,
        status: 'stopped',
      },
    });
    expect(sourceOfTruth.operation).toEqual({
      explicitRuntimeActionRequired: true,
      implicitRuntimeActionAllowed: false,
      mode: 'diagnostics-read',
      readOnly: true,
    });
    expect(sourceOfTruth.writePolicy).toMatchObject({
      activeStateWriteAllowed: false,
      daemonLifecycleWriteAllowed: false,
      projectScopeRegistryWriteAllowed: false,
      selectedStateWriteAllowed: false,
    });
  });

  test('POST project action returns a public projection with typed problem details', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, true);
    const snapshot = await new ProjectRuntimeControl().snapshot();
    const targetProject =
      snapshot.projects.find((project) => project.projectId === entry.id) ?? null;
    const actionResult = {
      action: 'switch',
      deferredStopProject: null,
      error: 'Target daemon did not become ready',
      handoff: targetProject
        ? {
            apiBaseUrl: null,
            dashboardUrl: null,
            projectId: targetProject.projectId,
            projectRoot: targetProject.projectRoot,
            status: targetProject.status,
          }
        : null,
      internalOnly: true,
      ok: false,
      previousActiveProject: null,
      snapshot,
      stoppedProject: null,
      targetProject,
    } satisfies Awaited<ReturnType<ProjectRuntimeControl['switchProject']>> & {
      internalOnly: boolean;
    };
    const switchSpy = vi
      .spyOn(ProjectRuntimeControl.prototype, 'switchProject')
      .mockResolvedValueOnce(actionResult);

    const response = await invokeRouter(projectsRouter, {
      body: { waitUntilReadyMs: 250 },
      method: 'POST',
      mountPath: '/api/v1/projects',
      path: `/api/v1/projects/${entry.id}/switch`,
      timeoutMs: 3_000,
    });

    expect(response.status).toBe(504);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toMatchObject({
      canonicalHttpStatus: 408,
      code: 'PROJECT_RUNTIME_TIMEOUT',
      detailExposureClass: 'diagnostic',
      exposureClass: 'public',
      failureId: 'core.failure.timeout',
      failureStatus: 'failed',
      message: 'Target daemon did not become ready',
      problemClass: 'time-problem',
      reasonCode: 'timeout',
      refPolicy: 'detailRef',
      retryPolicy: 'retryable',
      retryable: true,
      status: 504,
      taxonomyVersion: 1,
    });
    const data = response.body.data as Record<string, unknown>;
    expect(data).toMatchObject({
      action: 'switch',
      error: 'Target daemon did not become ready',
      ok: false,
    });
    expect(data.internalOnly).toBeUndefined();
    expect(switchSpy).toHaveBeenCalledWith(
      { projectId: entry.id },
      { deferSelfDaemonStop: true, restart: false, stopWaitMs: undefined, waitUntilReadyMs: 250 }
    );
  });

  test('POST project action no longer treats waitMs as public action wait alias', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, true);
    const snapshot = await new ProjectRuntimeControl().snapshot();
    const targetProject =
      snapshot.projects.find((project) => project.projectId === entry.id) ?? null;
    const actionResult = {
      action: 'switch',
      deferredStopProject: null,
      error: null,
      handoff: null,
      ok: true,
      previousActiveProject: null,
      snapshot,
      stoppedProject: null,
      targetProject,
    } satisfies Awaited<ReturnType<ProjectRuntimeControl['switchProject']>>;
    const switchSpy = vi
      .spyOn(ProjectRuntimeControl.prototype, 'switchProject')
      .mockResolvedValueOnce(actionResult);

    const response = await invokeRouter(projectsRouter, {
      body: { waitMs: 250 },
      method: 'POST',
      mountPath: '/api/v1/projects',
      path: `/api/v1/projects/${entry.id}/switch`,
      timeoutMs: 3_000,
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(switchSpy).toHaveBeenCalledWith(
      { projectId: entry.id },
      {
        deferSelfDaemonStop: true,
        restart: false,
        stopWaitMs: undefined,
        waitUntilReadyMs: undefined,
      }
    );
  });
});
