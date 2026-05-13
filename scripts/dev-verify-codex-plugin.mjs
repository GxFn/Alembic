#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(import.meta.dirname, '..');
const options = parseArgs(process.argv.slice(2));
const tmpRoot = mkdtempSync(join(tmpdir(), 'alembic-codex-dev-verify-'));
const report = {
  ok: false,
  mode: options.localMcp ? 'local-mcp' : 'packaged-runtime',
  projectRoot: options.projectRoot,
  steps: [],
  synced: null,
  probes: [],
};

try {
  if (!options.probeOnly) {
    if (!options.skipBuild) {
      runStep('build', 'npm', ['run', 'build']);
      runStep('build:dashboard', 'npm', ['run', 'build:dashboard']);
    }
    if (!options.skipTests) {
      runStep('unit project-root and init gates', 'npx', [
        'vitest',
        'run',
        'test/unit/CodexProjectRootResolver.test.ts',
        'test/unit/CodexMcpServer.test.ts',
        'test/unit/CodexToolPolicy.test.ts',
      ]);
    }
    if (!options.skipPrepare) {
      runStep('prepare codex plugin runtime', 'npm', ['run', 'prepare:codex-plugin-runtime']);
    }
    if (!options.skipVerify) {
      runStep('verify codex plugin metadata', 'npm', ['run', 'verify:codex-plugin']);
    }
    if (!options.skipSmoke) {
      const smokeArgs = ['run', 'smoke:codex-plugin', '--'];
      if (!options.withNpxRuntime) {
        smokeArgs.push('--no-npx-runtime');
      }
      runStep('smoke codex plugin', 'npm', smokeArgs);
    }
  }

  if (!options.noSync && !options.probeOnly) {
    report.synced = runSync();
  }

  const targets = options.probeTargets.length > 0 ? options.probeTargets : readSyncedTargets();
  if (targets.length === 0) {
    throw new Error('No installed Alembic Codex plugin cache targets were found to probe.');
  }
  for (const target of targets) {
    report.probes.push(await probeInstalledTarget(target));
  }

  report.ok = true;
  printReport();
} finally {
  if (options.keepTmp) {
    console.error(`Alembic Codex dev verify temp kept at ${tmpRoot}`);
  } else {
    rmSync(tmpRoot, { force: true, recursive: true });
  }
}

