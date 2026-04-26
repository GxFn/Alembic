export type ToolDecisionStage = 'discover' | 'plan' | 'approve' | 'execute';
export type ToolDecisionResultStatus = 'blocked' | 'aborted' | 'timeout' | 'needs-confirmation';

export interface ToolExecutionPreview {
  kind: string;
  summary: string;
  risk?: 'low' | 'medium' | 'high';
  details: Record<string, unknown>;
}

export interface ToolDecision {
  allowed: boolean;
  stage: ToolDecisionStage;
  reason?: string;
  resultStatus?: ToolDecisionResultStatus;
  requiresConfirmation?: boolean;
  confirmationMessage?: string;
  requestId?: string;
  policyProfile?: string;
  auditLevel?: string;
  preview?: ToolExecutionPreview;
}

export function allowToolDecision(stage: ToolDecisionStage, extras: Partial<ToolDecision> = {}) {
  return { allowed: true, stage, ...extras };
}

export function denyToolDecision(
  stage: ToolDecisionStage,
  reason: string,
  extras: Partial<ToolDecision> = {}
) {
  return { allowed: false, stage, reason, ...extras };
}
