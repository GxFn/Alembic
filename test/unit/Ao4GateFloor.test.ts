import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createDashboardArtifactMetadata,
  verifyDashboardArtifactFreshness,
  writeDashboardArtifactMetadata,
} from '../../scripts/dashboard-artifact-metadata.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('AO4 gate floor', () => {
  test('main check pipeline runs repo-boundary, unit, and integration gates', () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const check = String(packageJson.scripts.check);

    expect(check).toContain('npm run lint:repo-boundary');
    expect(check).toContain('npm run test:unit');
    expect(check).toContain('npm run test:integration');
    expect(check).toContain('npm run test:coverage');
  });

  test('escape-hatch shrink-only ratchet reports baseline and fails on growth', () => {
    const pass = spawnSync(process.execPath, ['scripts/lint-repo-boundary.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(pass.status).toBe(0);
    expect(pass.stdout).toContain('shrink-only baseline: 1');

    const fail = spawnSync(process.execPath, ['scripts/lint-repo-boundary.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ALEMBIC_ESCAPE_HATCH_BASELINE: '0' },
    });
    expect(fail.status).toBe(1);
    expect(fail.stderr).toContain('exceeds shrink-only baseline');
  });

  test('Dashboard artifact freshness detects stale source metadata', () => {
    const artifactDir = tempRoot('alembic-ao4-dashboard-dist-');
    writeFileSync(join(artifactDir, 'index.html'), '<!doctype html><title>Alembic</title>\n');
    const source = {
      commit: 'dashboard-commit-a',
      dirty: false,
      displayPath: '../AlembicDashboard',
      kind: 'local',
      packageName: 'alembic-dashboard',
      packageVersion: '0.2.0',
      sourceFingerprint: 'fingerprint-a',
    };
    writeDashboardArtifactMetadata(
      artifactDir,
      createDashboardArtifactMetadata({ generatedAt: '2026-06-12T00:00:00.000Z', source })
    );

    expect(verifyDashboardArtifactFreshness({ artifactDir, expectedSource: source })).toMatchObject(
      { ok: true }
    );
    expect(
      verifyDashboardArtifactFreshness({
        artifactDir,
        expectedSource: { ...source, sourceFingerprint: 'fingerprint-b' },
      })
    ).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('source.sourceFingerprint')],
    });
  });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
}
