#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(repoRoot, 'config', 'agent-extraction-boundary.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const agentImportPrefix = `${['#agent', ''].join('/')}`;
const agentImportPattern = `${agentImportPrefix}*`;
const localAgentRoot = ['lib', 'agent'].join('/');
const localAgentPrefix = `${localAgentRoot}/`;
const localToolV2Root = ['lib', 'tools', 'v2'].join('/');
const localToolV2Prefix = `${localToolV2Root}/`;
const hostToolContextFactoryPath = ['lib', 'tools', 'v2', 'adapter', 'ToolContextFactory.ts'].join(
  '/'
);
const terminalContractEntrypoint = '@alembic/agent/tools/terminal';
const terminalCapabilitiesRoot = ['lib', 'tools', 'adapters', 'terminal-capabilities'].join('/');
const terminalPolicyRoot = ['lib', 'tools', 'adapters', 'terminal-policy'].join('/');
const terminalSessionPlanPath = ['lib', 'tools', 'adapters', 'TerminalSession.ts'].join('/');
const terminalEnvelopePath = [
  'lib',
  'tools',
  'adapters',
  'terminal-adapter',
  'TerminalEnvelopes.ts',
].join('/');

const agentRules = config.agentImportRules ?? {};
const scanRoots = agentRules.scanRoots ?? ['lib', 'bin'];
const ignoredPrefixes = new Set(agentRules.ignoredPathPrefixes ?? []);
const allowedCallSites = agentRules.allowedCallSites ?? [];
const allowedByPath = new Map(allowedCallSites.map((entry) => [entry.path, entry]));
const violations = [];

const agentImportsByFile = new Map();
const localAgentRelativeImportsByFile = new Map();
const localAgentRelativeImports = [];
for (const root of scanRoots) {
  for (const file of collectSourceFiles(join(repoRoot, root))) {
    const relFile = toRepoPath(file);
    if (isIgnored(relFile, ignoredPrefixes)) {
      continue;
    }
    const specifiers = extractImportSpecifiers(readFileSync(file, 'utf8'));
    const agentSpecifiers = specifiers.filter((specifier) =>
      specifier.startsWith(agentImportPrefix)
    );
    if (agentSpecifiers.length > 0) {
      agentImportsByFile.set(relFile, uniqueSorted(agentSpecifiers));
    }
    const relativeAgentSpecifiers = specifiers.filter((specifier) =>
      isLocalAgentRelativeSpecifier(specifier, relFile)
    );
    if (relativeAgentSpecifiers.length > 0) {
      const sorted = uniqueSorted(relativeAgentSpecifiers);
      localAgentRelativeImportsByFile.set(relFile, sorted);
      for (const specifier of sorted) {
        localAgentRelativeImports.push({ file: relFile, specifier });
      }
    }
  }
}

for (const [relFile, specifiers] of agentImportsByFile) {
  const allowed = allowedByPath.get(relFile);
  if (!allowed) {
    violations.push(
      `Unclassified ${agentImportPrefix} import in ${relFile}: ${specifiers.join(', ')}. Add it to config/agent-extraction-boundary.json or remove the dependency.`
    );
    continue;
  }
  const expected = uniqueSorted(allowed.expectedSpecifiers ?? []);
  if (!sameArray(specifiers, expected)) {
    violations.push(
      `${agentImportPrefix} import drift in ${relFile}: expected [${expected.join(', ')}], found [${specifiers.join(', ')}].`
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
      `Configured Agent call site no longer imports ${agentImportPattern}: ${entry.path}. Remove or update the boundary entry.`
    );
  }
  if (!entry.classification || !entry.switchAfter || !entry.replacement || !entry.reason) {
    violations.push(
      `Configured Agent call site is missing classification/switchAfter/replacement/reason: ${entry.path}.`
    );
  }
}

for (const offender of localAgentRelativeImports) {
  violations.push(
    `Local Agent relative import remains in ${offender.file}: ${offender.specifier}. Use @alembic/agent public subpaths outside preserved local Agent implementation files.`
  );
}
if (allowedCallSites.length > 0) {
  violations.push(
    `Wave 4 forbids configured ${agentImportPattern} call sites; remove allowedCallSites after cutting consumers to @alembic/agent public subpaths.`
  );
}

const aiRules = config.aiProviderRules ?? {};
const aiScanRoots = aiRules.scanRoots ?? scanRoots;
const aiIgnoredPrefixes = new Set(aiRules.ignoredPathPrefixes ?? ['lib/external/ai/']);
const agentAiImportsByFile = new Map();
const localAiProviderImports = [];

