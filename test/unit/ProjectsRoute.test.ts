import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectRegistry } from '@alembic/core/workspace';
import { afterEach, describe, expect, test } from 'vitest';
import { ProjectRuntimeControl } from '../../lib/daemon/ProjectRuntimeControl.js';
import projectsRouter from '../../lib/http/routes/projects.js';
import { getRouter } from '../helpers/express.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;

function useTempAlembicHome(): void {
  process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-projects-route-'));
}

function makeProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-projects-route-project-'));
}

afterEach(() => {
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
});
