import { describe, expect, test } from 'vitest';
import fileChangesRouter from '../../lib/http/routes/file-changes.js';
import logsRouter from '../../lib/http/routes/logs.js';
import projectScopeRouter from '../../lib/http/routes/project-scope.js';
import projectsRouter from '../../lib/http/routes/projects.js';
import recipesRouter from '../../lib/http/routes/recipes.js';
import signalsRouter from '../../lib/http/routes/signals.js';
import violationsRouter from '../../lib/http/routes/violations.js';
import wikiRouter from '../../lib/http/routes/wiki.js';
import { getRouter, invokeRouter } from '../helpers/express.js';

describe('AO1 HTTP route input validation', () => {
  test('logs route rejects invalid file selector before reading logs', async () => {
    const response = await getRouter(logsRouter, '/api/v1/logs?file=../../secret', {
      mountPath: '/api/v1/logs',
    });

    expectValidationError(response.status, response.body);
  });

  test('project-scope write route rejects invalid role value', async () => {
    const response = await invokeRouter(projectScopeRouter, {
      body: { folderPath: '/tmp/project', role: 'owner' },
      method: 'POST',
      mountPath: '/api/v1/project-scope',
      path: '/api/v1/project-scope/folders',
    });

    expectValidationError(response.status, response.body);
  });

  test('projects runtime action rejects invalid wait option instead of ignoring it', async () => {
    const response = await invokeRouter(projectsRouter, {
      body: { waitUntilReadyMs: 'abc' },
      method: 'POST',
      mountPath: '/api/v1/projects',
      path: '/api/v1/projects/example/switch',
    });

    expectValidationError(response.status, response.body);
  });

  test('recipes relation discovery rejects invalid batch size', async () => {
    const response = await invokeRouter(recipesRouter, {
      body: { batchSize: 'abc' },
      method: 'POST',
      mountPath: '/api/v1/recipes',
      path: '/api/v1/recipes/discover-relations',
    });

    expectValidationError(response.status, response.body);
  });

  test('signals route rejects invalid numeric window', async () => {
    const response = await getRouter(signalsRouter, '/api/v1/signals/trace?from=abc', {
      mountPath: '/api/v1/signals',
    });

    expectValidationError(response.status, response.body);
  });

  test('violations route rejects invalid pagination', async () => {
    const response = await getRouter(violationsRouter, '/api/v1/violations?page=abc', {
      mountPath: '/api/v1/violations',
    });

    expectValidationError(response.status, response.body);
  });

  test('wiki no-input write route rejects non-object bodies', async () => {
    const response = await invokeRouter(wikiRouter, {
      body: [],
      method: 'POST',
      mountPath: '/api/v1/wiki',
      path: '/api/v1/wiki/abort',
    });

    expectValidationError(response.status, response.body);
  });

  test('file-changes route rejects missing events through the shared validation envelope', async () => {
    const response = await invokeRouter(fileChangesRouter, {
      body: {},
      method: 'POST',
      mountPath: '/api/v1/file-changes',
      path: '/api/v1/file-changes',
    });

    expectValidationError(response.status, response.body);
  });
});

function expectValidationError(status: number, body: Record<string, unknown>): void {
  expect(status).toBe(400);
  expect(body.success).toBe(false);
  expect(body.error).toMatchObject({ code: 'VALIDATION_ERROR' });
}
