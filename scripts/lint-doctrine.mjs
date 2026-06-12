// Side-effect doctrine lint (P2 AD6, Alembic): blocks the machine-checkable
// doctrine pattern classes over lib/ per config/doctrine-lint.json —
//  A. module-scope mutable `let` bindings, EXCEPT the managed-lifecycle
//     accessor idiom (`let _x: T | null = null;` slots, AD4 pattern);
//  B. module-scope EMPTY `new Map()` / `new Set()` accumulators (seeded
//     const lookups are immutable and not matched).
// Blessed entries (owner/reason/cleanupTrigger, layer-contract idiom) exempt
// named pre-existing bindings; everything new fails the gate.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'config/doctrine-lint.json');
const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.tsx']);

// Module scope = column 0 declarations (lib code is consistently indented).
const LET_BINDING_RE =
  /^(?:export\s+)?let\s+([A-Za-z_$][\w$]*)(\s*:\s*[^=\n]+)?\s*=\s*([^\n;]+);?\s*$/gm;
const MANAGED_NULL_SLOT_RE =
  /^(?:export\s+)?let\s+[A-Za-z_$][\w$]*\s*:\s*[^=\n]*\|\s*null\s*=\s*null;?\s*$/;
const EMPTY_COLLECTION_RE =
  /^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)(\s*:\s*[^=\n]+)?\s*=\s*new\s+(Map|Set)\s*\(\s*\)/gm;

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const blessed = new Set(
  (config.blessedEntries ?? []).map((entry) => `${entry.file}::${entry.binding}`)
);
for (const entry of config.blessedEntries ?? []) {
  for (const field of ['file', 'binding', 'reason', 'owner', 'cleanupTrigger']) {
    if (!entry?.[field]) {
      console.error(`Doctrine lint: blessed entry ${JSON.stringify(entry)} missing '${field}'.`);
      process.exit(1);
    }
  }
}

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

function lineAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

const violations = [];
let scanned = 0;
for (const absolute of collectFiles(path.join(REPO_ROOT, config.scanRoot ?? 'lib'))) {
  const relative = path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
  const content = readFileSync(absolute, 'utf8');
  scanned += 1;

  for (const match of content.matchAll(LET_BINDING_RE)) {
    const binding = match[1];
    if (MANAGED_NULL_SLOT_RE.test(match[0])) {
      continue; // managed-lifecycle accessor slot (AD4 idiom)
    }
    if (blessed.has(`${relative}::${binding}`)) {
      continue;
    }
    violations.push(
      `${relative}:${lineAt(content, match.index)} module-scope mutable 'let ${binding}' outside the managed-lifecycle idiom — wrap it in a managed lifecycle (AD4 pattern) or add a blessed entry with owner/reason/cleanupTrigger`
    );
  }

  for (const match of content.matchAll(EMPTY_COLLECTION_RE)) {
    const binding = match[1];
    if (blessed.has(`${relative}::${binding}`)) {
      continue;
    }
    violations.push(
      `${relative}:${lineAt(content, match.index)} module-scope empty new ${match[3]}() accumulator '${binding}' — module state must live inside a managed lifecycle (AD4 pattern)`
    );
  }
}

if (violations.length > 0) {
  console.error(`Doctrine lint failed: ${violations.length} violation(s).`);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(
  `Doctrine lint OK: ${scanned} lib files scanned; module-scope mutable state confined to managed lifecycles (${blessed.size} blessed legacy entries).`
);
