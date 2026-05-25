/**
 * Bootstrap Event Types — 事件 payload 类型化
 *
 * 替代 BootstrapEventEmitter 中所有 `Record<string, unknown>` payload，
 * 通过 discriminated union（`type` 字段）实现编译期事件校验。
 *
 * @module service/bootstrap/bootstrap-event-types
 */

import type { CreateJobProcessEventInput } from '@alembic/core/daemon';
import type {
  ProjectSkillDeliveryReceipt,
  ProjectSkillDeliveryValidationResult,
} from '@alembic/core/host-agent-workflows';
import type { AgentEfficiencySummary } from './BootstrapEfficiency.js';

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
  status?: string;
  diagnostics?: unknown;
  efficiency?: AgentEfficiencySummary | null;
}

export interface DimensionPipelineCompletePayload {
  type: 'candidate' | 'skill';
  extracted: number;
  created: number;
  status: string;
  reason?: string;
  degraded: boolean;
  durationMs: number;
  diagnostics?: unknown;
  toolCallCount: number;
  tokenUsage?: { input: number; output: number };
  efficiency?: AgentEfficiencySummary | null;
  source: string;
}

export interface DimensionSkillPayload {
  type: 'skill';
  deliveryReceipt?: ProjectSkillDeliveryReceipt;
  deliveryReceiptSummary?: string;
  deliveryReceiptValidation?: ProjectSkillDeliveryValidationResult;
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

// ── Job process event bridge payloads ───────────────────────

export type BootstrapProcessEventDraft = Omit<
  CreateJobProcessEventInput,
  'createdAt' | 'id' | 'jobId' | 'sequence'
> & {
  textArtifactCandidate?: BootstrapProcessEventTextArtifactCandidate;
  createdAt?: string;
  id?: string;
  sequence?: number;
};

export interface BootstrapProcessEventTextArtifactCandidate {
  kind: string;
  label: string | null;
  mimeType: string | null;
  originalChars: number;
  redactionState: 'developer-visible-redacted';
  text: string;
}

export interface BootstrapProcessEventsPayload extends ProgressPayload {
  dimensionId?: string;
  events: BootstrapProcessEventDraft[];
  sessionId: string;
  source?: string;
  targetName?: string;
  taskId?: string;
}
