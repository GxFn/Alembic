#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pluginRoot = join(root, 'plugins', 'alembic-codex');
const runtimeRoot = join(pluginRoot, 'runtime');
const packageJson = readJson(join(root, 'package.json'));

const requiredBuildArtifacts = [
  'dist/bin/codex-mcp.js',
  'dist/bin/daemon-server.js',
  'dist/lib/external/mcp/CodexMcpServer.js',
  'dashboard/dist/index.html',
];

for (const artifact of requiredBuildArtifacts) {
  assert(
    existsSync(join(root, artifact)),
    `${artifact} is missing. Run npm run build and npm run build:dashboard first.`
  );
}

rmSync(runtimeRoot, { force: true, recursive: true });
mkdirSync(runtimeRoot, { recursive: true });

writeRuntimePackageJson();
copyTree('dist', 'dist', { skipDeclarations: true });
copyTree('dashboard/dist', 'dashboard/dist');
copyTree('config', 'config');
copyTree('templates', 'templates');
copyTree('injectable-skills', 'injectable-skills');
copyTree('resources/grammars', 'resources/grammars');
copyTree('resources/native-ui', 'resources/native-ui', { optional: true });
copyFile('resources/openChrome.applescript', 'resources/openChrome.applescript', {
  optional: true,
});
copyFile('template.json', 'template.json', { optional: true });
copyFile('README.md', 'README.md', { optional: true });
copyFile('README_CN.md', 'README_CN.md', { optional: true });
copyTree('channels', 'channels');
copyTree('.agents', '.agents');
copyPluginShellSnapshot();

process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      runtimeRoot,
      package: `${packageJson.name}@${packageJson.version}`,
      entry: 'dist/bin/codex-mcp.js',
      pluginRoot,
    },
    null,
    2
  ) + '\n'
);

function writeRuntimePackageJson() {
  const runtimePackage = {
    name: packageJson.name,
    version: packageJson.version,
    description: `${packageJson.description} Embedded Codex plugin runtime.`,
    type: packageJson.type,
    main: packageJson.main,
    engines: packageJson.engines,
    imports: normalizeRuntimeImports(packageJson.imports),
    bin: {
      'alembic-codex-mcp': 'dist/bin/codex-mcp.js',
    },
    keywords: packageJson.keywords,
    homepage: packageJson.homepage,
    repository: packageJson.repository,
    bugs: packageJson.bugs,
    license: packageJson.license,
    dependencies: packageJson.dependencies,
    overrides: packageJson.overrides,
    files: [
      '.agents',
      'channels',
      'config',
      'dashboard/dist',
      'dist',
      'injectable-skills',
      'plugins/alembic-codex',
      'resources',
      'templates',
      'template.json',
      'README.md',
      'README_CN.md',
    ],
  };

  writeFileSync(join(runtimeRoot, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`);
}

function copyPluginShellSnapshot() {
  const destination = join(runtimeRoot, 'plugins', 'alembic-codex');
  for (const entry of [
    '.codex-plugin',
    '.mcp.json',
    'README.md',
    'README.zh-CN.md',
    'RELEASE-PLAYBOOK.md',
    'assets',
    'skills',
  ]) {
    const source = join(pluginRoot, entry);
    const target = join(destination, entry);
    if (!existsSync(source)) {
      throw new Error(`Required plugin shell entry is missing: ${entry}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { force: true, recursive: true });
  }
}

function copyTree(sourceRelative, destinationRelative, options = {}) {
  const source = join(root, sourceRelative);
  const destination = join(runtimeRoot, destinationRelative);
  if (!existsSync(source)) {
    if (options.optional) {
      return;
    }
    throw new Error(`Required source path is missing: ${sourceRelative}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, {
    force: true,
    recursive: true,
    filter(sourcePath) {
      return !(options.skipDeclarations && sourcePath.endsWith('.d.ts'));
    },
  });
}

function copyFile(sourceRelative, destinationRelative, options = {}) {
  const source = join(root, sourceRelative);
  const destination = join(runtimeRoot, destinationRelative);
  if (!existsSync(source)) {
    if (options.optional) {
      return;
    }
    throw new Error(`Required source file is missing: ${sourceRelative}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { force: true });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function normalizeRuntimeImports(imports) {
  if (!imports || typeof imports !== 'object' || Array.isArray(imports)) {
    return imports;
  }
  const normalized = {};
  for (const [specifier, target] of Object.entries(imports)) {
    if (
      target &&
      typeof target === 'object' &&
      !Array.isArray(target) &&
      typeof target.default === 'string'
    ) {
      normalized[specifier] = target.default;
    } else {
      normalized[specifier] = target;
    }
  }
  return normalized;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
