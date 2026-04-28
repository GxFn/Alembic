import { randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { DrizzleDB } from '../../infrastructure/database/drizzle/index.js';
import { scanRuns } from '../../infrastructure/database/drizzle/schema.js';
import type {
  ScanBudget,
  ScanChangeSet,
  ScanDepth,
  ScanMode,
  ScanScope,
} from '../../workflows/scan/ScanTypes.js';

export type ScanRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface ScanRunRecord {
  id: string;
  projectRoot: string;
  mode: ScanMode;
  depth: ScanDepth;
  status: ScanRunStatus;
  reason: string;
  activeDimensions: string[];
  scope: ScanScope;
  changeSet: ScanChangeSet | null;
  budgets: ScanBudget;
  summary: Record<string, unknown>;
  errorMessage: string | null;
  parentSnapshotId: string | null;
  baselineSnapshotId: string | null;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
}

export interface CreateScanRunInput {
  projectRoot: string;
  mode: ScanMode;
  depth: ScanDepth;
  reason?: string;
  activeDimensions?: string[];
  scope?: ScanScope;
  changeSet?: ScanChangeSet | null;
  budgets?: ScanBudget;
  parentSnapshotId?: string | null;
  baselineSnapshotId?: string | null;
}

export interface ScanRunFilter {
  projectRoot?: string;
  mode?: ScanMode;
  status?: ScanRunStatus;
  limit?: number;
}

export interface CompleteScanRunOptions {
  parentSnapshotId?: string | null;
  baselineSnapshotId?: string | null;
}

type ScanRunRow = typeof scanRuns.$inferSelect;

export class ScanRunRepository {
  readonly #drizzle: DrizzleDB;
  readonly #now: () => number;

  constructor(drizzle: DrizzleDB, now: () => number = Date.now) {
    this.#drizzle = drizzle;
    this.#now = now;
  }

  create(input: CreateScanRunInput): ScanRunRecord {
    const startedAt = this.#now();
    const record: ScanRunRecord = {
      id: ScanRunRepository.#generateId(startedAt),
      projectRoot: input.projectRoot,
      mode: input.mode,
      depth: input.depth,
      status: 'running',
      reason: input.reason ?? '',
      activeDimensions: input.activeDimensions ?? [],
      scope: input.scope ?? {},
      changeSet: input.changeSet ?? null,
      budgets: input.budgets ?? {},
      summary: {},
      errorMessage: null,
      parentSnapshotId: input.parentSnapshotId ?? null,
      baselineSnapshotId: input.baselineSnapshotId ?? null,
      startedAt,
      completedAt: null,
      durationMs: null,
    };

    this.#drizzle
      .insert(scanRuns)
      .values({
        id: record.id,
        projectRoot: record.projectRoot,
        mode: record.mode,
        depth: record.depth,
        status: record.status,
        reason: record.reason,
        activeDimensionsJson: JSON.stringify(record.activeDimensions),
        scopeJson: JSON.stringify(record.scope),
        changeSetJson: record.changeSet ? JSON.stringify(record.changeSet) : null,
        budgetsJson: JSON.stringify(record.budgets),
        summaryJson: JSON.stringify(record.summary),
        errorMessage: null,
        parentSnapshotId: record.parentSnapshotId,
        baselineSnapshotId: record.baselineSnapshotId,
        startedAt,
      })
      .run();

    return record;
  }

  complete(
    id: string,
    summary: Record<string, unknown> = {},
    options: CompleteScanRunOptions = {}
  ): ScanRunRecord | null {
    const current = this.findById(id);
    if (!current || current.status !== 'running') {
      return current;
    }
    const completedAt = this.#now();
    const updateValues: Partial<typeof scanRuns.$inferInsert> = {
      status: 'completed',
      summaryJson: JSON.stringify(summary),
      completedAt,
      durationMs: completedAt - current.startedAt,
    };
    if (options.parentSnapshotId !== undefined) {
      updateValues.parentSnapshotId = options.parentSnapshotId;
    }
    if (options.baselineSnapshotId !== undefined) {
      updateValues.baselineSnapshotId = options.baselineSnapshotId;
    }
    this.#drizzle.update(scanRuns).set(updateValues).where(eq(scanRuns.id, id)).run();
    return this.findById(id);
  }

  fail(
    id: string,
    errorMessage: string,
    summary: Record<string, unknown> = {}
  ): ScanRunRecord | null {
    const current = this.findById(id);
    if (!current || current.status !== 'running') {
      return current;
    }
    const completedAt = this.#now();
    this.#drizzle
      .update(scanRuns)
      .set({
        status: 'failed',
        summaryJson: JSON.stringify(summary),
        errorMessage,
        completedAt,
        durationMs: completedAt - current.startedAt,
      })
      .where(eq(scanRuns.id, id))
      .run();
    return this.findById(id);
  }

  cancel(id: string, summary: Record<string, unknown> = {}): ScanRunRecord | null {
    const current = this.findById(id);
    if (!current || current.status !== 'running') {
      return current;
    }
    const completedAt = this.#now();
    this.#drizzle
      .update(scanRuns)
      .set({
        status: 'cancelled',
        summaryJson: JSON.stringify(summary),
        completedAt,
        durationMs: completedAt - current.startedAt,
      })
      .where(eq(scanRuns.id, id))
      .run();
    return this.findById(id);
  }

  findById(id: string): ScanRunRecord | null {
    const row = this.#drizzle.select().from(scanRuns).where(eq(scanRuns.id, id)).limit(1).get();
    return row ? ScanRunRepository.#mapRow(row) : null;
  }

  find(filter: ScanRunFilter = {}): ScanRunRecord[] {
    const conditions = [];
    if (filter.projectRoot) {
      conditions.push(eq(scanRuns.projectRoot, filter.projectRoot));
    }
    if (filter.mode) {
      conditions.push(eq(scanRuns.mode, filter.mode));
    }
    if (filter.status) {
      conditions.push(eq(scanRuns.status, filter.status));
    }
    const condition = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const rows = this.#drizzle
      .select()
      .from(scanRuns)
      .where(condition)
      .orderBy(desc(scanRuns.startedAt))
      .limit(limit)
      .all();
    return rows.map((row) => ScanRunRepository.#mapRow(row));
  }

  latest(projectRoot: string, mode?: ScanMode): ScanRunRecord | null {
    return this.find({ projectRoot, mode, limit: 1 })[0] ?? null;
  }

  static #mapRow(row: ScanRunRow): ScanRunRecord {
    return {
      id: row.id,
      projectRoot: row.projectRoot,
      mode: readMode(row.mode),
      depth: readDepth(row.depth),
      status: readStatus(row.status),
      reason: row.reason,
      activeDimensions: readJson(row.activeDimensionsJson, []),
      scope: readJson(row.scopeJson, {}),
      changeSet: row.changeSetJson ? readJson(row.changeSetJson, null) : null,
      budgets: readJson(row.budgetsJson, {}),
      summary: readJson(row.summaryJson, {}),
      errorMessage: row.errorMessage,
      parentSnapshotId: row.parentSnapshotId,
      baselineSnapshotId: row.baselineSnapshotId,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      durationMs: row.durationMs,
    };
  }

  static #generateId(now: number): string {
    return `scan-${now}-${randomBytes(4).toString('hex')}`;
  }
}

function readJson<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function readMode(value: string): ScanMode {
  return value === 'cold-start' ||
    value === 'deep-mining' ||
    value === 'incremental-correction' ||
    value === 'maintenance'
    ? value
    : 'maintenance';
}

function readDepth(value: string): ScanDepth {
  return value === 'light' || value === 'standard' || value === 'deep' || value === 'exhaustive'
    ? value
    : 'standard';
}

function readStatus(value: string): ScanRunStatus {
  return value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled'
    ? value
    : 'failed';
}
