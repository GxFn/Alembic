#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageJson = readJson(join(root, 'package.json'));
const rootReadmePath = join(root, 'README.md');
const rootReadmeCnPath = join(root, 'README_CN.md');
const pluginRoot = join(root, 'plugins', 'alembic-codex');
const pluginJsonPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
const mcpJsonPath = join(pluginRoot, '.mcp.json');
const marketplacePath = join(root, '.agents', 'plugins', 'marketplace.json');
const distributionMarketplacePath = join(pluginRoot, '.agents', 'plugins', 'marketplace.json');
const readmePath = join(pluginRoot, 'README.md');
const readmeCnPath = join(pluginRoot, 'README.zh-CN.md');
const releasePlaybookPath = join(pluginRoot, 'RELEASE-PLAYBOOK.md');
const runtimeRoot = join(pluginRoot, 'runtime');
const runtimePackagePath = join(runtimeRoot, 'package.json');
const runtimeTarballPath = join(pluginRoot, 'runtime.tgz');
const pluginJson = readJson(pluginJsonPath);
const mcpJson = readJson(mcpJsonPath);
const marketplaceJson = readJson(marketplacePath);
const distributionMarketplaceJson = readJson(distributionMarketplacePath);
const runtimePackageJson = readJson(runtimePackagePath);
const errors = [];
const iface = pluginJson.interface || {};

const packageVersion = packageJson.version;
const expectedRuntime = `alembic-ai@${packageVersion}`;
const expectedEmbeddedRuntimeSpecifier = './runtime.tgz';
const server = mcpJson.mcpServers?.alembic;
const args = Array.isArray(server?.args) ? server.args : [];
const marketplaceEntry = Array.isArray(marketplaceJson.plugins)
  ? marketplaceJson.plugins.find((entry) => entry?.name === 'alembic-codex')
  : null;
const marketplaceEntries = Array.isArray(marketplaceJson.plugins) ? marketplaceJson.plugins : [];
const distributionMarketplaceEntry = Array.isArray(distributionMarketplaceJson.plugins)
  ? distributionMarketplaceJson.plugins.find((entry) => entry?.name === 'alembic-codex')
  : null;
const distributionMarketplaceEntries = Array.isArray(distributionMarketplaceJson.plugins)
  ? distributionMarketplaceJson.plugins
  : [];

