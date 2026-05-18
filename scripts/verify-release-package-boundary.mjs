#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');

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

for (const section of dependencySections) {
  const deps = packageJson[section];
  if (!deps || typeof deps !== 'object') {
    continue;
  }

  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string') {
      continue;
    }

    if (spec.startsWith('file:../')) {
      errors.push(
        `Root package ${section}.${name} uses ${spec}. Publish staging must replace workspace-local file dependencies with registry versions.`
      );
    }

    if (spec.startsWith('file:vendor/')) {
      errors.push(
        `Root package ${section}.${name} uses ${spec}. Vendor file dependencies are only allowed in portable embedded runtimes, not the Alembic root npm package.`
      );
    }
  }
}

const rootLockDeps = packageLock.packages?.['']?.dependencies ?? {};
for (const [name, spec] of Object.entries(rootLockDeps)) {
  if (typeof spec === 'string' && spec.startsWith('file:../')) {
    errors.push(
      `Root package-lock dependency ${name} uses ${spec}. Release staging must not publish with workspace-local lock metadata.`
    );
  }
}

for (const packagePath of Object.keys(packageLock.packages ?? {})) {
  if (packagePath.startsWith('../Alembic')) {
    warnings.push(
      `package-lock contains local workspace package entry ${packagePath}; this is valid for development but must be absent from a publish staging manifest.`
    );
  }
}

if (
  packageJson.name === 'alembic-ai' &&
  process.env.ALEMBIC_MAIN_NPM_PACKAGE_OWNER_CONFIRMED !== '1'
) {
  errors.push(
    'Root package name is alembic-ai, which is also used by AlembicPlugin. Set ALEMBIC_MAIN_NPM_PACKAGE_OWNER_CONFIRMED=1 only after the workspace release owner is explicitly resolved.'
  );
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

function writeLine(message) {
  process.stdout.write(`${message}\n`);
}

function writeError(message) {
  process.stderr.write(`${message}\n`);
}
