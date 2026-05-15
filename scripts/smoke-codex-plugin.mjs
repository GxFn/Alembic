#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(import.meta.dirname, '..');
const shouldRunDaemon = process.argv.includes('--daemon');
const shouldRunStdio = !process.argv.includes('--no-stdio');
const shouldRunNpxRuntime = shouldRunStdio && !process.argv.includes('--no-npx-runtime');
const keepTmp = process.argv.includes('--keep') || process.env.KEEP_SMOKE_TMP === '1';
const tmpRoot = mkdtempSync(join(tmpdir(), 'alembic-codex-smoke-'));
const packDir = join(tmpRoot, 'pack');
const extractDir = join(tmpRoot, 'extract');
const npmCacheDir = join(tmpRoot, 'npm-cache');
const projectRoot = join(tmpRoot, 'project');
const stdioProjectRoot = join(tmpRoot, 'stdio-project');
const npxProjectRoot = join(tmpRoot, 'npx-project');
const alembicHome = join(tmpRoot, 'home');
const stdioAlembicHome = join(tmpRoot, 'stdio-home');
const npxAlembicHome = join(tmpRoot, 'npx-home');
mkdirSync(packDir, { recursive: true });
mkdirSync(extractDir, { recursive: true });
mkdirSync(npmCacheDir, { recursive: true });
mkdirSync(projectRoot, { recursive: true });
mkdirSync(stdioProjectRoot, { recursive: true });
mkdirSync(npxProjectRoot, { recursive: true });
mkdirSync(alembicHome, { recursive: true });
mkdirSync(stdioAlembicHome, { recursive: true });
mkdirSync(npxAlembicHome, { recursive: true });
writeFileSync(
  join(projectRoot, 'package.json'),
  '{"name":"codex-smoke-project","type":"module"}\n'
);
writeFileSync(join(projectRoot, 'index.js'), 'export const smoke = true;\n');
writeFileSync(
  join(stdioProjectRoot, 'package.json'),
  '{"name":"codex-stdio-smoke-project","type":"module"}\n'
);
writeFileSync(join(stdioProjectRoot, 'index.js'), 'export const stdioSmoke = true;\n');
writeFileSync(
  join(npxProjectRoot, 'package.json'),
  '{"name":"codex-npx-runtime-smoke-project","type":"module"}\n'
);
writeFileSync(join(npxProjectRoot, 'index.js'), 'export const npxRuntimeSmoke = true;\n');

const previousEnv = {
  ALEMBIC_CHANNEL_ID: process.env.ALEMBIC_CHANNEL_ID,
  ALEMBIC_PLUGIN_HOST: process.env.ALEMBIC_PLUGIN_HOST,
  ALEMBIC_CODEX_PLUGIN_ROOT: process.env.ALEMBIC_CODEX_PLUGIN_ROOT,
  ALEMBIC_HOME: process.env.ALEMBIC_HOME,
  ALEMBIC_RUNTIME_MODE: process.env.ALEMBIC_RUNTIME_MODE,
  ALEMBIC_PROJECT_DIR: process.env.ALEMBIC_PROJECT_DIR,
  CODEX_WORKSPACE_DIR: process.env.CODEX_WORKSPACE_DIR,
};

let server = null;

