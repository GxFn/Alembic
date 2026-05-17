#!/usr/bin/env node
/**
 * Phase 1 Core public API boundary check.
 *
 * Existing @alembic/core imports are captured in config/core-import-boundary.json.
 * New specifiers must go through Core API boundary review before being added.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const boundaryConfigPath = join(repoRoot, 'config', 'core-import-boundary.json');
const scanRoots = ['bin', 'lib', 'scripts', 'test', 'config'];
const sourceFilePattern = /\.(?:cjs|js|mjs|mts|ts|tsx)$/;
const coreImportPattern =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](@alembic\/core(?:\/[^"')\s;]+)?)["']/g;

const boundaryConfig = JSON.parse(readFileSync(boundaryConfigPath, 'utf8'));
const allowedSpecifiers = new Set(boundaryConfig.allowedSpecifiers);

const filesOutput = execFileSync('git', ['ls-files', ...scanRoots], {
  cwd: repoRoot,
  encoding: 'utf8',
});

const files = filesOutput
  .trim()
  .split('\n')
  .filter((file) => sourceFilePattern.test(file));

const seenSpecifiers = new Set();
const violations = [];

for (const file of files) {
  const content = readFileSync(join(repoRoot, file), 'utf8');
  for (const match of content.matchAll(coreImportPattern)) {
    const specifier = match[1];
    seenSpecifiers.add(specifier);

    if (allowedSpecifiers.has(specifier)) {
      continue;
    }

    const line = content.slice(0, match.index).split('\n').length;
    violations.push({ file, line, specifier });
  }
}

if (violations.length > 0) {
  console.error('\nCore import boundary violations found:\n');
  console.error(
    'New @alembic/core specifiers require Core public API review before use in Alembic.'
  );
  console.error('For each new Core call, record the needed capability and target public entry.\n');

  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} ${violation.specifier}`);
  }

  console.error('\nIf approved, update config/core-import-boundary.json in the same change.');
  process.exit(1);
}

const staleSpecifiers = [...allowedSpecifiers].filter(
  (specifier) => !seenSpecifiers.has(specifier)
);

console.log(
  `Core import boundary check passed: ${seenSpecifiers.size} current specifier(s), ${staleSpecifiers.length} stale allowlist entries.`
);
