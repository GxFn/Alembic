#!/usr/bin/env node
/**
 * lint-repo-boundary.mjs — Repository-layer boundary check
 *
 * Ensures `db.prepare()` and `getDb()` calls only appear in:
 *   - lib/repository/**
 *   - lib/infrastructure/database/**
 *   - test/**
 *
 * Allowed escape-hatch format:
 *   // @escape-hatch(permanent) — reason
 *   // @escape-hatch(temporary) — reason
 *
 * Bare `@escape-hatch` without (permanent|temporary) is rejected.
 *
 * Exit 0 = clean, Exit 1 = violations found.
 */

import { execSync } from 'node:child_process';

const PATTERN = '\\.(prepare|getDb)\\s*\\(';

const ALLOWED_DIRS = ['lib/repository/', 'lib/infrastructure/database/', 'test/'];

const result = execSync(`grep -rnE '${PATTERN}' lib/ bin/ --include='*.ts' || true`, {
  encoding: 'utf8',
});

const lines = result.trim().split('\n').filter(Boolean);
const violations = [];
const malformedEscapeHatches = [];

for (const line of lines) {
  // Allowed directories
  if (ALLOWED_DIRS.some((dir) => line.startsWith(dir))) {
    continue;
  }
  // Escape-hatch comment — must use @escape-hatch(permanent) or @escape-hatch(temporary)
  if (line.includes('@escape-hatch')) {
    if (line.includes('@escape-hatch(permanent)') || line.includes('@escape-hatch(temporary)')) {
      continue;
    }
    // Bare @escape-hatch without classification → report as malformed
    malformedEscapeHatches.push(line);
    continue;
  }
  // Skip matches inside comments (lines with // or * before the match)
  const colonIdx = line.indexOf(':', line.indexOf(':') + 1);
  const codeContent = colonIdx >= 0 ? line.slice(colonIdx + 1) : line;
  const trimmed = codeContent.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    continue;
  }
  violations.push(line);
}

// ── Escape-hatch count tracking ──────────────────────────────
const ESCAPE_HATCH_THRESHOLD = 75; // alert when approaching this count
const escapeHatchLines = lines.filter(
  (l) => l.includes('@escape-hatch(permanent)') || l.includes('@escape-hatch(temporary)')
);
const escapeHatchCount = escapeHatchLines.length;

// Classify: @escape-hatch(permanent) vs @escape-hatch(temporary)
const permanentEscapeHatches = escapeHatchLines.filter((l) =>
  l.includes('@escape-hatch(permanent)')
);
const temporaryEscapeHatches = escapeHatchLines.filter((l) =>
  l.includes('@escape-hatch(temporary)')
);

if (violations.length > 0) {
  console.error(`\n❌  Repository boundary violations (${violations.length}):\n`);
  console.error(
    '   db.prepare() / getDb() calls must be inside lib/repository/ or lib/infrastructure/database/.'
  );
  console.error('   To suppress a specific line, add: // @escape-hatch(permanent) — reason\n');
  for (const v of violations) {
    console.error(`   ${v}`);
  }
  console.error('');
  process.exit(1);
}

if (malformedEscapeHatches.length > 0) {
  console.error(`\n❌  Malformed @escape-hatch annotations (${malformedEscapeHatches.length}):\n`);
  console.error(
    '   Must use @escape-hatch(permanent) or @escape-hatch(temporary) — bare @escape-hatch is not allowed.\n'
  );
  for (const v of malformedEscapeHatches) {
    console.error(`   ${v}`);
  }
  console.error('');
  process.exit(1);
}

console.log('✅  Repository boundary check passed');

// Report escape-hatch stats (always, regardless of violations)
console.log(`📊  @escape-hatch count: ${escapeHatchCount} / ${ESCAPE_HATCH_THRESHOLD} threshold`);
console.log(
  `   permanent: ${permanentEscapeHatches.length}, temporary: ${temporaryEscapeHatches.length}`
);
if (escapeHatchCount > ESCAPE_HATCH_THRESHOLD) {
  console.error(
    `\n⚠️   @escape-hatch count (${escapeHatchCount}) exceeds threshold (${ESCAPE_HATCH_THRESHOLD}).`
  );
  console.error('   Consider migrating some @escape-hatch usages to proper Repository methods.\n');
  process.exit(1);
}
