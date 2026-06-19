/**
 * AD6 no-undeclared-effects audit (docs/declared-effects.md): state
 * snapshots before/after representative calls inside a SANDBOX project root
 * (PathGuard configured to a temp dir — never the real ~/.asd).
 *
 * Representatives:
 *  - zero-effect paths: resident graph usage-gate (problem envelope) —
 *    sandbox tree must be byte-identical;
 *  - the shared DB-write funnel every write family delegates to: stable
 *    database facade + migrations + a drizzle insert — only .asd/alembic.db*
 *    may change.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabaseConnection, type DatabaseConnection } from '@alembic/core/database';
import { pathGuard } from '@alembic/core/shared';

function snapshotTree(root: string): Map<string, string> {
  const entries = new Map<string, string>();
  if (!fs.existsSync(root)) {
    return entries;
  }
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else {
        const digest = crypto.createHash('sha1').update(fs.readFileSync(absolute)).digest('hex');
        entries.set(path.relative(root, absolute), digest);
      }
    }
  };
  walk(root);
  return entries;
}

function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [file, digest] of after) {
    if (before.get(file) !== digest) {
      changed.add(file);
    }
  }
  for (const file of before.keys()) {
    if (!after.has(file)) {
      changed.add(file);
    }
  }
  return [...changed].sort();
}

describe('Declared effects (AD6 no-undeclared-effects audit)', () => {
  let sandboxRoot: string;

  beforeEach(() => {
    sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'declared-effects-'));
    process.env.ALEMBIC_QUIET = '1';
    pathGuard._reset();
    pathGuard.configure({ projectRoot: sandboxRoot, knowledgeBaseDir: 'Alembic' });
  });

  afterEach(() => {
    pathGuard._reset();
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  });

  test('the shared DB-write funnel touches only .asd/alembic.db* in the sandbox', async () => {
    const before = snapshotTree(sandboxRoot);

    let connection: DatabaseConnection | null = null;
    try {
      connection = createDatabaseConnection({ path: '.asd/alembic.db' });
      const sqlite = await connection.connect();
      await connection.runMigrations();
      sqlite.pragma('foreign_keys = OFF');
      sqlite
        .prepare(
          "INSERT INTO knowledge_entries (id, title, createdAt, updatedAt) VALUES ('fx-1', 'Declared Effects Fixture', 1, 1)"
        )
        .run();
    } finally {
      connection?.close();
    }

    const changed = changedPaths(before, snapshotTree(sandboxRoot));
    expect(changed.length).toBeGreaterThan(0);
    for (const file of changed) {
      expect(file.startsWith(path.join('.asd', 'alembic.db'))).toBe(true);
    }
  });
});
