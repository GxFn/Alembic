#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const shouldRunDaemon = process.argv.includes('--daemon');
const shouldSkipBuild = process.argv.includes('--skip-build');
const packageJson = readJson(join(root, 'package.json'));

const steps = [
  ...(shouldSkipBuild
    ? []
    : [
        {
          name: 'Build runtime',
          command: 'npm',
          args: ['run', 'build'],
          verifies: ['dist/bin/codex-mcp.js', 'dist/bin/daemon-server.js'],
        },
        {
          name: 'Build Dashboard',
          command: 'npm',
          args: ['run', 'build:dashboard'],
          verifies: ['dashboard/dist/index.html'],
        },
      ]),
  {
    name: 'Prepare embedded Codex plugin runtime',
    command: 'npm',
    args: ['run', 'prepare:codex-plugin-runtime'],
    verifies: [
      'plugins/alembic-codex/runtime/package.json',
      'plugins/alembic-codex/runtime/dist/bin/codex-mcp.js',
      'plugins/alembic-codex/runtime/dashboard/dist/index.html',
    ],
  },
  {
    name: 'Verify Codex channel entry',
    command: 'npm',
    args: ['run', 'verify:codex-channel'],
    verifies: ['channels/codex/channel.json'],
  },
  {
    name: 'Verify Codex plugin metadata',
    command: 'npm',
    args: ['run', 'verify:codex-plugin'],
    verifies: [
      '.agents/plugins/marketplace.json',
      'plugins/alembic-codex/.codex-plugin/plugin.json',
      'plugins/alembic-codex/.mcp.json',
    ],
  },
  {
    name: 'Smoke package, local install, and MCP stdio',
    command: 'npm',
    args: ['run', 'smoke:codex-plugin'],
  },
  ...(shouldRunDaemon
    ? [
        {
          name: 'Smoke daemon startup and interrupted job recovery',
          command: 'npm',
          args: ['run', 'smoke:codex-plugin', '--', '--daemon'],
        },
      ]
    : []),
];

process.stdout.write(
  `Alembic Codex plugin release check (${packageJson.name}@${packageJson.version})\n`
);
process.stdout.write(`Daemon smoke: ${shouldRunDaemon ? 'enabled' : 'skipped'}\n\n`);

for (const [index, step] of steps.entries()) {
  const label = `${index + 1}/${steps.length} ${step.name}`;
  process.stdout.write(`==> ${label}\n`);
  run(step.command, step.args);
  for (const file of step.verifies || []) {
    const filePath = join(root, file);
    if (!existsSync(filePath)) {
      throw new Error(`${step.name} did not produce required file: ${file}`);
    }
  }
  process.stdout.write(`✓ ${label}\n\n`);
}

process.stdout.write('Codex plugin release check passed.\n');
if (!shouldRunDaemon) {
  process.stdout.write(
    'Optional: run npm run release:codex-plugin:daemon to include localhost daemon startup.\n'
  );
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HUSKY: '0',
    },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
