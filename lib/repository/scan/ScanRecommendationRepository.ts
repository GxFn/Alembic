import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DrizzleDB } from '../../infrastructure/database/drizzle/index.js';
import { scanRecommendations } from '../../infrastructure/database/drizzle/schema.js';
import type {
  ScanRecommendationPriority,
  ScanRecommendationStatus,
  ScanRecommendedRun,
  ScanScope,
} from '../../workflows/scan/ScanTypes.js';

export interface ScanRecommendationRecord {
  id: string;
  projectRoot: string;
  sourceRunId: string | null;
  targetMode: ScanRecommendedRun['mode'];
  status: ScanRecommendationStatus;
  reason: string;
  scope: ScanScope;
  priority: ScanRecommendationPriority;
  queuedJobId: string | null;
  executedRunId: string | null;
  dismissedReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateScanRecommendationInput {
  projectRoot: string;
  sourceRunId?: string | null;
  mode: ScanRecommendedRun['mode'];
  reason: string;
  scope?: ScanScope;
  priority?: ScanRecommendationPriority;
}

export interface ScanRecommendationFilter {
  projectRoot?: string;
  sourceRunId?: string;
  mode?: ScanRecommendedRun['mode'];
  status?: ScanRecommendationStatus | ScanRecommendationStatus[];
  limit?: number;
}

type ScanRecommendationRow = typeof scanRecommendations.$inferSelect;

export class ScanRecommendationRepository {
  readonly #drizzle: DrizzleDB;
  readonly #now: () => number;

  constructor(drizzle: DrizzleDB, now: () => number = Date.now) {
    this.#drizzle = drizzle;
    this.#now = now;
  }

  create(input: CreateScanRecommendationInput): ScanRecommendationRecord {
    const now = this.#now();
    const record: ScanRecommendationRecord = {
      id: ScanRecommendationRepository.#generateId(now),
      projectRoot: input.projectRoot,
      sourceRunId: input.sourceRunId ?? null,
      targetMode: input.mode,
      status: 'pending',
      reason: input.reason,
      scope: input.scope ?? {},
      priority: input.priority ?? 'medium',
      queuedJobId: null,
      executedRunId: null,
      dismissedReason: null,
      createdAt: now,
      updatedAt: now,
    };

    this.#drizzle
      .insert(scanRecommendations)
      .values({
        id: record.id,
        projectRoot: record.projectRoot,
        sourceRunId: record.sourceRunId,
        targetMode: record.targetMode,
        status: record.status,
        reason: record.reason,
        scopeJson: JSON.stringify(record.scope),
        priority: record.priority,
        queuedJobId: record.queuedJobId,
        executedRunId: record.executedRunId,
        dismissedReason: record.dismissedReason,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })
      .run();

    return record;
  }

  createMany(inputs: CreateScanRecommendationInput[]): ScanRecommendationRecord[] {
    return inputs.map((input) => this.create(input));
  }

  findById(id: string): ScanRecommendationRecord | null {
    const row = this.#drizzle
      .select()
      .from(scanRecommendations)
      .where(eq(scanRecommendations.id, id))
      .limit(1)
      .get();
    return row ? ScanRecommendationRepository.#mapRow(row) : null;
  }

  find(filter: ScanRecommendationFilter = {}): ScanRecommendationRecord[] {
    const conditions = [];
    if (filter.projectRoot) {
      conditions.push(eq(scanRecommendations.projectRoot, filter.projectRoot));
    }
    if (filter.sourceRunId) {
      conditions.push(eq(scanRecommendations.sourceRunId, filter.sourceRunId));
    }
    if (filter.mode) {
      conditions.push(eq(scanRecommendations.targetMode, filter.mode));
    }
    if (filter.status) {
      conditions.push(
        Array.isArray(filter.status)
          ? inArray(scanRecommendations.status, filter.status)
          : eq(scanRecommendations.status, filter.status)
      );
    }
    const condition = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    return this.#drizzle
      .select()
      .from(scanRecommendations)
      .where(condition)
      .orderBy(desc(scanRecommendations.createdAt))
      .limit(limit)
      .all()
      .map((row) => ScanRecommendationRepository.#mapRow(row));
  }

  markQueued(id: string, jobId?: string | null): ScanRecommendationRecord | null {
    this.#updateStatus(id, ['pending'], {
      status: 'queued',
      queuedJobId: jobId ?? null,
      updatedAt: this.#now(),
    });
    return this.findById(id);
  }

  markExecuted(id: string, runId?: string | null): ScanRecommendationRecord | null {
    this.#updateStatus(id, ['pending', 'queued'], {
      status: 'executed',
      executedRunId: runId ?? null,
      updatedAt: this.#now(),
    });
    return this.findById(id);
  }

  dismiss(id: string, reason?: string | null): ScanRecommendationRecord | null {
    this.#updateStatus(id, ['pending', 'queued'], {
      status: 'dismissed',
      dismissedReason: reason ?? null,
      updatedAt: this.#now(),
    });
    return this.findById(id);
  }

  #updateStatus(
    id: string,
    fromStatuses: ScanRecommendationStatus[],
    values: Partial<typeof scanRecommendations.$inferInsert>
  ): void {
    this.#drizzle
      .update(scanRecommendations)
      .set(values)
      .where(and(eq(scanRecommendations.id, id), inArray(scanRecommendations.status, fromStatuses)))
      .run();
  }

  static #mapRow(row: ScanRecommendationRow): ScanRecommendationRecord {
    return {
      id: row.id,
      projectRoot: row.projectRoot,
      sourceRunId: row.sourceRunId,
      targetMode: readTargetMode(row.targetMode),
      status: readStatus(row.status),
      reason: row.reason,
      scope: readJson(row.scopeJson, {}),
      priority: readPriority(row.priority),
      queuedJobId: row.queuedJobId,
      executedRunId: row.executedRunId,
      dismissedReason: row.dismissedReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  static #generateId(now: number): string {
    return `scanrec-${now}-${randomBytes(4).toString('hex')}`;
  }
}

function readTargetMode(value: string): ScanRecommendedRun['mode'] {
  return value === 'incremental-correction' ? 'incremental-correction' : 'deep-mining';
}

function readStatus(value: string): ScanRecommendationStatus {
  return value === 'queued' || value === 'dismissed' || value === 'executed' ? value : 'pending';
}

function readPriority(value: string): ScanRecommendationPriority {
  return value === 'low' || value === 'high' ? value : 'medium';
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