function runSync() {
  const args = ['scripts/sync-codex-plugin-cache.mjs', '--clean', '--all-installed'];
  if (options.localMcp) {
    args.push('--local-mcp');
  }
  if (options.codexHome) {
    args.push('--codex-home', options.codexHome);
  }
  for (const target of options.syncTargets) {
    args.push('--target-root', target);
  }
  const result = runStep('sync codex plugin cache', process.execPath, args, { capture: true });
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Could not parse sync summary: ${error.message}\n${result.stdout}`);
  }
}

function readSyncedTargets() {
  if (report.synced && Array.isArray(report.synced.targetRoots)) {
    return report.synced.targetRoots;
  }
  const plugin = readJson(join(root, 'plugins', 'alembic-codex', '.codex-plugin', 'plugin.json'));
  const cacheRoot = resolve(options.codexHome || join(process.env.HOME || '', '.codex'));
  return [
    join(cacheRoot, 'plugins', 'cache', 'alembic-codex', plugin.name, plugin.version),
    join(cacheRoot, 'plugins', 'cache', 'gxfn', plugin.name, plugin.version),
  ].filter((target) => existsSync(join(target, '.mcp.json')));
}

async function probeInstalledTarget(targetRoot) {
  const marker = existsSync(join(targetRoot, '.alembic-dev-refresh.json'))
    ? readJson(join(targetRoot, '.alembic-dev-refresh.json'))
    : null;
  const savedHome = join(tmpRoot, `home-${report.probes.length}`);
  const failedHome = join(tmpRoot, `failed-home-${report.probes.length}`);
  const first = await callMcpStatus(targetRoot, savedHome, { projectRoot: options.projectRoot });
  assertProbe(
    first.projectRootResolution?.source === 'explicit-option' &&
      first.projectRootResolution?.trust === 'trusted',
    `Explicit projectRoot was not trusted for ${targetRoot}: ${JSON.stringify(first.projectRootResolution)}`
  );
  const saved = await callMcpStatus(targetRoot, savedHome, {});
  assertProbe(
    saved.projectRoot === options.projectRoot &&
      saved.projectRootResolution?.source === 'saved-project-root' &&
      saved.projectRootResolution?.trust === 'trusted',
    `Saved projectRoot was not reused for ${targetRoot}: ${JSON.stringify(saved.projectRootResolution)}`
  );
  const failClosed = await callMcpTool(targetRoot, failedHome, 'alembic_codex_init', {});
  assertProbe(
    failClosed.success === false &&
      ['CODEX_PROJECT_ROOT_REJECTED', 'CODEX_PROJECT_ROOT_UNRESOLVED'].includes(
        failClosed.data?.errorCode
      ),
    `Missing projectRoot did not fail closed for ${targetRoot}: ${JSON.stringify(failClosed)}`
  );
  return {
    targetRoot,
    marker,
    explicit: summarizeStatus(first),
    saved: summarizeStatus(saved),
    failClosed: {
      success: failClosed.success,
      errorCode: failClosed.data?.errorCode || null,
      needsUserInput: failClosed.data?.needsUserInput === true,
    },
  };
}

async function callMcpStatus(targetRoot, alembicHome, args) {
  const result = await callMcpTool(targetRoot, alembicHome, 'alembic_codex_status', args);
  assertProbe(result.success === true, `alembic_codex_status failed: ${JSON.stringify(result)}`);
  return result.data;
}

async function callMcpTool(targetRoot, alembicHome, name, args) {
  const mcp = readJson(join(targetRoot, '.mcp.json'));
  const server = mcp.mcpServers?.alembic;
  if (!server?.command || !Array.isArray(server.args)) {
    throw new Error(`Invalid .mcp.json at ${targetRoot}`);
  }
  const stderr = [];
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd: targetRoot,
    env: sanitizeEnv({
      ...process.env,
      ...(server.env || {}),
      ALEMBIC_HOME: alembicHome,
      ALEMBIC_QUIET: '1',
      INIT_CWD: targetRoot,
      PWD: targetRoot,
    }),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: 'alembic-codex-dev-verify', version: '0.0.0' });
  try {
    await withTimeout(
      client.connect(transport, { timeout: options.mcpTimeoutMs }),
      options.mcpTimeoutMs + 2000,
      () => `MCP connect timed out for ${targetRoot}\n${stderr.join('')}`
    );
    const result = await withTimeout(
      client.callTool({ name, arguments: args }, undefined, { timeout: options.mcpTimeoutMs }),
      options.mcpTimeoutMs + 2000,
      () => `MCP ${name} timed out for ${targetRoot}\n${stderr.join('')}`
    );
    const text = result.content?.find((item) => item.type === 'text')?.text;
    if (typeof text !== 'string') {
      throw new Error(`MCP ${name} returned no text content\n${JSON.stringify(result)}`);
    }
    return JSON.parse(text);
  } finally {
    await client.close();
  }
}

function runStep(name, command, args, stepOptions = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    stdio: stepOptions.capture ? 'pipe' : 'inherit',
    env: {
      ...process.env,
      HUSKY: '0',
      npm_config_cache: join(tmpRoot, 'npm-cache'),
    },
  });
  const step = {
    name,
    command: [command, ...args].join(' '),
    durationMs: Date.now() - startedAt,
    status: result.status,
  };
  report.steps.push(step);
  if (result.status !== 0) {
    throw new Error(
      `${name} failed (${result.status})\n${result.stdout || ''}${result.stderr || ''}`
    );
  }
  return result;
}

function summarizeStatus(data) {
  return {
    projectRoot: data.projectRoot,
    initialized: data.initialized,
    source: data.projectRootResolution?.source,
    trust: data.projectRootResolution?.trust,
    rejected: data.projectRootResolution?.rejected,
  };
}

function parseArgs(args) {
  const parsed = {
    codexHome: '',
    keepTmp: false,
    localMcp: true,
    mcpTimeoutMs: 30000,
    noSync: false,
    probeOnly: false,
    probeTargets: [],
    projectRoot: root,
    reportPath: join(root, 'scratch', 'codex-plugin-dev-verify-report.json'),
    skipBuild: false,
    skipPrepare: false,
    skipSmoke: false,
    skipTests: false,
    skipVerify: false,
    syncTargets: [],
    withNpxRuntime: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--codex-home') {
      parsed.codexHome = args[index + 1] || '';
      index += 1;
    } else if (arg === '--keep-tmp') {
      parsed.keepTmp = true;
    } else if (arg === '--packaged') {
      parsed.localMcp = false;
      parsed.mcpTimeoutMs = Math.max(parsed.mcpTimeoutMs, 180000);
    } else if (arg === '--probe-only') {
      parsed.probeOnly = true;
      parsed.noSync = true;
      parsed.skipBuild = true;
      parsed.skipPrepare = true;
      parsed.skipSmoke = true;
      parsed.skipTests = true;
      parsed.skipVerify = true;
    } else if (arg === '--refresh-only') {
      parsed.skipSmoke = true;
      parsed.skipTests = true;
      parsed.skipVerify = true;
    } else if (arg === '--no-sync') {
      parsed.noSync = true;
    } else if (arg === '--skip-build') {
      parsed.skipBuild = true;
    } else if (arg === '--skip-prepare') {
      parsed.skipPrepare = true;
    } else if (arg === '--skip-smoke') {
      parsed.skipSmoke = true;
    } else if (arg === '--skip-tests') {
      parsed.skipTests = true;
    } else if (arg === '--skip-verify') {
      parsed.skipVerify = true;
    } else if (arg === '--with-npx-runtime') {
      parsed.withNpxRuntime = true;
    } else if (arg === '--project-root') {
      parsed.projectRoot = resolve(args[index + 1] || '');
      index += 1;
    } else if (arg === '--probe-target') {
      parsed.probeTargets.push(resolve(args[index + 1] || ''));
      index += 1;
    } else if (arg === '--report-path') {
      parsed.reportPath = resolve(args[index + 1] || parsed.reportPath);
      index += 1;
    } else if (arg === '--sync-target') {
      parsed.syncTargets.push(resolve(args[index + 1] || ''));
      index += 1;
    } else if (arg === '--mcp-timeout-ms') {
      parsed.mcpTimeoutMs = Number(args[index + 1] || parsed.mcpTimeoutMs);
      index += 1;
    } else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function sanitizeEnv(env) {
  return Object.fromEntries(Object.entries(env).filter((entry) => typeof entry[1] === 'string'));
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message())), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function assertProbe(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function printReport() {
  mkdirSync(dirname(options.reportPath), { recursive: true });
  writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ ...report, reportPath: options.reportPath }, null, 2)}\n`
  );
}

