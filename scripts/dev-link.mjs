#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { repoRoot, resolveWorkspaceSource } from './workspace-source.mjs';

const packageJson = readJson(join(repoRoot, 'package.json'));

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

try {
  if (options.verifyOnly) {
    await verifyGlobalInstall({ dryRun: options.dryRun });
    detectDaemonProcesses({ dryRun: options.dryRun });
    process.exit(0);
  }

  preflight();

  await runStep('Build AlembicCore', 'npm', ['run', 'build:core']);
  await runStep('Build AlembicAgent', 'npm', [
    '--prefix',
    resolveAgentSource().root,
    'run',
    'build',
  ]);
  await runStep('Build Alembic package', 'npm', ['run', 'build:self']);
  verifyBuiltBins();

  if (options.skipDashboard) {
    log('Skipping Dashboard build (--skip-dashboard).');
  } else {
    await runStep('Build and copy Dashboard assets', 'npm', ['run', 'build:dashboard']);
    verifyDashboardAssets();
  }

  if (options.skipInstall) {
    log('Skipping global install and global smoke (--skip-install).');
  } else {
    await runStep('Install global alembic package', 'npm', ['install', '-g', '.']);
    await verifyGlobalInstall({ dryRun: options.dryRun });
  }

  detectDaemonProcesses({ dryRun: options.dryRun });
  log('dev:link complete.');
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

function parseArgs(args) {
  const parsed = {
    dryRun: false,
    help: false,
    skipDashboard: false,
    skipInstall: false,
    verbose: false,
    verifyOnly: false,
  };

  for (const arg of args) {
    if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--skip-dashboard') {
      parsed.skipDashboard = true;
    } else if (arg === '--skip-install') {
      parsed.skipInstall = true;
    } else if (arg === '--verbose') {
      parsed.verbose = true;
    } else if (arg === '--verify-only') {
      parsed.verifyOnly = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return parsed;
}

function printHelp() {
  process.stdout.write(`Usage: npm run dev:link -- [options]

Build local Alembic workspace packages and update the global development install.

Options:
  --dry-run          Print the steps without building, installing, or writing files.
  --skip-dashboard   Do not rebuild dashboard/dist.
  --skip-install     Build only; do not run npm install -g . or global smoke checks.
  --verify-only      Only verify the current global alembic install.
  --verbose          Print command cwd and elapsed time.
  -h, --help         Show this help.
`);
}

function preflight() {
  log('Preflight checks...');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    throw new Error(`Node.js >= 22 is required. Current version: ${process.versions.node}`);
  }

  ensureNodeModules(repoRoot, 'Run `npm ci` in the Alembic repository first.');
  ensureScript(packageJson, 'build:core', 'Alembic package.json');
  ensureScript(packageJson, 'build:self', 'Alembic package.json');
  ensureScript(packageJson, 'build:dashboard', 'Alembic package.json');

  const core = resolveWorkspaceSource({
    name: 'AlembicCore',
    localRelative: '../AlembicCore',
    vendorRelative: 'vendor/AlembicCore',
    requiredFile: 'package.json',
  });
  log(`Using ${core.kind} AlembicCore source: ${core.displayPath}`);

  const agent = resolveAgentSource();
  const agentPackage = readJson(join(agent.root, 'package.json'));
  ensureNodeModules(
    agent.root,
    `Missing AlembicAgent dependencies. Run \`npm ci --prefix ${agent.displayPath}\` first.`
  );
  ensureScript(agentPackage, 'build', `${agent.displayPath}/package.json`);
  log(`Using ${agent.kind} AlembicAgent source: ${agent.displayPath}`);

  if (!options.skipDashboard) {
    const dashboard = resolveWorkspaceSource({
      name: 'AlembicDashboard',
      localRelative: '../AlembicDashboard',
      vendorRelative: 'vendor/AlembicDashboard',
      requiredFile: 'package.json',
    });
    ensureNodeModules(
      dashboard.root,
      `Missing Dashboard dependencies. Run \`npm ci --prefix ${dashboard.displayPath}\` first.`
    );
    log(`Using ${dashboard.kind} AlembicDashboard source: ${dashboard.displayPath}`);
  }
}

function resolveAgentSource() {
  return resolveWorkspaceSource({
    name: 'AlembicAgent',
    localRelative: '../AlembicAgent',
    vendorRelative: 'vendor/AlembicAgent',
    requiredFile: 'package.json',
  });
}

function ensureScript(pkg, scriptName, label) {
  if (!pkg.scripts?.[scriptName]) {
    throw new Error(`Missing required script "${scriptName}" in ${label}.`);
  }
}

function ensureNodeModules(root, message) {
  if (!existsSync(join(root, 'node_modules'))) {
    throw new Error(message);
  }
}

async function runStep(label, command, args, { cwd = repoRoot } = {}) {
  const display = `${command} ${args.map(shellQuote).join(' ')}`;
  if (options.dryRun) {
    log(`[dry-run] ${label}: ${display}`);
    return;
  }

  log(`${label}: ${display}`);
  if (options.verbose) {
    log(`  cwd: ${relative(repoRoot, cwd) || '.'}`);
  }
  const started = Date.now();
  const child = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (child.error) {
    throw new Error(`Failed to start ${label}: ${child.error.message}`);
  }
  if (child.status !== 0) {
    throw new Error(`${label} failed with exit code ${child.status ?? 1}.`);
  }
  if (options.verbose) {
    log(`  done in ${Date.now() - started}ms`);
  }
}

function verifyBuiltBins() {
  if (options.dryRun) {
    log('[dry-run] Verify dist/bin shebangs.');
    return;
  }

  for (const file of ['dist/bin/cli.js']) {
    const path = join(repoRoot, file);
    if (!existsSync(path)) {
      throw new Error(`Missing built bin: ${file}`);
    }
    const head = readFileSync(path, 'utf8').slice(0, 2);
    if (head !== '#!') {
      throw new Error(`Built bin is missing shebang: ${file}`);
    }
  }
}

function verifyDashboardAssets() {
  if (options.dryRun) {
    log('[dry-run] Verify dashboard/dist/index.html.');
    return;
  }

  const indexPath = join(repoRoot, 'dashboard', 'dist', 'index.html');
  if (!existsSync(indexPath)) {
    throw new Error('Dashboard asset copy did not produce dashboard/dist/index.html.');
  }
}

async function verifyGlobalInstall({ dryRun }) {
  if (dryRun) {
    log('[dry-run] Verify global alembic command.');
    return;
  }

  const alembicPath = capture('sh', ['-lc', 'command -v alembic']).trim();
  if (!alembicPath) {
    throw new Error('Global command `alembic` was not found after install.');
  }

  const globalRoot = capture('npm', ['root', '-g']).trim();
  const globalPackage = join(globalRoot, packageJson.name);
  if (!existsSync(globalPackage)) {
    throw new Error(`Global package ${packageJson.name} was not found under ${globalRoot}.`);
  }

  const repoRealpath = realpathSync(repoRoot);
  const globalRealpath = realpathSync(globalPackage);
  if (globalRealpath !== repoRealpath) {
    throw new Error(
      `Global package ${packageJson.name} points to ${globalRealpath}, expected ${repoRealpath}. Run \`npm install -g .\` from this repository.`
    );
  }

  const version = capture('alembic', ['--version']).trim();
  log(`Global alembic: ${alembicPath}`);
  log(`Global package: ${globalPackage} -> ${globalRealpath}`);
  log(`alembic --version: ${version}`);
}

function detectDaemonProcesses({ dryRun }) {
  if (dryRun) {
    log('[dry-run] Check for running Alembic daemon processes.');
    return;
  }

  const result = spawnSync('ps', ['-axo', 'pid=,command='], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    log('Could not inspect daemon processes; skip daemon restart hint.');
    return;
  }

  const currentPid = String(process.pid);
  const matches = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith(currentPid))
    .filter((line) => /\balembic\b/.test(line))
    .filter((line) => /daemon-server\.js|\bdaemon\b|DaemonSupervisor/.test(line));

  if (matches.length === 0) {
    log('No running Alembic daemon process detected.');
    return;
  }

  log('Running Alembic daemon process detected. Restart it manually to pick up this dev link:');
  for (const line of matches) {
    log(`  ${line}`);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.error) {
    throw new Error(`Failed to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new Error(`${command} ${args.map(shellQuote).join(' ')} failed: ${detail}`);
  }
  return result.stdout;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function shellQuote(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : JSON.stringify(value);
}

function log(message) {
  process.stdout.write(`[dev:link] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[dev:link] ${message}\n`);
  process.exit(1);
}
