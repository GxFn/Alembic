/**
 * SessionStore 序列化校验
 *
 * `SessionStore.fromJSON()` 的反序列化入口，对边界数据做轻量类型校验。
 *
 * @module agent/memory/session-store-schema
 */

import type {
  CandidateSummary,
  CrossReference,
  DimensionReport,
  TierReflection,
  WorkingMemoryDistilled,
} from './SessionStore.js';

// ── Serialized Shape ─────────────────────────────────────────

export interface SessionStoreSerialized {
  dimensionReports: Record<string, DimensionReport>;
  crossReferences: CrossReference[];
  tierReflections: TierReflection[];
  submittedCandidates: Record<string, CandidateSummary[]>;
  projectContext: Record<string, unknown>;
  workingMemory?: WorkingMemoryDistilled;
}

// ── Helpers ──────────────────────────────────────────────────

function isRecord(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

// ── Public API ───────────────────────────────────────────────

/**
 * 校验反序列化数据的关键字段类型，返回类型安全的结构。
 */
export function validateSessionStoreShape(raw: Record<string, unknown>): SessionStoreSerialized {
  if (raw.dimensionReports !== undefined && !isRecord(raw.dimensionReports)) {
    throw new Error('SessionStore schema: dimensionReports must be a Record');
  }
  if (raw.crossReferences !== undefined && !Array.isArray(raw.crossReferences)) {
    throw new Error('SessionStore schema: crossReferences must be an array');
  }
  if (raw.tierReflections !== undefined && !Array.isArray(raw.tierReflections)) {
    throw new Error('SessionStore schema: tierReflections must be an array');
  }
  if (raw.submittedCandidates !== undefined && !isRecord(raw.submittedCandidates)) {
    throw new Error('SessionStore schema: submittedCandidates must be a Record');
  }
  return {
    dimensionReports: (raw.dimensionReports as Record<string, DimensionReport>) ?? {},
    crossReferences: (raw.crossReferences as CrossReference[]) ?? [],
    tierReflections: (raw.tierReflections as TierReflection[]) ?? [],
    submittedCandidates: (raw.submittedCandidates as Record<string, CandidateSummary[]>) ?? {},
    projectContext: isRecord(raw.projectContext)
      ? (raw.projectContext as Record<string, unknown>)
      : {},
    workingMemory: isRecord(raw.workingMemory)
      ? (raw.workingMemory as WorkingMemoryDistilled)
      : undefined,
  };
}