expect(
  packageJson.bin?.['alembic-codex-mcp'] === 'dist/bin/codex-mcp.js',
  'package.json must expose bin.alembic-codex-mcp -> dist/bin/codex-mcp.js'
);
expect(
  Array.isArray(packageJson.files) &&
    packageJson.files.includes('.agents/plugins/marketplace.json'),
  'package.json files[] must include .agents/plugins/marketplace.json'
);
expect(
  Array.isArray(packageJson.files) && packageJson.files.includes('plugins'),
  'package.json files[] must include plugins so the Codex plugin ships with npm package'
);
expect(
  Array.isArray(packageJson.files) && packageJson.files.includes('scripts/verify-codex-plugin.mjs'),
  'package.json files[] must include scripts/verify-codex-plugin.mjs'
);
expect(
  Array.isArray(packageJson.files) && packageJson.files.includes('scripts/smoke-codex-plugin.mjs'),
  'package.json files[] must include scripts/smoke-codex-plugin.mjs'
);
expect(
  Array.isArray(packageJson.files) &&
    packageJson.files.includes('scripts/prepare-codex-plugin-runtime.mjs'),
  'package.json files[] must include scripts/prepare-codex-plugin-runtime.mjs'
);
expect(
  Array.isArray(packageJson.files) &&
    packageJson.files.includes('scripts/release-codex-plugin.mjs'),
  'package.json files[] must include scripts/release-codex-plugin.mjs'
);
expect(
  packageJson.scripts?.prepublishOnly === 'npm run release:codex-plugin',
  'prepublishOnly must run release:codex-plugin'
);
expect(
  packageJson.scripts?.['release:codex-plugin'] === 'node scripts/release-codex-plugin.mjs',
  'package.json must expose release:codex-plugin'
);
expect(
  packageJson.scripts?.['release:codex-plugin:daemon'] ===
    'node scripts/release-codex-plugin.mjs --daemon',
  'package.json must expose release:codex-plugin:daemon'
);
expect(
  packageJson.scripts?.['dev:codex-plugin:sync'] === 'node scripts/sync-codex-plugin-cache.mjs',
  'package.json must expose dev:codex-plugin:sync'
);
expect(
  packageJson.scripts?.['dev:codex-plugin:local-mcp'] ===
    'node scripts/sync-codex-plugin-cache.mjs --local-mcp',
  'package.json must expose dev:codex-plugin:local-mcp'
);
expect(
  packageJson.scripts?.['dev:codex-plugin:verify'] === 'node scripts/dev-verify-codex-plugin.mjs',
  'package.json must expose dev:codex-plugin:verify'
);
expect(
  packageJson.scripts?.['dev:codex-plugin:refresh'] ===
    'node scripts/dev-verify-codex-plugin.mjs --refresh-only',
  'package.json must expose dev:codex-plugin:refresh'
);
expect(
  packageJson.scripts?.['dev:codex-plugin:probe-installed'] ===
    'node scripts/dev-verify-codex-plugin.mjs --probe-only',
  'package.json must expose dev:codex-plugin:probe-installed'
);
expect(
  packageJson.scripts?.['dev:codex-plugin:watch'] === 'node scripts/dev-watch-codex-plugin.mjs',
  'package.json must expose dev:codex-plugin:watch'
);
expect(
  existsSync(join(root, 'scripts', 'sync-codex-plugin-cache.mjs')),
  'local Codex cache sync script must exist'
);
expect(
  existsSync(join(root, 'scripts', 'dev-verify-codex-plugin.mjs')),
  'local Codex plugin dev verification script must exist'
);
expect(
  existsSync(join(root, 'scripts', 'dev-watch-codex-plugin.mjs')),
  'local Codex plugin watch refresh script must exist'
);
expect(pluginJson.name === 'alembic-codex', 'plugin.json name must be alembic-codex');
expect(
  pluginJson.description?.includes('Local-first project memory'),
  'plugin description must describe local-first project memory'
);
expect(pluginJson.interface?.displayName === 'Alembic', 'plugin displayName must be Alembic');
expect(
  pluginJson.interface?.shortDescription?.includes('Local project memory'),
  'plugin shortDescription must describe local project memory'
);
expect(
  pluginJson.interface?.longDescription?.includes('Ghost mode') &&
    pluginJson.interface?.longDescription?.includes('wakes the Alembic daemon'),
  'plugin longDescription must explain Ghost mode and on-demand daemon startup'
);
for (const keyword of ['codex', 'codex-plugin', 'local-first', 'dashboard', 'bootstrap']) {
  expect(
    Array.isArray(pluginJson.keywords) && pluginJson.keywords.includes(keyword),
    `plugin keywords must include ${keyword}`
  );
}
for (const keyword of ['codex', 'codex-plugin', 'openai-codex']) {
  expect(
    Array.isArray(packageJson.keywords) && packageJson.keywords.includes(keyword),
    `package keywords must include ${keyword}`
  );
}
expect(server?.command === 'node', '.mcp.json must launch the plugin-local Node wrapper');
expect(
  args.includes('./bin/alembic-codex-mcp-wrapper.mjs'),
  '.mcp.json must call the plugin-local MCP wrapper'
);
expect(!args.includes('--prefix'), '.mcp.json must not use --prefix with relative runtime.tgz');
expect(!args.includes('latest'), '.mcp.json must not use latest');
expect(
  existsSync(join(pluginRoot, 'bin', 'alembic-codex-mcp-wrapper.mjs')),
  'plugin MCP wrapper must exist'
);
expect(
  readFileSync(join(pluginRoot, 'bin', 'alembic-codex-mcp-wrapper.mjs'), 'utf8').includes(
    expectedEmbeddedRuntimeSpecifier
  ),
  `plugin MCP wrapper must launch embedded runtime ${expectedEmbeddedRuntimeSpecifier}`
);
expect(server?.cwd === '.', '.mcp.json must run from the installed plugin root');
expect(existsSync(runtimeTarballPath), 'embedded runtime tarball runtime.tgz must exist');
expect(
  server?.env?.ALEMBIC_CHANNEL_ID === 'codex',
  '.mcp.json must set stable ALEMBIC_CHANNEL_ID=codex'
);
expect(
  server?.env?.ALEMBIC_RUNTIME_MODE === 'plugin',
  '.mcp.json must set ALEMBIC_RUNTIME_MODE=plugin so Alembic knows it is plugin-hosted'
);
expect(
  server?.env?.ALEMBIC_PLUGIN_HOST === 'codex',
  '.mcp.json must set ALEMBIC_PLUGIN_HOST=codex for the current plugin host'
);
expect(server?.env?.ALEMBIC_MCP_MODE === '1', '.mcp.json must explicitly set ALEMBIC_MCP_MODE=1');
expect(
  server?.env?.ALEMBIC_CODEX_MCP_MODE === '1',
  '.mcp.json must explicitly set ALEMBIC_CODEX_MCP_MODE=1'
);
expect(
  server?.env?.ALEMBIC_CODEX_PLUGIN_ROOT === '.',
  '.mcp.json must pass ALEMBIC_CODEX_PLUGIN_ROOT=. so diagnostics read the installed plugin shell'
);
expect(server?.env?.ALEMBIC_MCP_TIER === 'agent', '.mcp.json must default to agent tier');
expect(
  server?.env?.ALEMBIC_CODEX_ENABLE_ADMIN === '0',
  '.mcp.json must disable Codex admin tools by default'
);
expect(
  !server?.env?.npm_config_cache,
  '.mcp.json must let the wrapper own npm cache and startup locking'
);
expect(existsSync(runtimePackagePath), 'embedded runtime package.json must exist');
expect(runtimePackageJson.name === 'alembic-ai', 'embedded runtime package must be alembic-ai');
expect(
  runtimePackageJson.version === packageVersion,
  `embedded runtime package version must be ${packageVersion}`
);
expect(
  runtimePackageJson.bin?.['alembic-codex-mcp'] === 'dist/bin/codex-mcp.js',
  'embedded runtime package must expose bin.alembic-codex-mcp -> dist/bin/codex-mcp.js'
);
expect(
  runtimePackageJson.dependencies?.['@modelcontextprotocol/sdk'],
  'embedded runtime package must carry production dependencies'
);
expect(
  runtimePackageJson.imports?.['#codex/*'],
  'embedded runtime package must carry package imports used by compiled dist'
);
for (const requiredRuntimeFile of [
  'dist/bin/codex-mcp.js',
  'dist/bin/daemon-server.js',
  'dist/lib/external/mcp/CodexMcpServer.js',
  'dashboard/dist/index.html',
  'config/default.json',
  'templates/constitution.yaml',
  'injectable-skills/alembic-guard/SKILL.md',
  'resources/grammars/tree-sitter-typescript.wasm',
  'channels/codex/channel.json',
  '.agents/plugins/marketplace.json',
  'plugins/alembic-codex/.agents/plugins/marketplace.json',
  'plugins/alembic-codex/.codex-plugin/plugin.json',
  'plugins/alembic-codex/bin/alembic-codex-mcp-wrapper.mjs',
]) {
  expect(
    existsSync(join(runtimeRoot, requiredRuntimeFile)),
    `embedded runtime missing ${requiredRuntimeFile}`
  );
}
expect(
  distributionMarketplaceJson.name === 'alembic-codex',
  'AlembicCodex plugin distribution marketplace must be named alembic-codex'
);
expect(
  distributionMarketplaceJson.interface?.displayName === 'Alembic Codex',
  'AlembicCodex plugin distribution marketplace must display as Alembic Codex'
);
expect(
  distributionMarketplaceEntries.length === 1,
  'AlembicCodex plugin distribution marketplace must list exactly one plugin'
);
expect(
  Boolean(distributionMarketplaceEntry),
  'AlembicCodex plugin distribution marketplace must include alembic-codex'
);
if (distributionMarketplaceEntry) {
  expect(
    distributionMarketplaceEntry.source?.source === 'local',
    'AlembicCodex plugin distribution marketplace source must be local'
  );
  expect(
    distributionMarketplaceEntry.source?.path === '.',
    'AlembicCodex plugin distribution marketplace path must point to the repository root'
  );
  expect(
    resolve(pluginRoot, distributionMarketplaceEntry.source?.path || '') === pluginRoot,
    'AlembicCodex plugin distribution marketplace path must resolve to the plugin root'
  );
  expect(
    distributionMarketplaceEntry.policy?.installation === 'AVAILABLE',
    'AlembicCodex plugin distribution marketplace installation policy must be AVAILABLE'
  );
  expect(
    distributionMarketplaceEntry.policy?.authentication === 'ON_INSTALL',
    'AlembicCodex plugin distribution marketplace authentication policy must be ON_INSTALL'
  );
  expect(
    distributionMarketplaceEntry.category === iface.category,
    'AlembicCodex plugin distribution marketplace category must match plugin interface category'
  );
}
expect(
  marketplaceJson.name === 'gxfn',
  '.agents/plugins/marketplace.json must name the marketplace gxfn'
);
expect(
  marketplaceJson.interface?.displayName === 'GxFn',
  '.agents/plugins/marketplace.json must display as GxFn'
);
expect(
  marketplaceEntries.length === 1,
  '.agents/plugins/marketplace.json must list exactly one plugin in the current phase'
);
expect(Boolean(marketplaceEntry), '.agents/plugins/marketplace.json must include alembic-codex');
if (marketplaceEntry) {
  expect(
    marketplaceEntry.source?.source === 'local',
    'marketplace alembic-codex source must be local'
  );
  expect(
    marketplaceEntry.source?.path === './plugins/alembic-codex',
    'marketplace alembic-codex path must be ./plugins/alembic-codex'
  );
  expect(
    resolve(root, marketplaceEntry.source?.path || '') === pluginRoot,
    'marketplace alembic-codex path must resolve to the plugin root'
  );
  expect(
    marketplaceEntry.policy?.installation === 'AVAILABLE',
    'marketplace alembic-codex installation policy must be AVAILABLE'
  );
  expect(
    marketplaceEntry.policy?.authentication === 'ON_INSTALL',
    'marketplace alembic-codex authentication policy must be ON_INSTALL'
  );
  expect(
    marketplaceEntry.category === iface.category,
    'marketplace alembic-codex category must match plugin interface category'
  );
}

