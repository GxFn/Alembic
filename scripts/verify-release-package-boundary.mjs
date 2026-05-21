#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');
const stagingPackagePath = join('.release', 'alembic-ai', 'package.json');
const stagingSourcePath = join('.release', 'alembic-ai', 'alembic-release-source.json');
const stagingPackage = readOptionalJson(stagingPackagePath);
const stagingSource = readOptionalJson(stagingSourcePath);

const dependencySections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundleDependencies',
  'bundledDependencies',
];

const errors = [];
const warnings = [];

if (packageJson.name !== 'alembic-ai') {
  errors.push(
    `Root package name must remain alembic-ai because the workspace publish owner decision assigns that npm package to Alembic; found ${String(packageJson.name)}.`
  );
}

// Root manifest 是开发态入口，必须保留 workspace-local file 依赖；发布边界真正落在
// `.release/alembic-ai` staging manifest，由 `release:staging:prepare` 负责替换为 registry 版本。
for (const [name, spec] of Object.entries(packageJson.dependencies ?? {})) {
  if (
    (name === '@alembic/core' || name === '@alembic/agent') &&
    (typeof spec !== 'string' || !spec.startsWith('file:../'))
  ) {
    errors.push(
      `Root development dependency ${name} must stay workspace-local before staging; found ${String(spec)}.`
    );
  }
}

if (!stagingPackage) {
  errors.push(
    `Missing ${stagingPackagePath}. Run npm run release:staging:prepare before release:package-guard.`
  );
} else {
  verifyPackageManifest('Staging package', stagingPackage, { forbidLocalFileDependencies: true });

  if (stagingPackage.name !== 'alembic-ai') {
    errors.push(
      `Staging package name must remain alembic-ai; found ${String(stagingPackage.name)}.`
    );
  }

  if (stagingPackage.version !== packageJson.version) {
    errors.push(
      `Staging package version ${String(stagingPackage.version)} does not match root version ${String(packageJson.version)}.`
    );
  }

  for (const dependencyName of ['@alembic/core', '@alembic/agent']) {
    const spec = stagingPackage.dependencies?.[dependencyName];
    if (typeof spec !== 'string' || spec.startsWith('file:')) {
      errors.push(
        `Staging package dependencies.${dependencyName} must be a registry version, found ${String(spec)}.`
      );
    }
  }
}

if (!stagingSource) {
  errors.push(
    `Missing ${stagingSourcePath}. Run npm run release:staging:prepare before release:package-guard.`
  );
} else {
  if (stagingSource.packageName !== packageJson.name) {
    errors.push(
      `Release source packageName ${String(stagingSource.packageName)} does not match root package ${String(packageJson.name)}.`
    );
  }

  if (stagingSource.packageVersion !== packageJson.version) {
    errors.push(
      `Release source packageVersion ${String(stagingSource.packageVersion)} does not match root version ${String(packageJson.version)}.`
    );
  }

  for (const dependencyName of ['@alembic/core', '@alembic/agent']) {
    const metadataVersion = stagingSource.registryDependencies?.[dependencyName];
    const stagingVersion = stagingPackage?.dependencies?.[dependencyName];
    if (metadataVersion !== stagingVersion) {
      errors.push(
        `Release source registryDependencies.${dependencyName}=${String(metadataVersion)} does not match staging dependency ${String(stagingVersion)}.`
      );
    }
  }

  for (const sourceName of ['Alembic', 'AlembicCore', 'AlembicAgent', 'AlembicDashboard']) {
    const source = stagingSource.sources?.[sourceName];
    if (!source?.commit) {
      errors.push(`Release source metadata missing ${sourceName}.commit.`);
    }
  }
}

for (const packagePath of Object.keys(packageLock.packages ?? {})) {
  if (packagePath.startsWith('../Alembic')) {
    warnings.push(
      `package-lock contains local workspace package entry ${packagePath}; this is valid for development and must not be copied into the publish staging manifest.`
    );
  }
}

if (errors.length > 0) {
  writeError('Release package boundary check failed.');
  for (const error of errors) {
    writeError(`- ${error}`);
  }
  if (warnings.length > 0) {
    writeError('Warnings:');
    for (const warning of warnings) {
      writeError(`- ${warning}`);
    }
  }
  process.exit(1);
}

writeLine('Release package boundary check passed.');
if (warnings.length > 0) {
  writeLine('Warnings:');
  for (const warning of warnings) {
    writeLine(`- ${warning}`);
  }
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), 'utf8'));
}

function readOptionalJson(relativePath) {
  const absolutePath = join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    return null;
  }
  return JSON.parse(readFileSync(absolutePath, 'utf8'));
}

function verifyPackageManifest(label, manifest, options) {
  for (const section of dependencySections) {
    const deps = manifest[section];
    if (!deps || typeof deps !== 'object') {
      continue;
    }

    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string') {
        continue;
      }

      if (options.forbidLocalFileDependencies && spec.startsWith('file:../')) {
        errors.push(`${label} ${section}.${name} uses workspace-local dependency ${spec}.`);
      }

      if (spec.startsWith('file:vendor/')) {
        errors.push(
          `${label} ${section}.${name} uses ${spec}. Vendor file dependencies are only allowed in portable embedded runtimes, not the Alembic npm publish package.`
        );
      }
    }
  }
}

function writeLine(message) {
  process.stdout.write(`${message}\n`);
}

function writeError(message) {
  process.stderr.write(`${message}\n`);
}
