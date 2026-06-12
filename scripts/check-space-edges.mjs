// Space allowed-edge gate, Alembic side (P2 AD1 pA2 — consumer stage).
//
// Consumes the CANONICAL space DAG config owned by AlembicCore
// (config/space-allowed-edges.json) strictly READ-ONLY — through the
// node_modules/@alembic/core file: link first, sibling checkout as
// fallback — and verifies Alembic's OWN entry only, per the config's
// consumerContract:
//  1. Manifest edges — package.json space dependencies equal EXACTLY the
//     entry's allowedDependencies ({@alembic/core, @alembic/agent}), each
//     declared as a file: sibling link; no other space edge, none missing.
//  2. Source edges — every @alembic/* package imported anywhere in
//     bin/ lib/ scripts/ test/ stays inside the allowed set.
//  3. Exact-edge allowlist integrity — entries need all five fields
//     (repo/dependency/owner/reason/cleanupTrigger); Alembic honors only
//     entries scoped to repo 'alembic' (expected empty).
//  4. Toolchain floor — node / typescript / biome / vitest meet the
//     recorded space floor, failing with an explicit message below floor.
//
// The entry is located by repo key 'alembic' (the producer gate pattern);
// the entry's packageName field is intentionally NOT asserted — the live
// manifest name is 'alembic-ai' while the config records 'alembic', a
// Core-owned config defect reported in the pA2 backfill. Config defects
// are fixed in AlembicCore, never here (and the config is never copied).

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'alembic';

function loadCanonicalConfig() {
  const candidates = [
    path.join(REPO_ROOT, 'node_modules/@alembic/core/config/space-allowed-edges.json'),
    path.join(REPO_ROOT, '../AlembicCore/config/space-allowed-edges.json'),
  ];
  for (const candidate of candidates) {
    try {
      return { config: JSON.parse(readFileSync(candidate, 'utf8')), source: candidate };
    } catch {
      /* try next */
    }
  }
  console.error(
    'Space-edge gate: canonical config space-allowed-edges.json not reachable via the @alembic/core link or the sibling checkout.'
  );
  process.exit(1);
}

const { config, source } = loadCanonicalConfig();
const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

const failures = [];
const selfEntry = config.repos?.[SELF];
if (!selfEntry) {
  console.error(`Space-edge gate: canonical config has no '${SELF}' entry (${source}).`);
  process.exit(1);
}

// 3. allowlist integrity (validated first so violations can consult it)
const allowlist = Array.isArray(config.exactEdgeAllowlist) ? config.exactEdgeAllowlist : [];
for (const entry of allowlist) {
  for (const field of ['repo', 'dependency', 'owner', 'reason', 'cleanupTrigger']) {
    if (!entry?.[field]) {
      failures.push(
        `exactEdgeAllowlist entry ${JSON.stringify(entry)} is missing required field '${field}'`
      );
    }
  }
}
const selfAllowlisted = new Set(
  allowlist.filter((entry) => entry.repo === SELF).map((entry) => entry.dependency)
);

// 1. manifest edges — exact set equality plus file:-link form
const allowed = new Set(selfEntry.allowedDependencies ?? []);
const declared = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
const declaredSpaceEdges = new Map();
for (const [name, version] of Object.entries(declared)) {
  const isSpacePackage = name.startsWith('@alembic/') || name === 'alembic';
  const isSiblingLink = typeof version === 'string' && version.startsWith('file:..');
  if (isSpacePackage || isSiblingLink) {
    declaredSpaceEdges.set(name, version);
  }
}
for (const [name, version] of declaredSpaceEdges) {
  if (!allowed.has(name) && !selfAllowlisted.has(name)) {
    failures.push(
      `package.json declares space edge '${name}: ${version}' but ${SELF}.allowedDependencies is [${[...allowed].join(', ')}]`
    );
  } else if (typeof version !== 'string' || !version.startsWith('file:')) {
    failures.push(
      `space edge '${name}: ${version}' must be a file: sibling link per the verified DAG`
    );
  }
}
for (const name of allowed) {
  if (!declaredSpaceEdges.has(name)) {
    failures.push(
      `canonical config allows space edge '${name}' but package.json does not declare it — the live manifest contradicts the config entry; STOP and report instead of editing the config`
    );
  }
}

// 2. source edges
const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.mjs', '.js']);
const SPACE_IMPORT_RE = /['"](@alembic\/[a-z-]+(?:\/[^'"]*)?)['"]/g;

function collectFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(absolute, files);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

for (const scanRoot of ['bin', 'lib', 'scripts', 'test']) {
  for (const file of collectFiles(path.join(REPO_ROOT, scanRoot))) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(SPACE_IMPORT_RE)) {
      const specifier = match[1];
      const packageName = specifier.split('/').slice(0, 2).join('/');
      if (!allowed.has(packageName) && !selfAllowlisted.has(packageName)) {
        const line = content.slice(0, match.index).split('\n').length;
        failures.push(
          `${path.relative(REPO_ROOT, file)}:${line} references space package '${specifier}' outside the allowed set [${[...allowed].join(', ')}]`
        );
      }
    }
  }
}

// 4. toolchain floor
const floor = config.toolchainFloor ?? {};
const nodeMajor = Number(process.versions.node.split('.')[0]);
const nodeFloorMajor = Number((floor.node ?? '>=0').replace(/[^0-9.]/g, '').split('.')[0]);
if (nodeMajor < nodeFloorMajor) {
  failures.push(
    `toolchain floor: node ${process.versions.node} is below the space floor ${floor.node} — upgrade node (see toolchainFloor drift rule)`
  );
}
function installedVersion(name) {
  try {
    return JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'node_modules', name, 'package.json'), 'utf8')
    ).version;
  } catch {
    return null;
  }
}
const tsVersion = installedVersion('typescript');
if (!tsVersion || !tsVersion.startsWith('5.9.')) {
  failures.push(
    `toolchain floor: typescript ${tsVersion ?? 'MISSING'} does not satisfy the space floor ${floor.typescript}`
  );
}
const biomeVersion = installedVersion('@biomejs/biome');
if (!biomeVersion || biomeVersion !== floor.biome) {
  failures.push(
    `toolchain floor: biome ${biomeVersion ?? 'MISSING'} does not match the pinned space floor ${floor.biome}`
  );
}
const vitestVersion = installedVersion('vitest');
if (!vitestVersion || Number(vitestVersion.split('.')[0]) < 4) {
  failures.push(
    `toolchain floor: vitest ${vitestVersion ?? 'MISSING'} is below the space floor ${floor.vitest}`
  );
}

if (failures.length > 0) {
  console.error(`Space-edge gate failed: ${failures.length} issue(s).`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Space-edge gate OK: ${SELF} declares exactly [${[...allowed].join(', ')}] as file: links, source scan clean across bin/+lib/+scripts/+test/, toolchain floor met (node ${process.versions.node}, tsc ${tsVersion}, biome ${biomeVersion}, vitest ${vitestVersion}). Canonical config read from ${path.relative(REPO_ROOT, source)}.`
);
