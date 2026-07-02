/**
 * Bootstrap Event Types — 事件 payload 类型化
 *
 * 替代 GenerateEventEmitter 中所有 `Record<string, unknown>` payload，
 * 通过 discriminated union（`type` 字段）实现编译期事件校验。
 *
 * @module service/bootstrap/bootstrap-event-types
 */

import type { CreateJobProcessEventInput } from '@alembic/core/daemon';
import type {
  ProjectSkillDeliveryReceipt,
  ProjectSkillDeliveryValidationResult,
} from '@alembic/core/host-agent-workflows';
import type { AgentEfficiencySummary } from './GenerateEfficiency.js';

// ── DimensionComplete payload variants ───────────────────────

// W2(2026-07-02 全空间统一):基础 payload 骨架收编 Core 单源;本文件保留
// 主体收窄(efficiency/deliveryReceipt 具体类型)与 daemon 专属 process-event 类型。
export type {
  DimensionCheckpointRestoredPayload,
  DimensionErrorPayload,
  DimensionHostCompletePayload,
  DimensionRestoredPayload,
  DimensionSkippedPayload,
  ProgressPayload,
} from '@alembic/core/knowledge';

import type {
  DimensionPipelineCompletePayload as CoreDimensionPipelineCompletePayload,
  DimensionSkillPayload as CoreDimensionSkillPayload,
  DimensionCheckpointRestoredPayload,
  DimensionErrorPayload,
  DimensionHostCompletePayload,
  DimensionRestoredPayload,
  DimensionSkippedPayload,
  ProgressPayload,
} from '@alembic/core/knowledge';

/** 主体收窄:efficiency 是 daemon 观测的具体类型(Core 基础契约为 unknown)。 */
export interface DimensionPipelineCompletePayload extends CoreDimensionPipelineCompletePayload {
  efficiency?: AgentEfficiencySummary | null;
}

/** 主体收窄:skill 交付回执具体类型。 */
export interface DimensionSkillPayload extends CoreDimensionSkillPayload {
  deliveryReceipt?: ProjectSkillDeliveryReceipt;
  deliveryReceiptValidation?: ProjectSkillDeliveryValidationResult;
}

/** Discriminated union — 主体版(收窄成员替换基础成员)。 */
export type DimensionCompletePayload =
  | DimensionSkippedPayload
  | DimensionRestoredPayload
  | DimensionCheckpointRestoredPayload
  | DimensionErrorPayload
  | DimensionPipelineCompletePayload
  | DimensionSkillPayload
  | DimensionHostCompletePayload;

export type GenerateProcessEventDraft = Omit<
  CreateJobProcessEventInput,
  'createdAt' | 'id' | 'jobId' | 'sequence'
> & {
  textArtifactCandidate?: GenerateProcessEventTextArtifactCandidate;
  createdAt?: string;
  id?: string;
  sequence?: number;
};

export interface GenerateProcessEventTextArtifactCandidate {
  kind: string;
  label: string | null;
  mimeType: string | null;
  originalChars: number;
  redactionState: 'developer-visible-redacted';
  text: string;
}

export interface GenerateProcessEventsPayload extends ProgressPayload {
  dimensionId?: string;
  events: GenerateProcessEventDraft[];
  sessionId: string;
  source?: string;
  targetName?: string;
  taskId?: string;
}
