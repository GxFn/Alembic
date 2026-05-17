#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(repoRoot, 'config', 'agent-extraction-boundary.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));

const agentRules = config.agentImportRules ?? {};
const scanRoots = agentRules.scanRoots ?? ['lib', 'bin'];
const ignoredPrefixes = new Set(agentRules.ignoredPathPrefixes ?? []);
const allowedCallSites = agentRules.allowedCallSites ?? [];
const allowedByPath = new Map(allowedCallSites.map((entry) => [entry.path, entry]));
const violations = [];

const agentImportsByFile = new Map();
for (const root of scanRoots) {
  for (const file of collectTypeScriptFiles(join(repoRoot, root))) {
    const relFile = toRepoPath(file);
    if (isIgnored(relFile, ignoredPrefixes)) {
      continue;
    }
    const specifiers = extractImportSpecifiers(readFileSync(file, 'utf8')).filter((specifier) =>
      specifier.startsWith('#agent/')
    );
    if (specifiers.length > 0) {
      agentImportsByFile.set(relFile, uniqueSorted(specifiers));
    }
  }
}

for (const [relFile, specifiers] of agentImportsByFile) {
  const allowed = allowedByPath.get(relFile);
  if (!allowed) {
    violations.push(
      `Unclassified #agent import in ${relFile}: ${specifiers.join(', ')}. Add it to config/agent-extraction-boundary.json or remove the dependency.`
    );
    continue;
  }
  const expected = uniqueSorted(allowed.expectedSpecifiers ?? []);
  if (!sameArray(specifiers, expected)) {
    violations.push(
      `#agent import drift in ${relFile}: expected [${expected.join(', ')}], found [${specifiers.join(', ')}].`
    );
  }
}

for (const entry of allowedCallSites) {
  const fullPath = join(repoRoot, entry.path);
  if (!existsSync(fullPath)) {
    violations.push(`Configured Agent call site does not exist: ${entry.path}.`);
    continue;
  }
  if (!agentImportsByFile.has(entry.path)) {
    violations.push(
      `Configured Agent call site no longer imports #agent/*: ${entry.path}. Remove or update the boundary entry.`
    );
  }
  if (!entry.classification || !entry.switchAfter || !entry.replacement || !entry.reason) {
    violations.push(
      `Configured Agent call site is missing classification/switchAfter/replacement/reason: ${entry.path}.`
    );
  }
}

const aiRules = config.aiProviderRules ?? {};
const aiScanRoots = aiRules.scanRoots ?? scanRoots;
const aiIgnoredPrefixes = new Set(aiRules.ignoredPathPrefixes ?? ['lib/external/ai/']);
const agentAiImportsByFile = new Map();
const localAiProviderImports = [];

for (const root of aiScanRoots) {
  for (const file of collectTypeScriptFiles(join(repoRoot, root))) {
    const relFile = toRepoPath(file);
    if (isIgnored(relFile, aiIgnoredPrefixes)) {
      continue;
    }
    const specifiers = extractImportSpecifiers(readFileSync(file, 'utf8'));
    const agentAiSpecifiers = specifiers.filter((specifier) => specifier === '@alembic/agent/ai');
    if (agentAiSpecifiers.length > 0) {
      agentAiImportsByFile.set(relFile, uniqueSorted(agentAiSpecifiers));
    }
    for (const specifier of specifiers) {
      if (isLocalAiProviderSpecifier(specifier, relFile)) {
        localAiProviderImports.push({ file: relFile, specifier });
      }
    }
  }
}

for (const offender of localAiProviderImports) {
  violations.push(
    `Local AI provider import remains in ${offender.file}: ${offender.specifier}. Use @alembic/agent/ai outside lib/external/ai/**.`
  );
}

const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const expectedAgentPackage = aiRules.packageName ?? '@alembic/agent';
const expectedAgentRange = aiRules.packageRange ?? 'file:../AlembicAgent';
if (packageJson.dependencies?.[expectedAgentPackage] !== expectedAgentRange) {
  violations.push(
    `Expected dependency ${expectedAgentPackage}@${expectedAgentRange} for Agent AI extraction boundary.`
  );
}

