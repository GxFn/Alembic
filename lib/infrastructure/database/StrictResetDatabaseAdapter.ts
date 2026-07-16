import fsp from 'node:fs/promises';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import Database from 'better-sqlite3';

export interface StrictResetTransactionPortV1 {
  clearTable(table: string): void;
}

export interface StrictResetDatabasePortV1 {
  countRows(table: string): Promise<number> | number;
  transaction<T>(operation: (tx: StrictResetTransactionPortV1) => T): Promise<T> | T;
}

export function createMainStrictResetDatabasePort(database: unknown): StrictResetDatabasePortV1 {
  const raw = unwrapDatabase(database);
  return {
    countRows(table) {
      assertTableName(table);
      const row = raw.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as
        | { count?: unknown }
        | undefined;
      return Number(row?.count ?? 0);
    },
    transaction(operation) {
      const run = raw.transaction(() =>
        operation({
          clearTable(table) {
            assertTableName(table);
            raw.prepare(`DELETE FROM "${table}"`).run();
          },
        })
      );
      return run();
    },
  };
}

export async function snapshotStrictResetDatabase(input: {
  readonly database: unknown;
  readonly snapshotPath: string;
  readonly tables: readonly string[];
}): Promise<{
  readonly databaseSnapshotHash: string;
  readonly observedSnapshot: Readonly<Record<string, number>>;
}> {
  const raw = unwrapDatabase(input.database);
  await raw.backup(input.snapshotPath);
  const snapshot = new Database(input.snapshotPath, { readonly: true, fileMustExist: true });
  let observedSnapshot: Record<string, number>;
  try {
    if (snapshot.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('STRICT_RESET_SNAPSHOT_INTEGRITY_FAILED');
    }
    observedSnapshot = Object.fromEntries(
      input.tables.map((table) => {
        assertTableName(table);
        const row = snapshot.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as
          | { count?: unknown }
          | undefined;
        return [table, Number(row?.count ?? 0)];
      })
    );
  } finally {
    snapshot.close();
  }
  const databaseSnapshotHash = hashCanonicalJson({
    byteHash: hashCanonicalJson({
      bytes: (await fsp.readFile(input.snapshotPath)).toString('base64'),
    }),
    observedSnapshot,
  });
  return Object.freeze({ databaseSnapshotHash, observedSnapshot });
}

function assertTableName(value: string): void {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) {
    throw new Error('STRICT_RESET_TABLE_INVALID');
  }
}

function unwrapDatabase(value: unknown): BetterSqliteDatabase {
  const raw =
    value && typeof value === 'object' && 'getDb' in value && typeof value.getDb === 'function'
      ? value.getDb()
      : value;
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('prepare' in raw) ||
    !('transaction' in raw) ||
    !('backup' in raw)
  ) {
    throw new Error('STRICT_RESET_DATABASE_UNAVAILABLE');
  }
  return raw as BetterSqliteDatabase;
}