try {
  const packageJson = readJson(join(root, 'package.json'));
  assert(
    existsSync(join(root, 'dist', 'bin', 'codex-mcp.js')),
    'dist/bin/codex-mcp.js missing; run npm run build first'
  );
  assert(
    existsSync(join(root, 'dashboard', 'dist', 'index.html')),
    'dashboard/dist missing; run npm run build:dashboard first'
  );

  const pack = run('npm', ['pack', '--json', '--pack-destination', packDir, '--ignore-scripts'], {
    cwd: root,
    env: {
      ...process.env,
      HUSKY: '0',
      npm_config_cache: npmCacheDir,
    },
  });
  const packInfo = parseNpmPackJson(pack.stdout)[0];
  const tarball = join(packDir, packInfo.filename);
  assert(existsSync(tarball), `npm pack did not create ${tarball}`);

  const listing = run('tar', ['-tzf', tarball]).stdout.split('\n').filter(Boolean);
  for (const required of requiredPackageFiles(packageJson.version)) {
    assert(listing.includes(required), `packed tarball missing ${required}`);
  }

  run('tar', ['-xzf', tarball, '-C', extractDir]);
  const packageRoot = join(extractDir, 'package');
  const repoNodeModules = join(root, 'node_modules');
  if (existsSync(repoNodeModules) && !existsSync(join(packageRoot, 'node_modules'))) {
    symlinkSync(repoNodeModules, join(packageRoot, 'node_modules'), 'dir');
  }

  const installedPlugin = simulateMarketplaceInstall({
    packageRoot,
    packageVersion: packageJson.version,
  });
  const runtimeRoot = installedPlugin.runtimeRoot;

  process.env.ALEMBIC_HOME = alembicHome;
  process.env.ALEMBIC_CHANNEL_ID = 'codex';
  process.env.ALEMBIC_PLUGIN_HOST = 'codex';
  process.env.ALEMBIC_CODEX_PLUGIN_ROOT = installedPlugin.installedRoot;
  process.env.ALEMBIC_RUNTIME_MODE = 'plugin';
  process.env.ALEMBIC_PROJECT_DIR = projectRoot;
  process.env.CODEX_WORKSPACE_DIR = projectRoot;
  process.env.ALEMBIC_QUIET = '1';

  const { CodexMcpServer } = await import(
    pathToFileURL(join(runtimeRoot, 'dist', 'lib', 'external', 'mcp', 'CodexMcpServer.js')).href
  );
  const { JobStore } = await import(
    pathToFileURL(join(runtimeRoot, 'dist', 'lib', 'daemon', 'JobStore.js')).href
  );

  server = new CodexMcpServer({ projectRoot, waitUntilReadyMs: 5000 });

  const diagnostics = await server.handleToolCall('alembic_codex_diagnostics', {});
  assertResult(diagnostics, 'diagnostics');
  assert(
    diagnostics.data?.package?.pinnedSpecifier === `alembic-ai@${packageJson.version}`,
    'diagnostics runtime package identity mismatch'
  );
  assert(
    diagnostics.data?.package?.runtimeSpecifier === './runtime.tgz',
    'diagnostics embedded runtime specifier mismatch'
  );
  assert(diagnostics.data?.plugin?.ok === true, 'diagnostics plugin checks did not pass');
  assert(diagnostics.data?.codex?.channelId === 'codex', 'diagnostics channel id mismatch');
  assert(diagnostics.data?.runtimeIdentity?.mode === 'plugin', 'diagnostics runtime mode mismatch');
  assert(
    diagnostics.data?.runtimeIdentity?.pluginHost === 'codex',
    'diagnostics plugin host mismatch'
  );
  assert(
    diagnostics.data?.primaryAction?.tool === 'alembic_codex_status',
    'diagnostics should point healthy installs to status'
  );

  const beforeStatus = await server.handleToolCall('alembic_codex_status', {});
  assertResult(beforeStatus, 'status before init');
  assert(
    beforeStatus.data?.initialized === false,
    'fresh smoke workspace should start uninitialized'
  );
  assert(beforeStatus.data?.channel?.id === 'codex', 'status channel id mismatch');
  assert(
    beforeStatus.data?.onboarding?.state === 'needs_init',
    'fresh smoke workspace should recommend initialization'
  );
  assert(
    beforeStatus.data?.onboarding?.primaryAction?.tool === 'alembic_codex_init',
    'fresh smoke workspace should point to codex init'
  );

  const init = await server.handleToolCall('alembic_codex_init', {});
  assertResult(init, 'codex init');
  assert(init.data?.status?.initialized === true, 'codex init did not produce initialized status');
  assert(
    init.data?.nextActions?.some((action) => action?.tool === 'alembic_codex_bootstrap'),
    'codex init should recommend bootstrap'
  );

  const afterStatus = await server.handleToolCall('alembic_codex_status', {});
  assertResult(afterStatus, 'status after init');
  assert(afterStatus.data?.initialized === true, 'status after init should be initialized');
  assert(afterStatus.data?.workspace?.ghost === true, 'codex init should default to Ghost mode');
  assert(
    afterStatus.data?.onboarding?.state === 'needs_bootstrap',
    'initialized empty workspace should still require bootstrap'
  );
  assert(
    afterStatus.data?.onboarding?.primaryAction?.tool === 'alembic_codex_bootstrap',
    'initialized empty workspace should recommend bootstrap'
  );

  const store = new JobStore({ projectRoot });
  const localJob = store.create({ kind: 'rescan', request: { reason: 'smoke' }, source: 'codex' });
  const job = await server.handleToolCall('alembic_codex_job', { jobId: localJob.id });
  assertResult(job, 'local job lookup');
  assert(job.data?.job?.id === localJob.id, 'local job lookup returned the wrong job');

  if (shouldRunDaemon) {
    const recipesDir = afterStatus.data?.workspace?.recipesDir;
    assert(typeof recipesDir === 'string', 'status after init did not return recipesDir');
    writeFileSync(join(recipesDir, 'smoke-dashboard.md'), '# Smoke Dashboard\n');
  }

  let stdio = 'skipped';
  if (shouldRunStdio) {
    await runStdioSmoke({
      packageJson,
      runtimeRoot,
      pluginRoot: installedPlugin.installedRoot,
      projectRoot: stdioProjectRoot,
      alembicHome: stdioAlembicHome,
    });
    stdio = 'passed';
  }
  let npxRuntime = 'skipped';
  if (shouldRunNpxRuntime) {
    await runNpxRuntimeSmoke({
      installedRoot: installedPlugin.installedRoot,
      projectRoot: npxProjectRoot,
      alembicHome: npxAlembicHome,
    });
    npxRuntime = 'passed';
  }

  let daemon = null;
  let recovery = 'skipped';
  if (shouldRunDaemon) {
    const interruptedJob = store.create({
      kind: 'bootstrap',
      request: { reason: 'daemon-recovery-smoke' },
      source: 'codex',
    });
    store.markRunning(interruptedJob.id);

    daemon = await server.handleToolCall('alembic_codex_dashboard', {});
    assertResult(daemon, 'dashboard daemon smoke');
    assert(
      typeof daemon.data?.dashboardUrl === 'string',
      'dashboard daemon smoke did not return a URL'
    );
    const dashboardResponse = await fetch(daemon.data.dashboardUrl);
    const dashboardHtml = await dashboardResponse.text();
    assert(
      dashboardResponse.ok &&
        dashboardResponse.headers.get('content-type')?.includes('text/html') &&
        dashboardHtml.includes('<div id="root"'),
      `dashboard daemon smoke did not serve Dashboard HTML at ${daemon.data.dashboardUrl}`
    );
    const recoveredJob = await server.handleToolCall('alembic_codex_job', {
      jobId: interruptedJob.id,
    });
    assertResult(recoveredJob, 'daemon recovery job lookup');
    assert(
      recoveredJob.data?.job?.status === 'failed',
      'daemon recovery smoke did not fail interrupted job'
    );
    assert(
      recoveredJob.data?.job?.error?.code === 'DAEMON_RESTARTED',
      'daemon recovery smoke did not record DAEMON_RESTARTED'
    );
    recovery = 'passed';
    await server.handleToolCall('alembic_codex_stop', {});
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        package: packInfo.filename,
        packageVersion: packageJson.version,
        projectRoot,
        alembicHome,
        install: 'passed',
        stdio,
        npxRuntime,
        recovery,
        daemon: shouldRunDaemon ? daemon?.data?.dashboardUrl || null : 'skipped',
      },
      null,
      2
    )
  );
} finally {
  if (server && shouldRunDaemon) {
    try {
      await server.handleToolCall('alembic_codex_stop', {});
    } catch {
      /* best effort */
    }
  }
  restoreEnv(previousEnv);
  if (!keepTmp) {
    rmSync(tmpRoot, { recursive: true, force: true });
  } else {
    console.error(`Smoke temp kept at ${tmpRoot}`);
  }
}