const toolSystemRules = config.toolSystemImportRules ?? {};
const toolSystemScanRoots = toolSystemRules.scanRoots ?? scanRoots;
const toolSystemIgnoredPrefixes = new Set(toolSystemRules.ignoredPathPrefixes ?? []);
const toolSystemPublicEntrypoint = toolSystemRules.publicEntrypoint ?? '@alembic/agent/tools';
const deferredToolImports = toolSystemRules.deferredLocalImports ?? [];
const deferredToolImportsByPath = new Map(deferredToolImports.map((entry) => [entry.path, entry]));
const agentToolImportsByFile = new Map();
const deferredToolImportsByFile = new Map();
const localCommonToolImports = [];

for (const root of toolSystemScanRoots) {
  for (const file of collectTypeScriptFiles(join(repoRoot, root))) {
    const relFile = toRepoPath(file);
    if (isIgnored(relFile, toolSystemIgnoredPrefixes)) {
      continue;
    }
    const specifiers = extractImportSpecifiers(readFileSync(file, 'utf8'));
    const agentToolSpecifiers = specifiers.filter(
      (specifier) => specifier === toolSystemPublicEntrypoint
    );
    if (agentToolSpecifiers.length > 0) {
      agentToolImportsByFile.set(relFile, uniqueSorted(agentToolSpecifiers));
    }

    const allowedDeferred = deferredToolImportsByPath.get(relFile);
    const allowedDeferredSpecifiers = new Set(allowedDeferred?.expectedSpecifiers ?? []);
    for (const specifier of specifiers) {
      if (!isLocalCommonToolSpecifier(specifier, relFile)) {
        continue;
      }
      if (allowedDeferredSpecifiers.has(specifier)) {
        const existing = deferredToolImportsByFile.get(relFile) ?? [];
        existing.push(specifier);
        deferredToolImportsByFile.set(relFile, existing);
        continue;
      }
      localCommonToolImports.push({ file: relFile, specifier });
    }
  }
}

for (const offender of localCommonToolImports) {
  violations.push(
    `Local common tool import remains in ${offender.file}: ${offender.specifier}. Use ${toolSystemPublicEntrypoint} outside local implementation/deferred bridge files.`
  );
}

for (const entry of deferredToolImports) {
  const fullPath = join(repoRoot, entry.path);
  if (!existsSync(fullPath)) {
    violations.push(`Configured deferred tool import site does not exist: ${entry.path}.`);
    continue;
  }
  const expected = uniqueSorted(entry.expectedSpecifiers ?? []);
  const actual = uniqueSorted(deferredToolImportsByFile.get(entry.path) ?? []);
  if (!sameArray(actual, expected)) {
    violations.push(
      `Deferred local tool import drift in ${entry.path}: expected [${expected.join(', ')}], found [${actual.join(', ')}].`
    );
  }
  if (!entry.reason) {
    violations.push(`Deferred local tool import entry is missing reason: ${entry.path}.`);
  }
}

const toolRules = config.toolBoundaryRules ?? [];
const toolFiles = collectTypeScriptFiles(join(repoRoot, 'lib', 'tools')).map(toRepoPath);
const toolClassificationCounts = new Map();

for (const relFile of toolFiles) {
  const match = resolveToolRule(relFile, toolRules);
  if (!match) {
    violations.push(
      `Unclassified lib/tools file ${relFile}. Add a toolBoundaryRules entry before moving or changing tool ownership.`
    );
    continue;
  }
  toolClassificationCounts.set(
    match.classification,
    (toolClassificationCounts.get(match.classification) ?? 0) + 1
  );
  if (!match.switchAfter || !match.reason) {
    violations.push(`Tool boundary rule for ${relFile} is missing switchAfter/reason metadata.`);
  }
}

