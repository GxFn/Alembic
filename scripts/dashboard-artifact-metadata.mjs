#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, resolveWorkspaceSource } from './workspace-source.mjs';

export const DASHBOARD_ARTIFACT_METADATA_FILE = 'alembic-dashboard-source.json';

export function resolveDashboardSource() {
  const source = resolveWorkspaceSource({
    name: 'AlembicDashboard',
    localRelative: '../AlembicDashboard',
    vendorRelative: 'vendor/AlembicDashboard',
    requiredFile: 'package.json',
  });
  const packageJson = readJson(join(source.root, 'package.json'));
  return {
    ...source,
    commit: git(source.root, ['rev-parse', 'HEAD']),
    dirty: git(source.root, ['status', '--short']).trim().length > 0,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    sourceFingerprint: sourceFingerprint(source.root),
  };
}

export function createDashboardArtifactMetadata({
  generatedAt = new Date().toISOString(),
  source = resolveDashboardSource(),
} = {}) {
  return {
    schemaVersion: 1,
    artifactKind: 'alembic-dashboard-dist',
    generatedAt,
    source: {
      commit: source.commit,
      dirty: Boolean(source.dirty),
      displayPath: source.displayPath,
      kind: source.kind,
      packageName: source.packageName,
      packageVersion: source.packageVersion,
      sourceFingerprint: source.sourceFingerprint,
    },
  };
}

export function writeDashboardArtifactMetadata(artifactDir, metadata) {
  writeFileSync(
    join(artifactDir, DASHBOARD_ARTIFACT_METADATA_FILE),
    `${JSON.stringify(metadata, null, 2)}\n`
  );
}

export function readDashboardArtifactMetadata(artifactDir) {
  const metadataPath = join(artifactDir, DASHBOARD_ARTIFACT_METADATA_FILE);
  if (!existsSync(metadataPath)) {
    return null;
  }
  return readJson(metadataPath);
}

export function verifyDashboardArtifactFreshness({
  artifactDir = join(repoRoot, 'dashboard', 'dist'),
  expectedSource = resolveDashboardSource(),
} = {}) {
  const errors = [];
  if (!existsSync(join(artifactDir, 'index.html'))) {
    errors.push(`Missing dashboard artifact index: ${displayPath(artifactDir)}/index.html`);
  }

  const metadata = readDashboardArtifactMetadata(artifactDir);
  if (!metadata) {
    errors.push(
      `Missing dashboard artifact metadata: ${displayPath(artifactDir)}/${DASHBOARD_ARTIFACT_METADATA_FILE}`
    );
    return { errors, metadata: null, ok: false };
  }

  if (metadata.schemaVersion !== 1 || metadata.artifactKind !== 'alembic-dashboard-dist') {
    errors.push('Dashboard artifact metadata has an unsupported schema or artifact kind.');
  }

  const metadataSource = metadata.source ?? {};
  const checks = [
    ['kind', expectedSource.kind],
    ['displayPath', expectedSource.displayPath],
    ['packageName', expectedSource.packageName],
    ['packageVersion', expectedSource.packageVersion],
    ['commit', expectedSource.commit],
    ['sourceFingerprint', expectedSource.sourceFingerprint],
  ];
  for (const [field, expected] of checks) {
    if (metadataSource[field] !== expected) {
      errors.push(
        `Dashboard artifact stale: source.${field} expected ${String(expected)}, found ${String(metadataSource[field])}.`
      );
    }
  }

  return { errors, metadata, ok: errors.length === 0 };
}

function sourceFingerprint(sourceRoot) {
  const files = git(sourceRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter((filePath) => filePath.length > 0)
    .filter((filePath) => !filePath.startsWith('dist/'))
    .filter((filePath) => !filePath.startsWith('node_modules/'))
    .filter((filePath) => !filePath.startsWith('.git/'))
    .sort();
  const hash = createHash('sha256');
  for (const filePath of files) {
    hash.update(filePath);
    hash.update('\0');
    hash.update(readFileSync(join(sourceRoot, filePath)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function git(repoPath, args) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function displayPath(path) {
  return path.startsWith(`${repoRoot}/`) ? path.slice(repoRoot.length + 1) : path;
}
