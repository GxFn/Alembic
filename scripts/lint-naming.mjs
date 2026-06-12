// SN3 naming lint (Alembic, ported from the SN2/SN1 shape): blocks
// filename-convention stragglers per config/naming-lint.json. First matching
// rule wins; index.ts barrels pass; exceptions need {file, owner, reason}
// to exempt a single file. Logic is the SN1 pilot's via SN2; the only
// Alembic deltas are this repo's rule set (kebab allowed in lib per the
// as-found dominant census) and the trailing summary text.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const config = JSON.parse(readFileSync(path.join(root, 'config', 'naming-lint.json'), 'utf8'));

for (const entry of config.exceptions ?? []) {
  for (const field of ['file', 'owner', 'reason']) {
    if (!entry?.[field]) {
      process.stderr.write(`naming lint: exception ${JSON.stringify(entry)} missing '${field}'.\n`);
      process.exit(1);
    }
  }
}
const exceptionFiles = new Set((config.exceptions ?? []).map((entry) => entry.file));
const barrelNames = new Set(config.barrelNames ?? []);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

const violations = [];
let checked = 0;
const scanRoots = [...new Set(config.rules.map((rule) => rule.scope.split('/')[0]))];

for (const scanRoot of scanRoots) {
  for (const filePath of walk(path.join(root, scanRoot))) {
    const relative = path.relative(root, filePath).replaceAll(path.sep, '/');
    const baseName = path.basename(relative);
    if (barrelNames.has(baseName) || exceptionFiles.has(relative)) {
      continue;
    }
    if ((config.exemptScopes ?? []).some((scope) => relative.startsWith(`${scope.scope}/`))) {
      continue;
    }
    const rule = config.rules.find(
      (candidate) =>
        relative.startsWith(`${candidate.scope}/`) &&
        new RegExp(candidate.filePattern).test(baseName)
    );
    if (!rule) {
      continue;
    }
    checked += 1;
    if (!new RegExp(rule.namePattern).test(baseName)) {
      violations.push(`${relative}: violates "${rule.label}" (${rule.namePattern})`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write('naming lint FAILED:\n');
  for (const violation of violations) {
    process.stderr.write(`- ${violation}\n`);
  }
  process.exit(1);
}
process.stdout.write(
  `naming lint passed (${checked} files checked; ${exceptionFiles.size} exceptions; kebab lib family codified by pattern).\n`
);
