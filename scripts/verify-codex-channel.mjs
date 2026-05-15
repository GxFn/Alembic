#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const channelPath = join(root, 'channels', 'codex', 'channel.json');
const channelReadmePath = join(root, 'channels', 'codex', 'README.md');
const packageJsonPath = join(root, 'package.json');
const marketplacePath = join(root, '.agents', 'plugins', 'marketplace.json');
const errors = [];

const channel = readJson(channelPath);
const packageJson = readJson(packageJsonPath);
const marketplace = readJson(marketplacePath);
const packageVersion = packageJson.version;

expect(existsSync(channelReadmePath), 'channels/codex/README.md must exist');
expect(channel.id === 'codex', 'Codex channel id must be codex');
expect(channel.displayName === 'Codex', 'Codex channel displayName must be Codex');
expect(
  channel.marketplace?.name === marketplace.name,
  'Codex channel marketplace name must match .agents/plugins/marketplace.json'
);
expect(
  channel.marketplace?.displayName === marketplace.interface?.displayName,
  'Codex channel marketplace displayName must match .agents/plugins/marketplace.json'
);
expect(
  channel.marketplace?.manifestPath === '.agents/plugins/marketplace.json',
  'Codex channel marketplace manifestPath must point to .agents/plugins/marketplace.json'
);
expect(channel.runtime?.channelId === channel.id, 'Codex channel runtime.channelId must match id');
expect(
  channel.runtime?.env?.ALEMBIC_CHANNEL_ID === channel.id,
  'Codex channel runtime env must set ALEMBIC_CHANNEL_ID to the channel id'
);
expect(channel.runtime?.mode === 'plugin', 'Codex channel runtime.mode must be plugin');
expect(channel.runtime?.pluginHost === 'codex', 'Codex channel runtime.pluginHost must be codex');
expect(
  channel.runtime?.env?.ALEMBIC_RUNTIME_MODE === 'plugin',
  'Codex channel runtime env must set ALEMBIC_RUNTIME_MODE=plugin'
);
expect(
  channel.runtime?.env?.ALEMBIC_PLUGIN_HOST === 'codex',
  'Codex channel runtime env must set ALEMBIC_PLUGIN_HOST=codex'
);

const plugins = Array.isArray(channel.plugins) ? channel.plugins : [];
const packages = Array.isArray(channel.packages) ? channel.packages : [];
expect(plugins.length === 1, 'Codex channel must list exactly one plugin in the current phase');
expect(packages.length === 1, 'Codex channel must list exactly one package in the current phase');
expect(plugins[0]?.name === 'alembic-codex', 'Codex channel plugin must be alembic-codex');
expect(packages[0]?.name === 'alembic-ai', 'Codex channel package must be alembic-ai');
expect(
  channel.description ===
    'Codex distribution entry for the Alembic Codex plugin and embedded npm runtime.',
  'Codex channel description must stay scoped to the current plugin/runtime'
);

