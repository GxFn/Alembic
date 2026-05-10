import type { SourceRef } from "./SourceRef.js";

/**
 * GuardFinding 只属于运行期。
 * 它表示针对当前 file/diff/context 的前向检查，不表示对整个知识库的反向审计。
 */
export type GuardFindingSeverity = "info" | "warning" | "error";

export interface CaptureDraft {
  id: string;
  title: string;
  body: string;
  sourceRefIds: string[];
  suggestedRecipeId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface RescanRequest {
  id: string;
  reason: string;
  files: string[];
  recipeIds: string[];
  metadata?: Record<string, unknown> | undefined;
}

export interface GuardFinding {
  id: string;
  severity: GuardFindingSeverity;
  ruleRecipeId: string;
  message: string;
  file?: string | undefined;
  line?: number | undefined;
  evidence: SourceRef[];
  suggestedFix?: string | undefined;
  captureDraft?: CaptureDraft | undefined;
  rescanRequest?: RescanRequest | undefined;
  metadata?: Record<string, unknown> | undefined;
}
