import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  buildCodexProjectRootRequiredMessage,
  getCodexSavedProjectRootPath,
  readCodexSavedProjectRoot,
  resolveCodexProjectRoot,
  summarizeCodexProjectRootResolution,
  writeCodexSavedProjectRoot,
} from '../../lib/codex/ProjectRootResolver.js';

function makeDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('CodexProjectRootResolver', () => {
  test('trusts explicit projectRoot', () => {
    const projectRoot = makeDir('codex-root-explicit-');

    const resolution = resolveCodexProjectRoot({ projectRoot });

    expect(resolution).toMatchObject({
      path: projectRoot,
      source: 'explicit-option',
      trust: 'trusted',
      rejected: false,
    });
  });

  test('saves and reuses an explicit projectRoot', () => {
    const projectRoot = makeDir('codex-root-saved-');
    const alembicHome = makeDir('codex-home-saved-');
    const env = { ALEMBIC_HOME: alembicHome } as NodeJS.ProcessEnv;

    const saved = writeCodexSavedProjectRoot(projectRoot, env);
    const resolution = resolveCodexProjectRoot({ env });

    expect(fs.existsSync(getCodexSavedProjectRootPath(env))).toBe(true);
    expect(readCodexSavedProjectRoot(env)).toMatchObject({
      projectRoot,
      source: 'explicit-projectRoot',
    });
    expect(saved.projectRoot).toBe(projectRoot);
    expect(resolution).toMatchObject({
      path: projectRoot,
      source: 'saved-project-root',
      trust: 'trusted',
      rejected: false,
    });
  });

  test('trusts Alembic and Codex workspace environment variables', () => {
    const alembicRoot = makeDir('codex-root-alembic-');
    const codexRoot = makeDir('codex-root-codex-');
    const workspaceRoot = makeDir('codex-root-workspace-');

    expect(resolveCodexProjectRoot({ env: { ALEMBIC_PROJECT_DIR: alembicRoot } }).source).toBe(
      'ALEMBIC_PROJECT_DIR'
    );
    expect(resolveCodexProjectRoot({ env: { CODEX_WORKSPACE_DIR: codexRoot } }).source).toBe(
      'CODEX_WORKSPACE_DIR'
    );
    expect(resolveCodexProjectRoot({ env: { CODEX_WORKSPACE_ROOT: workspaceRoot } }).source).toBe(
      'CODEX_WORKSPACE_ROOT'
    );
  });

  test('reports fallback roots without trusting them for initialization', () => {
    const projectRoot = makeDir('codex-root-fallback-');
    const alembicHome = makeDir('codex-home-fallback-');

    const resolution = resolveCodexProjectRoot({
      env: { ALEMBIC_HOME: alembicHome, PWD: projectRoot },
    });

    expect(resolution).toMatchObject({
      path: projectRoot,
      source: 'PWD',
      trust: 'fallback',
      rejected: false,
    });
    expect(buildCodexProjectRootRequiredMessage(resolution)).toContain(
      'cannot determine the target project directory'
    );
  });

  test('rejects Codex plugin cache paths', () => {
    const alembicHome = makeDir('codex-home-cache-');
    const cacheRoot = path.join(
      makeDir('codex-home-'),
      '.codex',
      'plugins',
      'cache',
      'gxfn',
      'alembic-codex',
      '0.1.1'
    );
    fs.mkdirSync(cacheRoot, { recursive: true });

    const resolution = resolveCodexProjectRoot({
      env: { ALEMBIC_HOME: alembicHome, PWD: cacheRoot },
    });

    expect(resolution).toMatchObject({
      path: cacheRoot,
      source: 'PWD',
      trust: 'rejected',
      rejected: true,
    });
    expect(resolution.reason).toContain('plugin cache');
    expect(summarizeCodexProjectRootResolution(resolution)).toMatchObject({
      requiredActions: expect.arrayContaining([
        'Provide the target project root as an absolute path.',
      ]),
      userMessage: expect.stringContaining('project workflows cannot be used yet'),
    });
  });

  test('rejects missing directories', () => {
    const missingRoot = path.join(makeDir('codex-root-missing-parent-'), 'missing-project');

    const resolution = resolveCodexProjectRoot({ projectRoot: missingRoot });

    expect(resolution).toMatchObject({
      path: missingRoot,
      source: 'explicit-option',
      trust: 'rejected',
      rejected: true,
    });
    expect(resolution.reason).toContain('does not exist');
  });
});
