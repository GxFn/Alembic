#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { repoRoot, resolveWorkspaceSource } from './workspace-source.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const command = process.argv[2];
const extraArgs = process.argv.slice(3);

const core = resolveWorkspaceSource({
  name: 'AlembicCore',
  localRelative: '../AlembicCore',
  vendorRelative: 'vendor/AlembicCore',
  requiredFile: 'package.json',
});

console.log(`Using ${core.kind} AlembicCore source: ${core.displayPath}`);

let child;
if (command === 'build') {
  child = spawnSync('tsc', ['-p', join(core.root, 'tsconfig.json'), ...extraArgs], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
} else if (command === 'lint-consumer-imports') {
  child = spawnSync(
    'node',
    [
      join(core.root, 'scripts/lint-consumer-core-imports.mjs'),
      '.',
      '--config',
      'config/core-import-boundary.json',
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      stdio: 'inherit',
    }
  );
} else {
  fail('Usage: core-source-command.mjs <build|lint-consumer-imports> [...args]');
}

if (child.error) {
  fail(`Failed to run ${command}: ${child.error.message}`);
}

process.exit(child.status ?? 1);
