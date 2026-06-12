// SN codemod pipeline (built in SN1, reused by later SN waves; SN0 §6 spec).
// Script-driven rename pass: `git mv` (never delete+add) + import-specifier
// rewrite across the repo + repo-relative path-string rewrite in gate configs,
// scripts, and docs — one change set. Dry-run prints the full plan; nothing is
// written without --apply.
//
//   node scripts/codemod-rename.mjs --map <renames.json> [--apply]
//
// The map file is JSON: [{ "from": "src/old/name.ts", "to": "src/Old/Name.ts" }, ...]
// (repo-relative, forward slashes). Repo-neutral by design: no repo-specific
// names are hardcoded; the scan roots and rewrite rules below are structural.
//
// Safety properties:
// - Case-only renames are validated case-SENSITIVELY (readdir comparison),
//   because existsSync lies on case-insensitive filesystems.
// - Only path-shaped references are rewritten: (a) relative import/require
//   specifiers that RESOLVE to a renamed file, (b) literal repo-relative path
//   strings containing a '/' (e.g. 'src/utils/x.ts'). Bare identifier
//   substrings (storage keys, area names, prose) are never touched — semantic
//   rows such as file-stem-derived config keys are a documented manual pass.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const apply = process.argv.includes('--apply');
const mapFlagIndex = process.argv.indexOf('--map');
if (mapFlagIndex === -1 || !process.argv[mapFlagIndex + 1]) {
  console.error('usage: node scripts/codemod-rename.mjs --map <renames.json> [--apply]');
  process.exit(1);
}
const renames = JSON.parse(
  readFileSync(path.resolve(root, process.argv[mapFlagIndex + 1]), 'utf8')
);

const CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEXT_SCAN_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|html)$/;
// Alembic delta (SN continuation b2): vendor/ holds pinned upstream
// snapshots (mutating them violates the vendor rule and would desync the
// pinned semantics) and .release/ is untracked staging output — neither
// may receive codemod rewrites. Core/Agent lineage repos have neither dir.
const SCAN_DIR_EXCLUDES = new Set(['.git', 'node_modules', 'dist', '.vite', 'vendor', '.release']);

