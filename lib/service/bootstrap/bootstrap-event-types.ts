/**
 * Bootstrap Event Types — 事件 payload 类型化
 *
 * 替代 BootstrapEventEmitter 中所有 `Record<string, unknown>` payload，
 * 通过 discriminated union（`type` 字段）实现编译期事件校验。
 *
 * @module service/bootstrap/bootstrap-event-types
 * @see docs/copilot/unified-project-snapshot-design.md §11.3 H6
 */

// ── DimensionComplete payload variants ───────────────────────

export interface DimensionSkippedPayload {
  type: 'skipped';
  reason: string;
}

export interface DimensionRestoredPayload {
  type: 'incremental-restored';
  reason: string;
}

export interface DimensionCheckpointRestoredPayload {
  type: 'checkpoint-restored';
  [key: string]: unknown;
}

export interface DimensionErrorPayload {
  type: 'error';
  reason: string;
}

export interface DimensionPipelineCompletePayload {
  type: 'candidate' | 'skill';
  extracted: number;
  created: number;
  status: string;
  degraded: boolean;
  durationMs: number;
  toolCallCount: number;
  source: string;
}

export interface DimensionSkillPayload {
  type: 'skill';
  skillName: string;
  sourceCount: number;
}

export interface DimensionExternalCompletePayload {
  type: 'skill' | 'candidate';
  extracted: number;
  skillCreated: boolean;
  recipesBound: number;
  progress: string;
  isBootstrapComplete: boolean;
  source: string;
}

/** Discriminated union — 通过 `type` 字段区分 */
export type DimensionCompletePayload =
  | DimensionSkippedPayload
  | DimensionRestoredPayload
  | DimensionCheckpointRestoredPayload
  | DimensionErrorPayload
  | DimensionPipelineCompletePayload
  | DimensionSkillPayload
  | DimensionExternalCompletePayload;

// ── Other event payloads ─────────────────────────────────────

export interface ProgressPayload {
  [key: string]: unknown;
}
