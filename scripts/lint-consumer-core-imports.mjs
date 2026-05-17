#!/usr/bin/env node
/**
 * Phase 8 consumer-side Core import boundary entrypoint.
 *
 * Prefer the Core-provided checker from the AlembicCore submodule, with an
 * installed package fallback for release-package verification.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const defaultArgs = ['.', '--config', 'config/core-import-boundary.json'];
const args = process.argv.slice(2).length > 0 ? process.argv.slice(2) : defaultArgs;

const coreCheckerCandidates = [
  join(repoRoot, 'vendor', 'AlembicCore', 'scripts', 'lint-consumer-core-imports.mjs'),
  join(repoRoot, 'node_modules', '@alembic', 'core', 'scripts', 'lint-consumer-core-imports.mjs'),
];

const coreChecker = coreCheckerCandidates.find((candidate) => existsSync(candidate));
if (coreChecker) {
  const result = spawnSync(process.execPath, [coreChecker, ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

console.error(
  '[lint:consumer-core-imports] Core checker not found in vendor/AlembicCore or node_modules/@alembic/core.'
);
process.exit(1);