const assets = [
  iface.composerIcon,
  iface.logo,
  ...(Array.isArray(iface.screenshots) ? iface.screenshots : []),
].filter(Boolean);
expect(assets.length >= 3, 'plugin interface should declare composerIcon, logo, and screenshots');
for (const asset of assets) {
  expect(existsSync(join(pluginRoot, asset)), `missing plugin asset: ${asset}`);
}

const prompts = Array.isArray(iface.defaultPrompt)
  ? iface.defaultPrompt.join('\n').toLowerCase()
  : '';
for (const keyword of [
  'first-minute',
  'diagnostics',
  'status',
  'initialize',
  'bootstrap',
  'prime',
  'guard',
]) {
  expect(prompts.includes(keyword), `default prompts should include ${keyword}`);
}

for (const skill of [
  'alembic',
  'alembic-create',
  'alembic-devdocs',
  'alembic-guard',
  'alembic-recipes',
  'alembic-structure',
]) {
  expect(existsSync(join(pluginRoot, 'skills', skill, 'SKILL.md')), `missing skill: ${skill}`);
}

const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
const readmeCn = existsSync(readmeCnPath) ? readFileSync(readmeCnPath, 'utf8') : '';
const rootReadme = existsSync(rootReadmePath) ? readFileSync(rootReadmePath, 'utf8') : '';
const rootReadmeCn = existsSync(rootReadmeCnPath) ? readFileSync(rootReadmeCnPath, 'utf8') : '';
expect(existsSync(readmeCnPath), 'plugin Chinese README must exist');
expect(readme.includes(expectedRuntime), `README.md must mention ${expectedRuntime}`);
expect(readmeCn.includes(expectedRuntime), `README.zh-CN.md must mention ${expectedRuntime}`);
expect(
  readme.includes(expectedEmbeddedRuntimeSpecifier),
  `README.md must mention embedded runtime specifier ${expectedEmbeddedRuntimeSpecifier}`
);
expect(
  readmeCn.includes(expectedEmbeddedRuntimeSpecifier),
  `README.zh-CN.md must mention embedded runtime specifier ${expectedEmbeddedRuntimeSpecifier}`
);
expect(
  readme.includes('Chinese version: [README.zh-CN.md](README.zh-CN.md)'),
  'plugin README must link to Chinese README'
);
expect(
  readmeCn.includes('English version: [README.md](README.md)'),
  'plugin Chinese README must link to English README'
);
expect(
  readme.includes('codex plugin marketplace add GxFn/AlembicCodex --ref main'),
  'plugin README must document AlembicCodex plugin install command'
);
expect(
  readmeCn.includes('codex plugin marketplace add GxFn/AlembicCodex --ref main'),
  'plugin Chinese README must document AlembicCodex plugin install command'
);
expect(
  readme.includes('[plugins."alembic-codex@alembic-codex"]') &&
    readmeCn.includes('[plugins."alembic-codex@alembic-codex"]'),
  'plugin READMEs must document plugin distribution marketplace registration'
);
expect(
  readme.includes('alembic_codex_diagnostics'),
  'README.md must document alembic_codex_diagnostics'
);
expect(
  readmeCn.includes('alembic_codex_diagnostics'),
  'README.zh-CN.md must document alembic_codex_diagnostics'
);
expect(readme.includes('alembic_codex_cleanup'), 'README.md must document cleanup policy');
expect(readmeCn.includes('alembic_codex_cleanup'), 'README.zh-CN.md must document cleanup policy');
expect(
  readme.includes('Use it when you want Codex to:'),
  'plugin README must include product-facing use cases'
);
expect(existsSync(releasePlaybookPath), 'plugin release playbook must exist');
const releasePlaybook = existsSync(releasePlaybookPath)
  ? readFileSync(releasePlaybookPath, 'utf8')
  : '';