const marketplaceEntries = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
for (const plugin of plugins) {
  const pluginRoot = join(root, plugin.path || '');
  const pluginJson = readJson(join(pluginRoot, '.codex-plugin', 'plugin.json'));
  const mcpJson = readJson(join(pluginRoot, '.mcp.json'));
  const marketplaceEntry = marketplaceEntries.find(
    (entry) => entry?.name === plugin.marketplaceEntry
  );
  const server = mcpJson.mcpServers?.alembic;
  const args = Array.isArray(server?.args) ? server.args : [];
  const wrapperArg = args.find((arg) => arg.endsWith('alembic-codex-mcp-wrapper.mjs'));
  const wrapperPath = wrapperArg ? join(pluginRoot, wrapperArg.replace(/^\.\//, '')) : '';
  const wrapperSource =
    wrapperPath && existsSync(wrapperPath) ? readFileSync(wrapperPath, 'utf8') : '';

  expect(
    plugin.name === pluginJson.name,
    `channel plugin ${plugin.name} must match plugin.json name`
  );
  expect(existsSync(pluginRoot), `channel plugin path must exist: ${plugin.path}`);
  expect(Boolean(marketplaceEntry), `marketplace must include channel plugin ${plugin.name}`);
  expect(
    marketplaceEntry?.source?.path === `./${plugin.path}`,
    `marketplace path for ${plugin.name} must be ./${plugin.path}`
  );
  expect(
    server?.command === 'node' && args.includes('./bin/alembic-codex-mcp-wrapper.mjs'),
    `plugin ${plugin.name} MCP config must launch the plugin-local Node wrapper`
  );
  expect(
    wrapperSource.includes(plugin.runtimeSpecifier),
    `plugin ${plugin.name} MCP wrapper must use embedded specifier ${plugin.runtimeSpecifier}`
  );
  expect(
    plugin.embeddedRuntimePath === 'runtime' &&
      existsSync(join(pluginRoot, plugin.embeddedRuntimePath, 'package.json')),
    `plugin ${plugin.name} must declare an embedded runtime package path`
  );
  expect(
    plugin.distributionRepo === 'GxFn/AlembicCodex',
    `plugin ${plugin.name} must declare the AlembicCodex distribution repo`
  );
  expect(
    wrapperSource.includes(plugin.runtimeBin),
    `plugin ${plugin.name} MCP wrapper must call ${plugin.runtimeBin}`
  );
  expect(
    server?.env?.ALEMBIC_CHANNEL_ID === channel.runtime?.channelId,
    `plugin ${plugin.name} MCP config must set ALEMBIC_CHANNEL_ID=${channel.runtime?.channelId}`
  );
  expect(
    plugin.runtimeMode === channel.runtime?.mode,
    `plugin ${plugin.name} runtimeMode must match channel runtime.mode`
  );
  expect(
    plugin.pluginHost === channel.runtime?.pluginHost,
    `plugin ${plugin.name} pluginHost must match channel runtime.pluginHost`
  );
  expect(
    server?.env?.ALEMBIC_RUNTIME_MODE === channel.runtime?.mode,
    `plugin ${plugin.name} MCP config must set ALEMBIC_RUNTIME_MODE=${channel.runtime?.mode}`
  );
  expect(
    server?.env?.ALEMBIC_PLUGIN_HOST === channel.runtime?.pluginHost,
    `plugin ${plugin.name} MCP config must set ALEMBIC_PLUGIN_HOST=${channel.runtime?.pluginHost}`
  );
  expect(
    packageJson.scripts?.[plugin.releaseScript],
    `package.json must expose ${plugin.releaseScript} for channel plugin ${plugin.name}`
  );
  expect(
    packageJson.scripts?.[plugin.smokeScript],
    `package.json must expose ${plugin.smokeScript} for channel plugin ${plugin.name}`
  );
}

for (const pkg of packages) {
  expect(pkg.name === packageJson.name, `channel package ${pkg.name} must match package.json name`);
  expect(
    pkg.version === packageVersion,
    `channel package ${pkg.name} version must match package.json`
  );
  expect(pkg.registry === 'npm', `channel package ${pkg.name} registry must be npm`);
  expect(
    pkg.installScope === 'embedded-plugin-runtime',
    `channel package ${pkg.name} installScope must be embedded-plugin-runtime`
  );
  for (const bin of pkg.binaries || []) {
    expect(
      typeof packageJson.bin?.[bin] === 'string',
      `package.json must expose bin ${bin} for channel package ${pkg.name}`
    );
  }
  for (const pluginName of pkg.usedBy || []) {
    expect(
      plugins.some((plugin) => plugin.name === pluginName),
      `channel package ${pkg.name} usedBy references missing plugin ${pluginName}`
    );
  }
}

expect(
  Array.isArray(packageJson.files) && packageJson.files.includes('channels'),
  'package.json files[] must include channels'
);
expect(
  Array.isArray(packageJson.files) &&
    packageJson.files.includes('scripts/verify-codex-channel.mjs'),
  'package.json files[] must include scripts/verify-codex-channel.mjs'
);
expect(
  packageJson.scripts?.['verify:codex-channel'] === 'node scripts/verify-codex-channel.mjs',
  'package.json must expose verify:codex-channel'
);
expect(
  packageJson.scripts?.['release:codex-channel'] === 'node scripts/release-codex-channel.mjs',
  'package.json must expose release:codex-channel'
);

if (errors.length > 0) {
  console.error('Codex channel verification failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

process.stdout.write(
  `Codex channel verification passed (${packageJson.name}@${packageVersion}).\n`
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
