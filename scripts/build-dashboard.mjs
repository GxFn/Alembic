#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoRoot, resolveWorkspaceSource } from './workspace-source.mjs';

const dashboardSource = resolveWorkspaceSource({
  name: 'AlembicDashboard',
  localRelative: '../AlembicDashboard',
  vendorRelative: 'vendor/AlembicDashboard',
  requiredFile: 'package.json',
});
const dashboardRepo = dashboardSource.root;
const dashboardNodeModules = join(dashboardRepo, 'node_modules');
const dashboardDist = join(dashboardRepo, 'dist');
const targetDist = join(repoRoot, 'dashboard', 'dist');

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(join(dashboardRepo, 'package.json'))) {
  fail('Missing AlembicDashboard source. Expected ../AlembicDashboard or vendor/AlembicDashboard.');
}

if (!existsSync(dashboardNodeModules)) {
  fail(
    `Missing Dashboard dependencies. Run \`npm ci --prefix ${dashboardSource.displayPath}\` before \`npm run build:dashboard\`.`
  );
}

console.log(
  `Using ${dashboardSource.kind} AlembicDashboard source: ${dashboardSource.displayPath}`
);

const build = spawnSync('npm', ['--prefix', dashboardRepo, 'run', 'build'], {
  cwd: repoRoot,
  stdio: 'inherit',
});

if (build.error) {
  fail(`Failed to start Dashboard build: ${build.error.message}`);
}

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

if (!existsSync(join(dashboardDist, 'index.html'))) {
  fail(`Dashboard build did not produce ${dashboardSource.displayPath}/dist/index.html.`);
}

rmSync(targetDist, { recursive: true, force: true });
mkdirSync(dirname(targetDist), { recursive: true });
cpSync(dashboardDist, targetDist, { recursive: true });

if (!existsSync(join(targetDist, 'index.html'))) {
  fail('Dashboard asset copy did not produce dashboard/dist/index.html.');
}

console.log('Dashboard assets copied to dashboard/dist.');