for (const rule of toolRules) {
  if (!rule.classification || !rule.reason || !rule.switchAfter) {
    violations.push(`Tool boundary rule is missing classification/switchAfter/reason metadata.`);
  }
  if (!rule.path && !rule.pathPrefix) {
    violations.push(
      `Tool boundary rule ${rule.classification ?? '<unknown>'} needs path or pathPrefix.`
    );
  }
  if (rule.path && !existsSync(join(repoRoot, rule.path))) {
    violations.push(`Tool boundary path does not exist: ${rule.path}.`);
  }
}

if (violations.length > 0) {
  console.error('\nAgent extraction boundary violations:\n');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  console.error('');
  process.exit(1);
}

console.log('Agent extraction boundary check passed');
console.log(`  product #agent call sites: ${agentImportsByFile.size}`);
console.log(`  @alembic/agent/ai consumer files: ${agentAiImportsByFile.size}`);
console.log(`  local AI provider consumers: ${localAiProviderImports.length}`);
console.log(`  @alembic/agent/tools consumer files: ${agentToolImportsByFile.size}`);
console.log(`  local common tool consumers: ${localCommonToolImports.length}`);
console.log(`  deferred local tool import files: ${deferredToolImportsByFile.size}`);
console.log(`  classified lib/tools files: ${toolFiles.length}`);
for (const [classification, count] of [...toolClassificationCounts].sort(([a], [b]) =>
  a.localeCompare(b)
)) {
  console.log(`  ${classification}: ${count}`);
}

function collectTypeScriptFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function extractImportSpecifiers(source) {
  const sourceWithoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const specifiers = [];
  const importPattern = /(?:from\s+|import\(\s*)['"]([^'"]+)['"]/g;
  for (const match of sourceWithoutComments.matchAll(importPattern)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveToolRule(relFile, rules) {
  const exactRules = rules.filter((rule) => rule.path === relFile);
  if (exactRules.length > 1) {
    violations.push(`Multiple exact tool boundary rules match ${relFile}.`);
    return exactRules[0];
  }
  if (exactRules.length === 1) {
    return exactRules[0];
  }
  const prefixRules = rules
    .filter((rule) => rule.pathPrefix && relFile.startsWith(rule.pathPrefix))
    .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);
  return prefixRules[0] ?? null;
}

function isIgnored(relFile, ignored) {
  for (const prefix of ignored) {
    if (relFile.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function isLocalAiProviderSpecifier(specifier, importerRelFile) {
  if (specifier.startsWith('#external/ai/')) {
    return true;
  }
  if (specifier.includes('lib/external/ai/')) {
    return true;
  }
  if (!specifier.startsWith('.')) {
    return false;
  }
  const importerDir = dirname(join(repoRoot, importerRelFile));
  const resolved = resolve(importerDir, specifier);
  const rel = toRepoPath(resolved);
  return rel === 'lib/external/ai' || rel.startsWith('lib/external/ai/');
}

function isLocalCommonToolSpecifier(specifier, importerRelFile) {
  if (specifier.startsWith('#tools/core/')) {
    return true;
  }
  if (specifier.startsWith('#tools/catalog/')) {
    return true;
  }
  if (specifier.startsWith('#tools/workflow/')) {
    return true;
  }
  if (specifier.startsWith('#tools/v2/')) {
    return true;
  }
  if (!specifier.startsWith('.')) {
    return false;
  }
  const importerDir = dirname(join(repoRoot, importerRelFile));
  const resolved = resolve(importerDir, specifier);
  const rel = toRepoPath(resolved).replace(/\.js$/, '.ts');
  return isCommonToolPath(rel);
}

function isCommonToolPath(rel) {
  return (
    rel.startsWith('lib/tools/core/') ||
    rel.startsWith('lib/tools/catalog/') ||
    rel.startsWith('lib/tools/workflow/') ||
    rel.startsWith('lib/tools/v2/')
  );
}

function toRepoPath(file) {
  return relative(repoRoot, file).split('\\').join('/');
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
