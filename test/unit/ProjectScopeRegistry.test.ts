import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectDescriptor, type ProjectScopeSummary } from '@alembic/core/shared';
import { getGhostWorkspaceDir } from '@alembic/core/workspace';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, test } from 'vitest';
import projectScopeRouter from '../../lib/http/routes/project-scope.js';
import {
  ProjectScopeRegistryStore,
  resolveAlembicDaemonPaths,
  resolveAlembicWorkspace,
} from '../../lib/project-scope/ProjectScopeRegistry.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const tempRoots: string[] = [];

afterEach(() => {
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

function useTempAlembicHome(): string {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-project-scope-home-'));
  process.env.ALEMBIC_HOME = tempHome;
  tempRoots.push(tempHome);
  return tempHome;
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function makeWorkspaceFolders(): { controlRoot: string; repoA: string; repoB: string } {
  const controlRoot = makeTempDir('alembic-project-scope-control-');
  const repoA = path.join(controlRoot, 'Alembic');
  const repoB = path.join(controlRoot, 'AlembicCore');
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });
  return { controlRoot, repoA, repoB };
}

describe('ProjectScopeRegistryStore', () => {
  test('persists ghost-only ProjectScope folders and resolves each folder to one dataRoot', () => {
    const alembicHome = useTempAlembicHome();
    const { controlRoot, repoA, repoB } = makeWorkspaceFolders();
    const store = new ProjectScopeRegistryStore({
      now: () => '2026-05-24T00:00:00.000Z',
    });

    const first = store.addFolder({
      controlRoot,
      displayName: 'Alembic workspace',
      folderPath: repoA,
      role: 'primary-source',
    });
    const second = store.addFolder({
      folderPath: repoB,
      projectScopeId: first.projectScope.projectScopeId,
    });

    expect(store.registryPath).toBe(path.join(alembicHome, '.asd', 'project-scopes.json'));
    expect(second.summary).toMatchObject({
      controlRoot,
      controlRootIncludedInFolders: false,
      dataRootSource: 'ghost-registry',
      displayName: 'Alembic workspace',
      folderCount: 2,
      projectRootWriteAllowed: false,
      standardWriteAllowed: false,
      storageKind: 'ghost',
    });
    expect(second.summary.dataRoot).toBe(getGhostWorkspaceDir(second.summary.projectId));
    expect(second.summary.folders.map((folder) => folder.path)).toEqual([repoA, repoB]);
    expect(second.summary.folders.map((folder) => folder.role)).toEqual([
      'primary-source',
      'source',
    ]);
    expect(second.summary.folders.some((folder) => folder.path === controlRoot)).toBe(false);

    const repoAWorkspace = resolveAlembicWorkspace(repoA).toFacts();
    const repoBWorkspace = resolveAlembicWorkspace(repoB).toFacts();
    expect(repoAWorkspace.projectScopeId).toBe(second.summary.projectScopeId);
    expect(repoBWorkspace.projectScopeId).toBe(second.summary.projectScopeId);
    expect(repoAWorkspace.dataRoot).toBe(second.summary.dataRoot);
    expect(repoBWorkspace.dataRoot).toBe(second.summary.dataRoot);

    const repoBPaths = resolveAlembicDaemonPaths(repoB);
    expect(repoBPaths).toMatchObject({
      dataRoot: second.summary.dataRoot,
      jobsDir: path.join(second.summary.dataRoot, '.asd', 'jobs'),
      projectId: second.summary.projectId,
      projectRoot: repoB,
    });

    const controlRootResolution = store.resolveFolder(controlRoot);
    expect(controlRootResolution?.summary.projectScopeId).toBe(second.summary.projectScopeId);
    expect(controlRootResolution?.resolution?.matched).toBe(false);
  });

  test('rejects controlRoot folders and standard ProjectScope storage', () => {
    useTempAlembicHome();
    const { controlRoot } = makeWorkspaceFolders();
    const store = new ProjectScopeRegistryStore();

    expect(() => store.addFolder({ controlRoot, folderPath: controlRoot })).toThrow(
      /controlRoot cannot be included in folders/
    );

    expect(() =>
      createProjectDescriptor({
        controlRoot,
        dataRoot: path.join(controlRoot, '.asd-standard'),
        folders: [],
        storage: {
          dataRoot: path.join(controlRoot, '.asd-standard'),
          kind: 'standard' as never,
        },
      })
    ).toThrow(/Ghost-only/);
  });
});

describe('ProjectScope HTTP routes', () => {
  test('exposes add, list and resolve endpoints with Core ProjectScope telemetry', () => {
    useTempAlembicHome();
    const { controlRoot, repoA, repoB } = makeWorkspaceFolders();
    const addResponse = invokeProjectScopeRoute('post', '/folders', {
      body: {
        controlRoot,
        folderPath: repoA,
        role: 'primary-source',
      },
    });
    const addPayload = addResponse.body as {
      data: { summary: ProjectScopeSummary };
      success: boolean;
    };
    expect(addResponse.statusCode).toBe(201);
    expect(addPayload.success).toBe(true);
    expect(addPayload.data.summary.storageKind).toBe('ghost');

    const addSecondResponse = invokeProjectScopeRoute('post', '/folders', {
      body: {
        folderPath: repoB,
        projectScopeId: addPayload.data.summary.projectScopeId,
      },
    });
    expect(addSecondResponse.statusCode).toBe(201);

    const listResponse = invokeProjectScopeRoute('get', '/folders', {
      query: { projectScopeId: addPayload.data.summary.projectScopeId },
    });
    const listPayload = listResponse.body as {
      data: { folders: ProjectScopeSummary['folders']; projectScopeId: string };
      success: boolean;
    };
    expect(listPayload.data.projectScopeId).toBe(addPayload.data.summary.projectScopeId);
    expect(listPayload.data.folders.map((folder) => folder.path)).toEqual([repoA, repoB]);

    const resolveResponse = invokeProjectScopeRoute('post', '/resolve-folder', {
      body: { folderPath: repoB },
    });
    const resolvePayload = resolveResponse.body as {
      data: { summary: ProjectScopeSummary };
      success: boolean;
    };
    expect(resolvePayload.data.summary.projectScopeId).toBe(addPayload.data.summary.projectScopeId);
    expect(resolvePayload.data.summary.currentFolderPath).toBe(repoB);
    expect(resolvePayload.data.summary.dataRootSource).toBe('ghost-registry');
  });
});

type ProjectScopeRouteMethod = 'get' | 'post';

interface ProjectScopeRouterLayer {
  route?: {
    methods: Partial<Record<ProjectScopeRouteMethod, boolean>>;
    path: string;
    stack: Array<{ handle: (req: Request, res: Response) => void }>;
  };
}

interface MockRouteResponse {
  body: unknown;
  statusCode: number;
}

function invokeProjectScopeRoute(
  method: ProjectScopeRouteMethod,
  routePath: string,
  input: { body?: Record<string, unknown>; query?: Record<string, unknown> } = {}
): MockRouteResponse {
  const layer = (
    projectScopeRouter as unknown as {
      stack: ProjectScopeRouterLayer[];
    }
  ).stack.find(
    (candidate) => candidate.route?.path === routePath && candidate.route.methods[method]
  );
  const handler = layer?.route?.stack[0]?.handle;
  if (!handler) {
    throw new Error(`ProjectScope route not found: ${method.toUpperCase()} ${routePath}`);
  }
  const response = createMockResponse();
  handler(
    {
      body: input.body ?? {},
      query: input.query ?? {},
    } as Request,
    response as unknown as Response
  );
  return {
    body: response.body,
    statusCode: response.statusCode,
  };
}

function createMockResponse() {
  return {
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    statusCode: 200,
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}