for (const root of aiScanRoots) {
  for (const file of collectSourceFiles(join(repoRoot, root))) {
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
if (Object.prototype.hasOwnProperty.call(packageJson.imports ?? {}, agentImportPattern)) {
  violations.push(`Wave 4 forbids package imports alias ${agentImportPattern}.`);
}

const toolSystemRules = config.toolSystemImportRules ?? {};
const toolSystemScanRoots = toolSystemRules.scanRoots ?? scanRoots;
const toolSystemIgnoredPrefixes = new Set(toolSystemRules.ignoredPathPrefixes ?? []);
const toolSystemPublicEntrypoint = toolSystemRules.publicEntrypoint ?? '@alembic/agent/tools';
const toolSystemV2PublicEntrypoint =
  toolSystemRules.publicV2Entrypoint ?? '@alembic/agent/tools/v2';
const deferredToolImports = toolSystemRules.deferredLocalImports ?? [];
const deferredToolImportsByPath = new Map(deferredToolImports.map((entry) => [entry.path, entry]));
const agentToolImportsByFile = new Map();
const agentToolV2ImportsByFile = new Map();
const deferredToolImportsByFile = new Map();
const localCommonToolImports = [];

for (const root of toolSystemScanRoots) {
  for (const file of collectSourceFiles(join(repoRoot, root))) {
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
    const agentToolV2Specifiers = specifiers.filter(
      (specifier) => specifier === toolSystemV2PublicEntrypoint
    );
    if (agentToolV2Specifiers.length > 0) {
      agentToolV2ImportsByFile.set(relFile, uniqueSorted(agentToolV2Specifiers));
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

const memoryContextRules = config.memoryContextImportRules ?? {};
const memoryContextScanRoots = memoryContextRules.scanRoots ?? scanRoots;
const memoryContextIgnoredPrefixes = new Set(memoryContextRules.ignoredPathPrefixes ?? []);
const memoryPublicEntrypoint = memoryContextRules.publicMemoryEntrypoint ?? '@alembic/agent/memory';
const contextPublicEntrypoint =
  memoryContextRules.publicContextEntrypoint ?? '@alembic/agent/context';
const agentMemoryImportsByFile = new Map();
const agentContextImportsByFile = new Map();
const localMemoryContextImports = [];

for (const root of memoryContextScanRoots) {
  for (const file of collectSourceFiles(join(repoRoot, root))) {
    const relFile = toRepoPath(file);
    if (isIgnored(relFile, memoryContextIgnoredPrefixes)) {
      continue;
    }
    const specifiers = extractImportSpecifiers(readFileSync(file, 'utf8'));
    const memorySpecifiers = specifiers.filter((specifier) => specifier === memoryPublicEntrypoint);
    if (memorySpecifiers.length > 0) {
      agentMemoryImportsByFile.set(relFile, uniqueSorted(memorySpecifiers));
    }
    const contextSpecifiers = specifiers.filter(
      (specifier) => specifier === contextPublicEntrypoint
    );
    if (contextSpecifiers.length > 0) {
      agentContextImportsByFile.set(relFile, uniqueSorted(contextSpecifiers));
    }
    for (const specifier of specifiers) {
      if (isLocalMemoryContextSpecifier(specifier, relFile)) {
        localMemoryContextImports.push({ file: relFile, specifier });
      }
    }
  }
}

for (const offender of localMemoryContextImports) {
  violations.push(
    `Local Agent memory/context import remains in ${offender.file}: ${offender.specifier}. Use ${memoryPublicEntrypoint} or ${contextPublicEntrypoint} outside preserved local Agent implementation files.`
  );
}

const hostContractRules = config.hostContractSurfaceImportRules ?? {};
const hostContractScanRoots = hostContractRules.scanRoots ?? scanRoots;
const hostContractIgnoredPrefixes = new Set(hostContractRules.ignoredPathPrefixes ?? []);
const hostContractEntrypoints = hostContractRules.publicEntrypoints ?? {
  service: '@alembic/agent/service',
  runtime: '@alembic/agent/runtime',
  prompts: '@alembic/agent/prompts',
  domain: '@alembic/agent/domain',
};
const hostContractImportsBySurface = new Map(
  Object.keys(hostContractEntrypoints).map((surface) => [surface, new Map()])
);
const localHostContractImports = [];

for (const root of hostContractScanRoots) {
  for (const file of collectSourceFiles(join(repoRoot, root))) {
    const relFile = toRepoPath(file);
    if (isIgnored(relFile, hostContractIgnoredPrefixes)) {
      continue;
    }
    const specifiers = extractImportSpecifiers(readFileSync(file, 'utf8'));
    for (const [surface, publicEntrypoint] of Object.entries(hostContractEntrypoints)) {
      const surfaceSpecifiers = specifiers.filter((specifier) => specifier === publicEntrypoint);
      if (surfaceSpecifiers.length > 0) {
        hostContractImportsBySurface.get(surface)?.set(relFile, uniqueSorted(surfaceSpecifiers));
      }
    }
    for (const specifier of specifiers) {
      if (isLocalHostContractSpecifier(specifier, relFile)) {
        localHostContractImports.push({ file: relFile, specifier });
      }
    }
  }
}

for (const offender of localHostContractImports) {
  violations.push(
    `Local Agent service/runtime/prompts/domain import remains in ${offender.file}: ${offender.specifier}. Use @alembic/agent service/runtime/prompts/domain public subpaths outside preserved local Agent implementation files.`
  );
}

const toolRules = config.toolBoundaryRules ?? [];
const toolFiles = collectSourceFiles(join(repoRoot, 'lib', 'tools')).map(toRepoPath);
const toolClassificationCounts = new Map();
const preservedLocalAgentFiles = collectSourceFiles(join(repoRoot, localAgentRoot)).map(toRepoPath);
const duplicateToolV2Files = collectSourceFiles(join(repoRoot, localToolV2Root))
  .map(toRepoPath)
  .filter((relFile) => relFile !== hostToolContextFactoryPath);
const duplicateCommonToolFiles = [
  ...collectSourceFiles(join(repoRoot, 'lib', 'tools', 'core')),
  ...collectSourceFiles(join(repoRoot, 'lib', 'tools', 'catalog')),
  ...collectSourceFiles(join(repoRoot, 'lib', 'tools', 'workflow')),
].map(toRepoPath);
const terminalContractImportsByFile = new Map();
const terminalContractRules = config.terminalToolContractRules ?? {};
const terminalContractScanRoots = terminalContractRules.scanRoots ?? ['lib', 'bin', 'scripts'];
for (const root of terminalContractScanRoots) {
  for (const file of collectSourceFiles(join(repoRoot, root))) {
    const relFile = toRepoPath(file);
    const specifiers = extractImportSpecifiers(readFileSync(file, 'utf8')).filter(
      (specifier) => specifier === terminalContractEntrypoint
    );
    if (specifiers.length > 0) {
      terminalContractImportsByFile.set(relFile, uniqueSorted(specifiers));
    }
  }
}
const duplicateTerminalCapabilityFiles = collectSourceFiles(
  join(repoRoot, terminalCapabilitiesRoot)
).map(toRepoPath);
const duplicateTerminalPolicyFiles = collectSourceFiles(join(repoRoot, terminalPolicyRoot)).map(
  toRepoPath
);
const duplicateTerminalSessionPlanFiles = existsSync(join(repoRoot, terminalSessionPlanPath))
  ? [terminalSessionPlanPath]
  : [];
const duplicateTerminalEnvelopeFiles = existsSync(join(repoRoot, terminalEnvelopePath))
  ? [terminalEnvelopePath]
  : [];

if (preservedLocalAgentFiles.length > 0) {
  violations.push(
    `Wave 4 requires ${localAgentPrefix} duplicate implementation files to be deleted or relocated as host-owned: ${preservedLocalAgentFiles.join(', ')}.`
  );
}
if (duplicateToolV2Files.length > 0) {
  violations.push(
    `Wave 4 requires generic ${localToolV2Prefix} implementation files to be deleted; only ${hostToolContextFactoryPath} may remain: ${duplicateToolV2Files.join(', ')}.`
  );
}
if (duplicateCommonToolFiles.length > 0) {
  violations.push(
    `Wave 4 requires local generic tool core/catalog/workflow files to be deleted: ${duplicateCommonToolFiles.join(', ')}.`
  );
}
if (terminalContractImportsByFile.size === 0) {
  violations.push(
    `Wave 5 requires Alembic to consume ${terminalContractEntrypoint} for terminal portable contract.`
  );
}
if (duplicateTerminalCapabilityFiles.length > 0) {
  violations.push(
    `Wave 5 requires local portable terminal capability duplicate files to be deleted: ${duplicateTerminalCapabilityFiles.join(', ')}.`
  );
}
if (duplicateTerminalPolicyFiles.length > 0) {
  violations.push(
    `Wave 5 requires local portable terminal policy duplicate files to be deleted: ${duplicateTerminalPolicyFiles.join(', ')}.`
  );
}
if (duplicateTerminalSessionPlanFiles.length > 0) {
  violations.push(
    `Wave 5 requires local portable terminal session plan duplicate files to be deleted: ${duplicateTerminalSessionPlanFiles.join(', ')}.`
  );
}
if (duplicateTerminalEnvelopeFiles.length > 0) {
  violations.push(
    `Wave 5 requires local portable terminal envelope duplicate files to be deleted: ${duplicateTerminalEnvelopeFiles.join(', ')}.`
  );
}

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
console.log(`  local Agent relative import files: ${localAgentRelativeImportsByFile.size}`);
console.log(`  local Agent relative imports: ${localAgentRelativeImports.length}`);
console.log(`  @alembic/agent/ai consumer files: ${agentAiImportsByFile.size}`);
console.log(`  local AI provider consumers: ${localAiProviderImports.length}`);
console.log(`  @alembic/agent/tools consumer files: ${agentToolImportsByFile.size}`);
console.log(`  @alembic/agent/tools/v2 consumer files: ${agentToolV2ImportsByFile.size}`);
console.log(
  `  @alembic/agent/tools/terminal consumer files: ${terminalContractImportsByFile.size}`
);
console.log(`  local common tool consumers: ${localCommonToolImports.length}`);
console.log(`  deferred local tool import files: ${deferredToolImportsByFile.size}`);
console.log(`  @alembic/agent/memory consumer files: ${agentMemoryImportsByFile.size}`);
console.log(`  @alembic/agent/context consumer files: ${agentContextImportsByFile.size}`);
console.log(`  local memory/context consumers: ${localMemoryContextImports.length}`);
for (const [surface, importsByFile] of [...hostContractImportsBySurface].sort(([a], [b]) =>
  a.localeCompare(b)
)) {
  console.log(`  @alembic/agent/${surface} consumer files: ${importsByFile.size}`);
}
console.log(`  local service/runtime/prompts/domain consumers: ${localHostContractImports.length}`);
console.log(`  classified lib/tools files: ${toolFiles.length}`);
console.log(`  preserved local Agent files: ${preservedLocalAgentFiles.length}`);
console.log(`  duplicate generic Tool V2 files: ${duplicateToolV2Files.length}`);
console.log(
  `  duplicate generic tool core/catalog/workflow files: ${duplicateCommonToolFiles.length}`
);
console.log(`  duplicate terminal capability files: ${duplicateTerminalCapabilityFiles.length}`);
console.log(`  duplicate terminal policy files: ${duplicateTerminalPolicyFiles.length}`);
console.log(`  duplicate terminal session plan files: ${duplicateTerminalSessionPlanFiles.length}`);
console.log(`  duplicate terminal envelope files: ${duplicateTerminalEnvelopeFiles.length}`);
for (const [classification, count] of [...toolClassificationCounts].sort(([a], [b]) =>
  a.localeCompare(b)
)) {
  console.log(`  ${classification}: ${count}`);
}

function collectSourceFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function isSourceFile(name) {
  return (
    name.endsWith('.ts') ||
    name.endsWith('.tsx') ||
    name.endsWith('.mts') ||
    name.endsWith('.cts') ||
    name.endsWith('.js') ||
    name.endsWith('.mjs') ||
    name.endsWith('.cjs')
  );
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

function isLocalAgentRelativeSpecifier(specifier, importerRelFile) {
  if (!specifier.startsWith('.')) {
    return false;
  }
  const importerDir = dirname(join(repoRoot, importerRelFile));
  const resolved = resolve(importerDir, specifier);
  const rel = stripSourceExtension(toRepoPath(resolved));
  return rel === localAgentRoot || rel.startsWith(localAgentPrefix);
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
  const rel = stripSourceExtension(toRepoPath(resolved));
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

function isLocalMemoryContextSpecifier(specifier, importerRelFile) {
  if (specifier.startsWith(`${agentImportPrefix}memory/`)) {
    return true;
  }
  if (specifier.startsWith(`${agentImportPrefix}context/`)) {
    return true;
  }
  if (!specifier.startsWith('.')) {
    return false;
  }
  const importerDir = dirname(join(repoRoot, importerRelFile));
  const resolved = resolve(importerDir, specifier);
  const rel = stripSourceExtension(toRepoPath(resolved));
  return (
    rel.startsWith(`${localAgentPrefix}memory/`) || rel.startsWith(`${localAgentPrefix}context/`)
  );
}

function isLocalHostContractSpecifier(specifier, importerRelFile) {
  if (
    specifier.startsWith(`${agentImportPrefix}service/`) ||
    specifier.startsWith(`${agentImportPrefix}runtime/`) ||
    specifier.startsWith(`${agentImportPrefix}prompts/`) ||
    specifier.startsWith(`${agentImportPrefix}domain/`)
  ) {
    return true;
  }
  if (!specifier.startsWith('.')) {
    return false;
  }
  const importerDir = dirname(join(repoRoot, importerRelFile));
  const resolved = resolve(importerDir, specifier);
  const rel = stripSourceExtension(toRepoPath(resolved));
  return (
    rel.startsWith(`${localAgentPrefix}service/`) ||
    rel.startsWith(`${localAgentPrefix}runtime/`) ||
    rel.startsWith(`${localAgentPrefix}prompts/`) ||
    rel.startsWith(`${localAgentPrefix}domain/`)
  );
}

function stripSourceExtension(rel) {
  return rel.replace(/\.(?:c|m)?(?:t|j)sx?$/, '');
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