function requiredPackageFiles(version) {
  return [
    'package/.agents/plugins/marketplace.json',
    'package/channels/README.md',
    'package/channels/codex/channel.json',
    'package/channels/codex/README.md',
    'package/dist/bin/codex-mcp.js',
    'package/dist/bin/daemon-server.js',
    'package/dist/lib/external/mcp/CodexMcpServer.js',
    'package/dist/lib/daemon/DaemonSupervisor.js',
    'package/dashboard/dist/index.html',
    'package/plugins/alembic-codex/.codex-plugin/plugin.json',
    'package/plugins/alembic-codex/.agents/plugins/marketplace.json',
    'package/plugins/alembic-codex/.mcp.json',
    'package/plugins/alembic-codex/bin/alembic-codex-mcp-wrapper.mjs',
    'package/plugins/alembic-codex/runtime.tgz',
    'package/plugins/alembic-codex/runtime/package.json',
    'package/plugins/alembic-codex/runtime/dist/bin/codex-mcp.js',
    'package/plugins/alembic-codex/runtime/dist/bin/daemon-server.js',
    'package/plugins/alembic-codex/runtime/dist/lib/external/mcp/CodexMcpServer.js',
    'package/plugins/alembic-codex/runtime/dashboard/dist/index.html',
    'package/plugins/alembic-codex/runtime/resources/grammars/tree-sitter-typescript.wasm',
    'package/plugins/alembic-codex/runtime/plugins/alembic-codex/.codex-plugin/plugin.json',
    'package/plugins/alembic-codex/runtime/plugins/alembic-codex/bin/alembic-codex-mcp-wrapper.mjs',
    'package/plugins/alembic-codex/RELEASE-PLAYBOOK.md',
    'package/plugins/alembic-codex/README.md',
    'package/plugins/alembic-codex/README.zh-CN.md',
    'package/plugins/alembic-codex/assets/alembic-codex-status.svg',
    'package/plugins/alembic-codex/skills/alembic/SKILL.md',
    'package/scripts/verify-codex-plugin.mjs',
    'package/scripts/verify-codex-channel.mjs',
    'package/scripts/smoke-codex-plugin.mjs',
    'package/scripts/prepare-codex-plugin-runtime.mjs',
    'package/scripts/release-codex-channel.mjs',
    'package/scripts/release-codex-plugin.mjs',
    'package/package.json',
  ].map((file) => file.replace('<version>', version));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}`
    );
  }
  return result;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseNpmPackJson(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end < start) {
    throw new Error(`npm pack did not emit JSON output:\n${stdout}`);
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertResult(result, label) {
  assert(result && typeof result === 'object', `${label} did not return an object`);
  assert(result.success === true, `${label} failed: ${result.message || JSON.stringify(result)}`);
}

function simulateMarketplaceInstall({ packageRoot, packageVersion }) {
  const marketplace = readJson(join(packageRoot, '.agents', 'plugins', 'marketplace.json'));
  const entry = Array.isArray(marketplace.plugins)
    ? marketplace.plugins.find((item) => item?.name === 'alembic-codex')
    : null;
  assert(entry, 'marketplace install smoke missing alembic-codex entry');
  assert(entry.source?.source === 'local', 'marketplace install smoke requires local source');
  assert(
    entry.source?.path === './plugins/alembic-codex',
    'marketplace install smoke requires ./plugins/alembic-codex source path'
  );
  assert(
    entry.policy?.installation === 'AVAILABLE',
    'marketplace install smoke requires AVAILABLE installation policy'
  );
  assert(
    entry.policy?.authentication === 'ON_INSTALL',
    'marketplace install smoke requires ON_INSTALL authentication policy'
  );

  const sourceRoot = resolve(packageRoot, entry.source.path);
  const installedRoot = join(packageRoot, '.codex-install-smoke', entry.name);
  cpSync(sourceRoot, installedRoot, { recursive: true });

  const manifestPath = join(installedRoot, '.codex-plugin', 'plugin.json');
  const manifest = readJson(manifestPath);
  assert(manifest.name === 'alembic-codex', 'installed plugin manifest name mismatch');
  assert(manifest.interface?.displayName === 'Alembic', 'installed plugin displayName mismatch');
  assert(
    manifest.interface?.category === entry.category,
    'installed plugin category must match marketplace entry'
  );

  const mcpPath =
    typeof manifest.mcpServers === 'string'
      ? resolve(installedRoot, manifest.mcpServers)
      : join(installedRoot, '.mcp.json');
  const mcp = readJson(mcpPath);
  const args = Array.isArray(mcp.mcpServers?.alembic?.args) ? mcp.mcpServers.alembic.args : [];
  const env = mcp.mcpServers?.alembic?.env || {};
  assert(
    mcp.mcpServers?.alembic?.command === 'node',
    'installed plugin MCP must launch the plugin-local Node wrapper'
  );
  assert(
    args.includes('./bin/alembic-codex-mcp-wrapper.mjs'),
    'installed plugin MCP wrapper missing'
  );
  assert(
    existsSync(join(installedRoot, 'bin', 'alembic-codex-mcp-wrapper.mjs')),
    'installed plugin MCP wrapper file missing'
  );
  assert(mcp.mcpServers?.alembic?.cwd === '.', 'installed plugin MCP cwd must be plugin root');
  assert(
    env.ALEMBIC_CODEX_PLUGIN_ROOT === '.',
    'installed plugin MCP must pass ALEMBIC_CODEX_PLUGIN_ROOT=.'
  );
  assert(
    env.ALEMBIC_RUNTIME_MODE === 'plugin',
    'installed plugin MCP must pass ALEMBIC_RUNTIME_MODE=plugin'
  );
  assert(
    env.ALEMBIC_PLUGIN_HOST === 'codex',
    'installed plugin MCP must pass ALEMBIC_PLUGIN_HOST=codex'
  );
  assert(!env.npm_config_cache, 'installed plugin MCP wrapper must own per-run npm cache setup');

  const runtimeRoot = join(installedRoot, 'runtime');
  const runtimeTarballPath = join(installedRoot, 'runtime.tgz');
  assert(existsSync(runtimeTarballPath), 'embedded runtime tarball missing');
  const distributionMarketplace = readJson(
    join(installedRoot, '.agents', 'plugins', 'marketplace.json')
  );
  const distributionEntry = Array.isArray(distributionMarketplace.plugins)
    ? distributionMarketplace.plugins.find((item) => item?.name === 'alembic-codex')
    : null;
  assert(
    distributionMarketplace.name === 'alembic-codex',
    'installed plugin distribution marketplace name mismatch'
  );
  assert(
    distributionEntry?.source?.path === '.',
    'installed plugin distribution marketplace must point to repository root'
  );
  const runtimePackage = readJson(join(runtimeRoot, 'package.json'));
  assert(runtimePackage.name === 'alembic-ai', 'embedded runtime package name mismatch');
  assert(
    runtimePackage.version === packageVersion,
    'embedded runtime package version does not match plugin package version'
  );
  assert(
    runtimePackage.bin?.['alembic-codex-mcp'] === 'dist/bin/codex-mcp.js',
    'embedded runtime MCP bin missing'
  );
  for (const required of [
    'dist/bin/codex-mcp.js',
    'dist/lib/external/mcp/CodexMcpServer.js',
    'dashboard/dist/index.html',
    'resources/grammars/tree-sitter-typescript.wasm',
    'plugins/alembic-codex/.codex-plugin/plugin.json',
  ]) {
    assert(existsSync(join(runtimeRoot, required)), `embedded runtime missing ${required}`);
  }

  for (const asset of collectManifestAssets(manifest.interface || {})) {
    assert(existsSync(resolve(installedRoot, asset)), `installed plugin asset missing: ${asset}`);
  }
  for (const skill of [
    'alembic',
    'alembic-create',
    'alembic-devdocs',
    'alembic-guard',
    'alembic-recipes',
    'alembic-structure',
  ]) {
    assert(
      existsSync(join(installedRoot, 'skills', skill, 'SKILL.md')),
      `installed plugin skill missing: ${skill}`
    );
  }

  return { installedRoot, runtimeRoot };
}

function collectManifestAssets(iface) {
  return [
    iface.composerIcon,
    iface.logo,
    ...(Array.isArray(iface.screenshots) ? iface.screenshots : []),
  ].filter((asset) => typeof asset === 'string' && asset.length > 0);
}

async function runStdioSmoke({ packageJson, runtimeRoot, pluginRoot, projectRoot, alembicHome }) {
  const stderr = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(runtimeRoot, 'dist', 'bin', 'codex-mcp.js')],
    cwd: pluginRoot,
    env: {
      ALEMBIC_CHANNEL_ID: 'codex',
      ALEMBIC_CODEX_ENABLE_ADMIN: '0',
      ALEMBIC_CODEX_PLUGIN_ROOT: pluginRoot,
      ALEMBIC_HOME: alembicHome,
      ALEMBIC_MCP_TIER: 'agent',
      ALEMBIC_PLUGIN_HOST: 'codex',
      ALEMBIC_PROJECT_DIR: projectRoot,
      ALEMBIC_QUIET: '1',
      ALEMBIC_RUNTIME_MODE: 'plugin',
      CODEX_WORKSPACE_DIR: projectRoot,
      PATH: process.env.PATH || '',
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));

  const client = new Client({ name: 'alembic-codex-smoke', version: '0.0.0' });
  try {
    await withTimeout(
      client.connect(transport, { timeout: 5000 }),
      7000,
      () => `MCP stdio connect timed out\n${stderr.join('')}`
    );

    const toolsResult = await withTimeout(
      client.listTools(undefined, { timeout: 5000 }),
      7000,
      () => `MCP tools/list timed out\n${stderr.join('')}`
    );
    const toolNames = new Set(toolsResult.tools.map((tool) => tool.name));
    const toolsByName = new Map(toolsResult.tools.map((tool) => [tool.name, tool]));
    for (const required of [
      'alembic_codex_status',
      'alembic_codex_diagnostics',
      'alembic_codex_init',
      'alembic_codex_dashboard',
      'alembic_codex_bootstrap',
      'alembic_codex_rescan',
      'alembic_codex_job',
    ]) {
      assert(toolNames.has(required), `MCP stdio tools/list missing ${required}`);
    }
    for (const hidden of [
      'alembic_health',
      'alembic_task',
      'alembic_codex_cleanup',
      'alembic_enrich_candidates',
      'alembic_knowledge_lifecycle',
    ]) {
      assert(!toolNames.has(hidden), `MCP stdio fresh project exposed ${hidden}`);
    }
    assert(
      toolsResult.tools.every((tool) => tool.annotations),
      'MCP stdio tools/list returned tools without annotations'
    );
    assert(
      toolsByName.get('alembic_codex_status')?.annotations?.readOnlyHint === true,
      'MCP stdio status tool should be annotated read-only'
    );
    assert(
      toolsByName.get('alembic_codex_init')?.annotations?.destructiveHint === false,
      'MCP stdio init tool should be annotated non-destructive'
    );

    const diagnostics = await callStdioJsonTool(client, 'alembic_codex_diagnostics', {}, stderr);
    assertResult(diagnostics, 'MCP stdio diagnostics');
    assert(
      diagnostics.data?.package?.pinnedSpecifier === `alembic-ai@${packageJson.version}`,
      'MCP stdio diagnostics runtime package identity mismatch'
    );
    assert(
      diagnostics.data?.package?.runtimeSpecifier === './runtime.tgz',
      'MCP stdio diagnostics embedded runtime specifier mismatch'
    );
    assert(
      diagnostics.data?.plugin?.ok === true,
      'MCP stdio diagnostics plugin checks did not pass'
    );
    assert(
      diagnostics.data?.codex?.channelId === 'codex',
      'MCP stdio diagnostics channel id mismatch'
    );
    assert(
      diagnostics.data?.runtimeIdentity?.mode === 'plugin',
      'MCP stdio diagnostics runtime mode mismatch'
    );
    assert(
      diagnostics.data?.runtimeIdentity?.pluginHost === 'codex',
      'MCP stdio diagnostics plugin host mismatch'
    );
    assert(
      diagnostics.data?.primaryAction?.tool === 'alembic_codex_status',
      'MCP stdio diagnostics should point healthy installs to status'
    );

    const beforeStatus = await callStdioJsonTool(client, 'alembic_codex_status', {}, stderr);
    assertResult(beforeStatus, 'MCP stdio status before init');
    assert(
      beforeStatus.data?.initialized === false,
      'MCP stdio fresh workspace should start uninitialized'
    );
    assert(beforeStatus.data?.channel?.id === 'codex', 'MCP stdio status channel id mismatch');
    assert(
      beforeStatus.data?.onboarding?.primaryAction?.tool === 'alembic_codex_init',
      'MCP stdio fresh workspace should point to codex init'
    );

    const init = await callStdioJsonTool(client, 'alembic_codex_init', {}, stderr);
    assertResult(init, 'MCP stdio codex init');
    assert(
      init.data?.status?.initialized === true,
      'MCP stdio codex init did not produce initialized status'
    );

    const afterStatus = await callStdioJsonTool(client, 'alembic_codex_status', {}, stderr);
    assertResult(afterStatus, 'MCP stdio status after init');
    assert(
      afterStatus.data?.initialized === true,
      'MCP stdio status after init should be initialized'
    );
    assert(
      afterStatus.data?.workspace?.ghost === true,
      'MCP stdio codex init should default to Ghost mode'
    );
    assert(
      afterStatus.data?.onboarding?.state === 'needs_bootstrap',
      'MCP stdio initialized empty workspace should still require bootstrap'
    );
    assert(
      afterStatus.data?.onboarding?.primaryAction?.tool === 'alembic_codex_bootstrap',
      'MCP stdio initialized empty workspace should recommend bootstrap'
    );

    const afterInitTools = await withTimeout(
      client.listTools(undefined, { timeout: 5000 }),
      7000,
      () => `MCP tools/list after init timed out\n${stderr.join('')}`
    );
    const afterInitToolNames = new Set(afterInitTools.tools.map((tool) => tool.name));
    assert(
      afterInitToolNames.has('alembic_codex_bootstrap'),
      'MCP stdio initialized empty workspace should expose bootstrap'
    );
    assert(
      afterInitToolNames.has('alembic_codex_job'),
      'MCP stdio initialized empty workspace should expose job status'
    );
    assert(
      !afterInitToolNames.has('alembic_task') && !afterInitToolNames.has('alembic_health'),
      'MCP stdio initialized empty workspace should not expose project-knowledge tools'
    );

    const jobs = await callStdioJsonTool(client, 'alembic_codex_job', { limit: 5 }, stderr);
    assertResult(jobs, 'MCP stdio job list');
    assert(Array.isArray(jobs.data?.jobs), 'MCP stdio job list did not return jobs array');
  } finally {
    await client.close();
  }
}

async function runNpxRuntimeSmoke({ installedRoot, projectRoot, alembicHome }) {
  const mcp = readJson(join(installedRoot, '.mcp.json'));
  const server = mcp.mcpServers?.alembic || {};
  assert(typeof server.command === 'string', 'MCP npx runtime command missing');
  assert(Array.isArray(server.args), 'MCP npx runtime args missing');
  const stderr = [];
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd: installedRoot,
    env: {
      ...process.env,
      ...(server.env || {}),
      ALEMBIC_HOME: alembicHome,
      ALEMBIC_PROJECT_DIR: projectRoot,
      ALEMBIC_QUIET: '1',
      CODEX_WORKSPACE_DIR: projectRoot,
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));

  const client = new Client({ name: 'alembic-codex-npx-runtime-smoke', version: '0.0.0' });
  try {
    await withTimeout(
      client.connect(transport, { timeout: 180000 }),
      190000,
      () => `MCP npx runtime connect timed out\n${stderr.join('')}`
    );
    const toolsResult = await withTimeout(
      client.listTools(undefined, { timeout: 10000 }),
      15000,
      () => `MCP npx runtime tools/list timed out\n${stderr.join('')}`
    );
    const toolNames = new Set(toolsResult.tools.map((tool) => tool.name));
    assert(toolNames.has('alembic_codex_diagnostics'), 'MCP npx runtime missing diagnostics');
    assert(toolNames.has('alembic_codex_status'), 'MCP npx runtime missing status');
  } finally {
    await client.close();
  }
}

async function callStdioJsonTool(client, name, args, stderr) {
  const result = await withTimeout(
    client.callTool({ name, arguments: args }, undefined, { timeout: 5000 }),
    7000,
    () => `MCP stdio ${name} timed out\n${stderr.join('')}`
  );
  assert(!result.isError, `MCP stdio ${name} returned isError\n${JSON.stringify(result)}`);
  const text = result.content?.find((item) => item.type === 'text')?.text;
  assert(typeof text === 'string' && text.length > 0, `MCP stdio ${name} returned no text`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`MCP stdio ${name} returned invalid JSON: ${error.message}\n${text}`);
  }
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

function restoreEnv(env) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
