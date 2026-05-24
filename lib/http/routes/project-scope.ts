import { resolveProjectRoot } from '@alembic/core/workspace';
import express, { type Request, type Response } from 'express';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import {
  createProjectScopeCapability,
  ProjectScopeRegistryStore,
  summarizeProjectScope,
} from '../../project-scope/ProjectScopeRegistry.js';

const router = express.Router();

router.get('/', (req: Request, res: Response): void => {
  const store = new ProjectScopeRegistryStore();
  const target = firstString(req.query.projectScopeId);
  const controlRoot = firstString(req.query.controlRoot);
  const folderPath = firstString(req.query.folderPath) ?? resolveProjectRoot(getServiceContainer());

  const scope = target
    ? store.getScope(target)
    : controlRoot
      ? store.findByControlRoot(controlRoot)
      : store.resolveFolder(folderPath)?.projectScope;

  if (!scope) {
    res.json({
      success: true,
      data: {
        capability: createProjectScopeCapability(true),
        projectScope: null,
        registryPath: store.registryPath,
        resolution: null,
        summary: null,
      },
    });
    return;
  }

  const resolved = store.resolveFolder(folderPath);
  res.json({
    success: true,
    data: {
      capability: createProjectScopeCapability(true),
      projectScope: scope,
      registryPath: store.registryPath,
      resolution:
        resolved?.projectScope.projectScopeId === scope.projectScopeId ? resolved.resolution : null,
      summary: summarizeProjectScope(scope),
    },
  });
});

router.get('/folders', (req: Request, res: Response): void => {
  const store = new ProjectScopeRegistryStore();
  const projectScopeId = firstString(req.query.projectScopeId);
  const controlRoot = firstString(req.query.controlRoot);
  const folderPath = firstString(req.query.folderPath) ?? resolveProjectRoot(getServiceContainer());
  const scope = projectScopeId
    ? store.getScope(projectScopeId)
    : controlRoot
      ? store.findByControlRoot(controlRoot)
      : store.resolveFolder(folderPath)?.projectScope;

  res.json({
    success: true,
    data: {
      capability: createProjectScopeCapability(true),
      folders: scope ? summarizeProjectScope(scope).folders : [],
      projectScopeId: scope?.projectScopeId ?? null,
      registryPath: store.registryPath,
    },
  });
});

router.post('/folders', (req: Request, res: Response): void => {
  const store = new ProjectScopeRegistryStore();
  const body = requestBody(req);
  const folderPath = firstString(body.folderPath, body.path);
  if (!folderPath) {
    res.status(400).json({ success: false, error: 'folderPath is required' });
    return;
  }

  try {
    const result = store.addFolder({
      controlRoot: firstString(body.controlRoot),
      displayName: firstString(body.displayName),
      folderPath,
      projectScopeId: firstString(body.projectScopeId),
      role: normalizeRole(body.role),
    });
    res.status(201).json({ success: true, data: result });
  } catch (error: unknown) {
    res.status(400).json({ success: false, error: errorMessage(error) });
  }
});

router.post('/resolve-folder', (req: Request, res: Response): void => {
  sendResolveFolder(res, requestBody(req));
});

router.get('/resolve-folder', (req: Request, res: Response): void => {
  sendResolveFolder(res, req.query);
});

function sendResolveFolder(res: Response, input: Record<string, unknown>): void {
  const folderPath = firstString(input.folderPath, input.path);
  if (!folderPath) {
    res.status(400).json({ success: false, error: 'folderPath is required' });
    return;
  }
  const store = new ProjectScopeRegistryStore();
  const result = store.resolveFolder(folderPath);
  res.json({
    success: true,
    data: {
      capability: createProjectScopeCapability(true),
      projectScope: result?.projectScope ?? null,
      registryPath: store.registryPath,
      resolution: result?.resolution ?? null,
      summary: result?.summary ?? null,
    },
  });
}

function requestBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

function normalizeRole(value: unknown): 'primary-source' | 'source' | null {
  return value === 'primary-source' || value === 'source' ? value : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default router;