function printHelp() {
  process.stdout.write(`Run Alembic Codex plugin local development verification.

Usage:
  node scripts/dev-verify-codex-plugin.mjs [options]

Default flow:
  build, build Dashboard, run focused unit tests, prepare runtime, verify plugin metadata,
  run smoke without npx runtime, refresh installed Codex plugin caches in local-mcp mode,
  and probe installed MCP projectRoot behavior.

Options:
  --refresh-only          Build, prepare, refresh installed cache, and probe. Skip tests/verify/smoke.
  --probe-only            Probe existing installed cache only.
  --packaged              Probe installed cache through packaged runtime wrapper instead of local dist.
  --with-npx-runtime      Include smoke npx/runtime startup check.
  --project-root <path>   Project root used by probe, defaults to this repository.
  --codex-home <path>     Override CODEX_HOME, defaults to ~/.codex.
  --sync-target <path>    Extra plugin cache root to refresh.
  --probe-target <path>   Installed plugin cache root to probe.
  --report-path <path>    Persist JSON report, defaults to scratch/codex-plugin-dev-verify-report.json.
  --no-sync               Do not refresh installed cache before probing.
  --skip-build            Skip npm run build and build:dashboard.
  --skip-prepare          Skip prepare:codex-plugin-runtime.
  --skip-tests            Skip focused unit tests.
  --skip-verify           Skip verify:codex-plugin.
  --skip-smoke            Skip smoke:codex-plugin.
  --keep-tmp              Keep temporary verification data.
  -h, --help              Show this help.
`);
}
