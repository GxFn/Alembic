import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitPreparedPublicRoute,
  inspectPublicRoute,
} from '../../lib/recipe-pipeline/generate/strict/PublicRouteCas.js';
import {
  createMainStrictResetDatabasePort,
  executeExactStrictReset,
  type StrictResetDatabasePortV1,
  verifyStrictResetSnapshotAndRestoreProbe,
} from '../../lib/recipe-pipeline/generate/strict/StrictResetProtocol.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { force: true, recursive: true })));
});

describe('strict reset and public route CAS', () => {
  it('deletes only authorized relative paths and proves blank database tables', async () => {
    const root = await temporaryRoot();
    await fsp.mkdir(path.join(root, 'allowed'), { recursive: true });
    await fsp.mkdir(path.join(root, 'preserved'), { recursive: true });
    await fsp.writeFile(path.join(root, 'allowed', 'candidate.json'), '{}');
    await fsp.writeFile(path.join(root, 'preserved', 'source.json'), '{}');
    const db = databasePort({ recipes: 2, recipe_source_refs: 3 });

    const receipt = await executeExactStrictReset({
      allowedRelativePaths: ['allowed'],
      allowedTables: ['recipes', 'recipe_source_refs'],
      dataRoot: root,
      database: db,
    });

    await expect(fsp.stat(path.join(root, 'allowed'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(path.join(root, 'preserved'))).resolves.toBeDefined();
    expect(receipt.blank).toBe(true);
    expect(receipt.clearedTables).toEqual(['recipe_source_refs', 'recipes']);
  });

  it('backs up SQLite and verifies a physical file/database restore probe before reset', async () => {
    const root = await temporaryRoot();
    await fsp.mkdir(path.join(root, 'allowed'), { recursive: true });
    await fsp.writeFile(path.join(root, 'allowed', 'candidate.json'), '{"id":"a"}\n');
    const sqlite = new Database(path.join(root, 'main.sqlite'));
    sqlite.exec("CREATE TABLE recipes (id TEXT PRIMARY KEY); INSERT INTO recipes VALUES ('a');");
    try {
      const receipt = await verifyStrictResetSnapshotAndRestoreProbe({
        allowedRelativePaths: ['allowed'],
        allowedTables: ['recipes'],
        dataRoot: root,
        database: sqlite,
        snapshotRoot: path.join(root, 'operation', 'snapshot'),
      });

      expect(receipt.databaseSnapshotHash).toMatch(/^sha256:/u);
      expect(receipt.fileSnapshotHash).toMatch(/^sha256:/u);
      expect(receipt.restoreProbeHash).toMatch(/^sha256:/u);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM recipes').get()).toEqual({ count: 1 });
    } finally {
      sqlite.close();
    }
  });

  it('keeps the complete SQLite table reset inside one synchronous transaction', async () => {
    const root = await temporaryRoot();
    const sqlite = new Database(path.join(root, 'transaction.sqlite'));
    sqlite.exec(`
      CREATE TABLE recipes (id TEXT PRIMARY KEY);
      CREATE TABLE recipe_source_refs (id TEXT PRIMARY KEY);
      INSERT INTO recipes VALUES ('recipe-a');
      INSERT INTO recipe_source_refs VALUES ('ref-a');
      CREATE TRIGGER reject_ref_delete BEFORE DELETE ON recipe_source_refs
      BEGIN SELECT RAISE(ABORT, 'fixture-delete-rejected'); END;
    `);
    try {
      await expect(
        executeExactStrictReset({
          allowedRelativePaths: ['absent-path'],
          allowedTables: ['recipes', 'recipe_source_refs'],
          dataRoot: root,
          database: createMainStrictResetDatabasePort(sqlite),
        })
      ).rejects.toThrow('fixture-delete-rejected');
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM recipes').get()).toEqual({ count: 1 });
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM recipe_source_refs').get()).toEqual({
        count: 1,
      });
    } finally {
      sqlite.close();
    }
  });

  it('rejects traversal, symlinks, undeclared tables, and nonblank readback', async () => {
    const root = await temporaryRoot();
    await fsp.mkdir(path.join(root, 'target'));
    await fsp.symlink(path.join(root, 'target'), path.join(root, 'link'));
    const db = databasePort({ recipes: 1 });

    await expect(
      executeExactStrictReset({
        allowedRelativePaths: ['../escape'],
        allowedTables: ['recipes'],
        dataRoot: root,
        database: db,
      })
    ).rejects.toThrow('STRICT_RESET_PATH_OUT_OF_SCOPE');
    await expect(
      executeExactStrictReset({
        allowedRelativePaths: ['link'],
        allowedTables: ['recipes'],
        dataRoot: root,
        database: db,
      })
    ).rejects.toThrow('STRICT_RESET_SYMLINK_FORBIDDEN');
  });

  it('performs lock-inside-compare CAS and rejects stale or competing bytes', async () => {
    const root = await temporaryRoot();
    const routePath = path.join(root, 'public-route.json');
    const first = { schemaVersion: 1, generationId: 'generation-a' };
    const firstBytes = `${JSON.stringify(first)}\n`;
    const firstHash = hashCanonicalJson(first);
    const committed = await commitPreparedPublicRoute({
      expectedCurrentHash: null,
      prepared: { bytes: firstBytes, hash: firstHash },
      routePath,
    });
    expect(committed.status).toBe('committed');
    expect((await inspectPublicRoute(routePath))?.hash).toBe(firstHash);
    await expect(
      commitPreparedPublicRoute({
        expectedCurrentHash: null,
        prepared: { bytes: firstBytes, hash: firstHash },
        routePath,
      })
    ).resolves.toEqual({ status: 'recovered', routeHash: firstHash });

    await expect(
      commitPreparedPublicRoute({
        expectedCurrentHash: null,
        prepared: {
          bytes: `${JSON.stringify({ schemaVersion: 1, generationId: 'generation-b' })}\n`,
          hash: hashCanonicalJson({ schemaVersion: 1, generationId: 'generation-b' }),
        },
        routePath,
      })
    ).rejects.toThrow('STRICT_PUBLIC_ROUTE_CAS_CONFLICT');
  });

  it('permits exactly one compare-null winner under concurrent publication', async () => {
    const root = await temporaryRoot();
    const routePath = path.join(root, 'public-route.json');
    const routes = ['generation-a', 'generation-b'].map((generationId) => {
      const value = { schemaVersion: 1, generationId };
      return { bytes: `${JSON.stringify(value)}\n`, hash: hashCanonicalJson(value) };
    });

    const attempts = await Promise.allSettled(
      routes.map((prepared) =>
        commitPreparedPublicRoute({ expectedCurrentHash: null, prepared, routePath })
      )
    );
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    const stored = await inspectPublicRoute(routePath);
    expect(routes.some((route) => route.hash === stored?.hash)).toBe(true);
  });
});

function databasePort(initial: Record<string, number>): StrictResetDatabasePortV1 {
  const counts = new Map(Object.entries(initial));
  return {
    async countRows(table) {
      return counts.get(table) ?? 0;
    },
    transaction(operation) {
      return operation({
        clearTable(table) {
          if (!counts.has(table)) {
            throw new Error('undeclared-table');
          }
          counts.set(table, 0);
        },
      });
    },
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'alembic-strict-reset-'));
  roots.push(root);
  return root;
}