for (const phrase of [
  'Version And Tag Flow',
  'Test Matrix',
  'Manual Codex App Pass',
  'Promotion Plan',
]) {
  expect(releasePlaybook.includes(phrase), `release playbook must include ${phrase}`);
}
expect(readme.includes('RELEASE-PLAYBOOK.md'), 'plugin README must link to release playbook');
expect(
  readmeCn.includes('RELEASE-PLAYBOOK.md'),
  'plugin Chinese README must link to release playbook'
);
expect(rootReadme.includes('## Codex 插件'), 'root README must document Codex plugin');
expect(
  rootReadme.includes('npm run release:codex-plugin'),
  'root README must document Codex plugin release check'
);
expect(
  rootReadme.includes('plugins/alembic-codex/RELEASE-PLAYBOOK.md'),
  'root README must link to release playbook'
);
expect(rootReadmeCn.includes('## Codex 插件'), 'Chinese README must document Codex plugin');
expect(
  rootReadmeCn.includes('npm run release:codex-plugin'),
  'Chinese README must document Codex plugin release check'
);
expect(
  rootReadmeCn.includes('plugins/alembic-codex/RELEASE-PLAYBOOK.md'),
  'Chinese README must link to release playbook'
);

if (errors.length > 0) {
  console.error('Codex plugin verification failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

process.stdout.write(
  `Codex plugin verification passed (${expectedEmbeddedRuntimeSpecifier} -> ${expectedRuntime}).\n`
);

function expect(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(`Unable to read JSON ${path}: ${error.message}`);
    return {};
  }
}