function caseSensitiveExists(repoRelative) {
  const absolute = path.join(root, repoRelative);
  const dir = path.dirname(absolute);
  if (!existsSync(dir)) {
    return false;
  }
  return readdirSync(dir).includes(path.basename(absolute));
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SCAN_DIR_EXCLUDES.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

// ── validate the rename map ──
const errors = [];
for (const { from, to } of renames) {
  if (!from || !to || from === to) {
    errors.push(`invalid pair ${from} -> ${to}`);
  } else {
    if (!caseSensitiveExists(from)) {
      errors.push(`source missing (case-sensitive): ${from}`);
    }
    if (caseSensitiveExists(to)) {
      errors.push(`target already exists (case-sensitive): ${to}`);
    }
  }
}
if (errors.length > 0) {
  console.error('codemod-rename: map validation FAILED:');
  for (const message of errors) {
    console.error(`- ${message}`);
  }
  process.exit(1);
}

const fromByAbsolute = new Map(
  renames.map(({ from, to }) => [path.join(root, from), { from, to }])
);

// ── plan import-specifier rewrites (relative specifiers that resolve to a renamed file) ──
const SPECIFIER_RE =
  /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])(\.{1,2}\/[^'"]+)\2/gm;
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx'];
// SN2 delta (NodeNext repos): '.js'-suffixed relative specifiers compile from
// '.ts'/'.tsx' sources; the pilot repo (Vite, extensionless imports) never hit
// this, so the original resolver missed every such import. The rewritten
// specifier keeps its '.js' suffix.
const NODE_NEXT_EXT_MAP = [
  ['.js', '.ts'],
  ['.js', '.tsx'],
  ['.jsx', '.tsx'],
];

function resolveSpecifier(importerAbsolute, specifier) {
  const base = path.resolve(path.dirname(importerAbsolute), specifier);
  for (const [ext, sourceExt] of NODE_NEXT_EXT_MAP) {
    if (!specifier.endsWith(ext)) {
      continue;
    }
    const candidate = base.slice(0, -ext.length) + sourceExt;
    const dir = path.dirname(candidate);
    if (existsSync(dir) && readdirSync(dir).includes(path.basename(candidate))) {
      return { resolved: candidate, suffix: { nodeNextExt: ext, sourceExt } };
    }
  }
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    const dir = path.dirname(candidate);
    if (existsSync(dir) && readdirSync(dir).includes(path.basename(candidate))) {
      return { resolved: candidate, suffix };
    }
  }
  return null;
}

function toSpecifier(fromDir, targetAbsolute, suffix) {
  if (typeof suffix === 'object' && suffix.nodeNextExt) {
    let relative = path.relative(
      fromDir,
      targetAbsolute.slice(0, -suffix.sourceExt.length) + suffix.nodeNextExt
    );
    relative = relative.replaceAll(path.sep, '/');
    return relative.startsWith('.') ? relative : `./${relative}`;
  }
  let relative = path.relative(
    fromDir,
    suffix.startsWith('/index')
      ? targetAbsolute.slice(0, -suffix.length)
      : targetAbsolute.slice(0, targetAbsolute.length - suffix.length)
  );
  relative = relative.replaceAll(path.sep, '/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

const filePlans = new Map(); // absolute path -> [{kind, before, after}]
function addPlan(filePath, plan) {
  if (!filePlans.has(filePath)) {
    filePlans.set(filePath, []);
  }
  filePlans.get(filePath).push(plan);
}

const allFiles = walk(root);
for (const filePath of allFiles.filter((file) => CODE_EXTENSIONS.test(file))) {
  const text = readFileSync(filePath, 'utf8');
  for (const match of text.matchAll(SPECIFIER_RE)) {
    const specifier = match[3];
    const resolution = resolveSpecifier(filePath, specifier);
    if (!resolution) {
      continue;
    }
    const renamed = fromByAbsolute.get(resolution.resolved);
    if (!renamed) {
      continue;
    }
    const newSpecifier = toSpecifier(
      path.dirname(filePath),
      path.join(root, renamed.to),
      resolution.suffix
    );
    if (newSpecifier !== specifier) {
      addPlan(filePath, { kind: 'specifier', before: specifier, after: newSpecifier });
    }
  }
}

// ── plan repo-relative path-string rewrites (gate configs, scripts, docs) ──
for (const filePath of allFiles.filter((file) => TEXT_SCAN_EXTENSIONS.test(file))) {
  if (fromByAbsolute.has(filePath)) {
    continue; // renamed files themselves move untouched
  }
  const text = readFileSync(filePath, 'utf8');
  for (const { from, to } of renames) {
    const fromNoExt = from.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
    const toNoExt = to.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
    for (const [needle, replacement] of [
      [from, to],
      [fromNoExt, toNoExt],
    ]) {
      if (needle.includes('/') && text.includes(needle)) {
        addPlan(filePath, { kind: 'path-string', before: needle, after: replacement });
      }
    }
  }
}
// ── print the plan ──
// SN4a delta: the b04e58c lineage lost the SN1 plan-printing console.log
// lines (empty husk loops shipped instead), so dry-run produced no plan to
// review — masked in SN3 only because its rename map was empty. Restored
// verbatim from the SN1 pilot (Dashboard 9710a14); recorded as a tooling
// lesson for SN5+.
console.log(`codemod-rename plan (${apply ? 'APPLY' : 'dry-run'}):`);
for (const { from, to } of renames) {
  console.log(`  git mv ${from} ${to}`);
}
for (const [filePath, plans] of [...filePlans.entries()].sort()) {
  const relative = path.relative(root, filePath).replaceAll(path.sep, '/');
  for (const plan of plans) {
    console.log(`  rewrite [${plan.kind}] ${relative}: ${plan.before} -> ${plan.after}`);
  }
}
if (!apply) {
  console.log('dry-run complete; re-run with --apply to execute.');
  process.exit(0);
}

// ── apply: git mv first, then rewrites ──
for (const { from, to } of renames) {
  execFileSync('git', ['mv', from, to], { cwd: root, stdio: 'inherit' });
}
for (const [filePath, plans] of filePlans.entries()) {
  const renamedSelf = fromByAbsolute.get(filePath);
  const targetPath = renamedSelf ? path.join(root, renamedSelf.to) : filePath;
  let text = readFileSync(targetPath, 'utf8');
  for (const plan of plans) {
    if (plan.kind === 'specifier') {
      text = text
        .replaceAll(`'${plan.before}'`, `'${plan.after}'`)
        .replaceAll(`"${plan.before}"`, `"${plan.after}"`);
    } else {
      text = text.replaceAll(plan.before, plan.after);
    }
  }
  writeFileSync(targetPath, text);
}
console.log('codemod-rename applied.');
