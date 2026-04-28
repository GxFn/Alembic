import { randomBytes } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { DrizzleDB } from '../../infrastructure/database/drizzle/index.js';
import { scanEvidencePacks } from '../../infrastructure/database/drizzle/schema.js';
import type { KnowledgeEvidencePack } from '../../workflows/scan/ScanTypes.js';

export type ScanEvidencePackKind =
  | 'retrieval'
  | 'cold-start'
  | 'incremental-correction'
  | 'deep-mining';

export interface ScanEvidencePackRecord {
  id: string;
  runId: string;
  packKind: ScanEvidencePackKind;
  pack: KnowledgeEvidencePack;
  summary: Record<string, unknown>;
  charCount: number;
  truncated: boolean;
  createdAt: number;
}

export interface CreateScanEvidencePackInput {
  runId: string;
  packKind?: ScanEvidencePackKind;
  pack: KnowledgeEvidencePack;
  summary?: Record<string, unknown>;
}

type ScanEvidencePackRow = typeof scanEvidencePacks.$inferSelect;

export class ScanEvidencePackRepository {
  readonly #drizzle: DrizzleDB;
  readonly #now: () => number;

  constructor(drizzle: DrizzleDB, now: () => number = Date.now) {
    this.#drizzle = drizzle;
    this.#now = now;
  }

  create(input: CreateScanEvidencePackInput): ScanEvidencePackRecord {
    const createdAt = this.#now();
    const packJson = JSON.stringify(input.pack);
    const record: ScanEvidencePackRecord = {
      id: ScanEvidencePackRepository.#generateId(createdAt),
      runId: input.runId,
      packKind: input.packKind ?? 'retrieval',
      pack: input.pack,
      summary: input.summary ?? {},
      charCount: packJson.length,
      truncated: input.pack.diagnostics.truncated,
      createdAt,
    };

    this.#drizzle
      .insert(scanEvidencePacks)
      .values({
        id: record.id,
        runId: record.runId,
        packKind: record.packKind,
        packJson,
        summaryJson: JSON.stringify(record.summary),
        charCount: record.charCount,
        truncated: record.truncated ? 1 : 0,
        createdAt,
      })
      .run();

    return record;
  }

  findById(id: string): ScanEvidencePackRecord | null {
    const row = this.#drizzle
      .select()
      .from(scanEvidencePacks)
      .where(eq(scanEvidencePacks.id, id))
      .limit(1)
      .get();
    return row ? ScanEvidencePackRepository.#mapRow(row) : null;
  }

  findByRunId(runId: string): ScanEvidencePackRecord[] {
    return this.#drizzle
      .select()
      .from(scanEvidencePacks)
      .where(eq(scanEvidencePacks.runId, runId))
      .orderBy(desc(scanEvidencePacks.createdAt))
      .all()
      .map((row) => ScanEvidencePackRepository.#mapRow(row));
  }

  static #mapRow(row: ScanEvidencePackRow): ScanEvidencePackRecord {
    return {
      id: row.id,
      runId: row.runId,
      packKind: readKind(row.packKind),
      pack: readJson(row.packJson, emptyPack()),
      summary: readJson(row.summaryJson, {}),
      charCount: row.charCount,
      truncated: row.truncated === 1,
      createdAt: row.createdAt,
    };
  }

  static #generateId(now: number): string {
    return `pack-${now}-${randomBytes(4).toString('hex')}`;
  }
}

function readKind(value: string): ScanEvidencePackKind {
  return value === 'cold-start' || value === 'incremental-correction' || value === 'deep-mining'
    ? value
    : 'retrieval';
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

function emptyPack(): KnowledgeEvidencePack {
  return {
    project: { root: '', primaryLang: 'unknown', fileCount: 0, modules: [] },
    files: [],
    knowledge: [],
    graph: { entities: [], edges: [] },
    gaps: [],
    diagnostics: { truncated: false, warnings: [], retrievalMs: 0 },
  };
}
