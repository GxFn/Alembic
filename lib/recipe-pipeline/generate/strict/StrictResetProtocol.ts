import fsp from 'node:fs/promises';
import path from 'node:path';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import {
  createMainStrictResetDatabasePort,
  type StrictResetDatabasePortV1,
  type StrictResetTransactionPortV1,
  snapshotStrictResetDatabase,
} from '../../../infrastructure/database/StrictResetDatabaseAdapter.js';

export {
  createMainStrictResetDatabasePort,
  type StrictResetDatabasePortV1,
  type StrictResetTransactionPortV1,
};

export interface StrictResetReceiptV1 {
  readonly schemaVersion: 1;
  readonly blank: true;
  readonly clearedPaths: readonly string[];
  readonly clearedTables: readonly string[];
  readonly observedBefore: Readonly<Record<string, number>>;
  readonly observedAfter: Readonly<Record<string, 0>>;
  readonly receiptHash: string;
}

export interface StrictResetSnapshotReceiptV1 {
  readonly schemaVersion: 1;
  readonly databaseSnapshotHash: string;
  readonly fileSnapshotHash: string;
  readonly restoreProbeHash: string;
  readonly receiptHash: string;
}

export async function verifyStrictResetSnapshotAndRestoreProbe(input: {
  readonly allowedRelativePaths: readonly string[];
  readonly allowedTables: readonly string[];
  readonly dataRoot: string;
  readonly database: unknown;
  readonly snapshotRoot: string;
}): Promise<StrictResetSnapshotReceiptV1> {
  const paths = normalizeRelativePaths(input.allowedRelativePaths);
  const tables = normalizeTables(input.allowedTables);
  const targets = await Promise.all(
    paths.map((relativePath) => validateTarget(input.dataRoot, relativePath))
  );
  await fsp.rm(input.snapshotRoot, { force: true, recursive: true });
  await fsp.mkdir(input.snapshotRoot, { recursive: true });
  const filesRoot = path.join(input.snapshotRoot, 'files');
  for (const [index, target] of targets.entries()) {
    if (await exists(target)) {
      const relativePath = paths[index];
      if (!relativePath) {
        throw new Error('STRICT_RESET_SNAPSHOT_PATH_MISMATCH');
      }
      await fsp.cp(target, path.join(filesRoot, relativePath), {
        dereference: false,
        errorOnExist: true,
        recursive: true,
        verbatimSymlinks: true,
      });
    }
  }
  const fileSnapshotHash = await hashFileTree(filesRoot);

  const databaseSnapshotPath = path.join(input.snapshotRoot, 'database.sqlite');
  const { databaseSnapshotHash, observedSnapshot } = await snapshotStrictResetDatabase({
    database: input.database,
    snapshotPath: databaseSnapshotPath,
    tables,
  });

  const probeRoot = path.join(input.snapshotRoot, 'restore-probe');
  if (await exists(filesRoot)) {
    await fsp.cp(filesRoot, probeRoot, { recursive: true, verbatimSymlinks: true });
  }
  const restoredFileHash = await hashFileTree(probeRoot);
  if (restoredFileHash !== fileSnapshotHash) {
    throw new Error('STRICT_RESET_RESTORE_PROBE_DIVERGENCE');
  }
  const restoreProbeHash = hashCanonicalJson({
    databaseSnapshotHash,
    fileSnapshotHash,
    observedSnapshot,
    restoredFileHash,
  });
  const semantic = {
    schemaVersion: 1 as const,
    databaseSnapshotHash,
    fileSnapshotHash,
    restoreProbeHash,
  };
  return Object.freeze({ ...semantic, receiptHash: hashCanonicalJson(semantic) });
}

export async function executeExactStrictReset(input: {
  readonly allowedRelativePaths: readonly string[];
  readonly allowedTables: readonly string[];
  readonly dataRoot: string;
  readonly database: StrictResetDatabasePortV1;
}): Promise<StrictResetReceiptV1> {
  const paths = normalizeRelativePaths(input.allowedRelativePaths);
  const tables = normalizeTables(input.allowedTables);
  const targets = await Promise.all(
    paths.map((relativePath) => validateTarget(input.dataRoot, relativePath))
  );
  const observedBefore = Object.fromEntries(
    await Promise.all(
      tables.map(
        async (table) => [table, await validateCount(input.database.countRows(table))] as const
      )
    )
  );

  await input.database.transaction((transaction) => {
    for (const table of [...tables].reverse()) {
      transaction.clearTable(table);
    }
  });
  for (const target of targets) {
    await fsp.rm(target, { force: true, recursive: true });
  }

  const observedAfter = Object.fromEntries(
    await Promise.all(
      tables.map(
        async (table) => [table, await validateCount(input.database.countRows(table))] as const
      )
    )
  ) as Record<string, number>;
  if (Object.values(observedAfter).some((count) => count !== 0)) {
    throw new Error('STRICT_RESET_BLANK_READBACK_FAILED');
  }
  const semantic = {
    schemaVersion: 1 as const,
    blank: true as const,
    clearedPaths: paths,
    clearedTables: tables,
    observedBefore,
    observedAfter: observedAfter as Readonly<Record<string, 0>>,
  };
  return Object.freeze({ ...semantic, receiptHash: hashCanonicalJson(semantic) });
}

function normalizeRelativePaths(values: readonly string[]): string[] {
  const normalized = [...new Set(values.map((value) => value.trim()))].sort();
  for (const value of normalized) {
    if (
      !value ||
      path.isAbsolute(value) ||
      value === '.' ||
      value.split(/[\\/]/u).some((segment) => segment === '..' || segment === '')
    ) {
      throw new Error('STRICT_RESET_PATH_OUT_OF_SCOPE');
    }
  }
  return normalized;
}

function normalizeTables(values: readonly string[]): string[] {
  const normalized = [...new Set(values.map((value) => value.trim()))].sort();
  if (normalized.some((value) => !/^[a-z][a-z0-9_]*$/u.test(value))) {
    throw new Error('STRICT_RESET_TABLE_INVALID');
  }
  return normalized;
}

async function validateTarget(dataRoot: string, relativePath: string): Promise<string> {
  const root = path.resolve(dataRoot);
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error('STRICT_RESET_PATH_OUT_OF_SCOPE');
  }
  let cursor = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await fsp.lstat(cursor);
      if (stat.isSymbolicLink()) {
        throw new Error('STRICT_RESET_SYMLINK_FORBIDDEN');
      }
    } catch (error: unknown) {
      if (readCode(error) !== 'ENOENT') {
        throw error;
      }
      break;
    }
  }
  return target;
}

async function validateCount(value: Promise<number> | number): Promise<number> {
  const count = await value;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('STRICT_RESET_COUNT_INVALID');
  }
  return count;
}

function readCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function hashFileTree(root: string): Promise<string> {
  if (!(await exists(root))) {
    return hashCanonicalJson([]);
  }
  const rows: Array<{ relativePath: string; hash: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error('STRICT_RESET_SYMLINK_FORBIDDEN');
      }
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        rows.push({ relativePath: path.relative(root, absolute), hash: await hashFile(absolute) });
      }
    }
  };
  await visit(root);
  rows.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return hashCanonicalJson(rows);
}

async function hashFile(filePath: string): Promise<string> {
  return hashCanonicalJson({ bytes: (await fsp.readFile(filePath)).toString('base64') });
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.lstat(target);
    return true;
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
