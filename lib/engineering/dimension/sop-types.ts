/** 分析阶段定义（Phase 1-3） */
export interface SopPhase {
  readonly name: string;
  readonly action: string;
  readonly output: string;
  readonly tools?: readonly string[];
}

/** 紧凑 SOP 输入：每个维度只维护差异化阶段和提交规则。 */
export interface CompactSop {
  readonly keywords?: readonly string[];
  readonly phases: readonly [SopPhase, SopPhase, SopPhase];
  readonly submitAction: string;
  readonly submitExtras?: readonly string[];
  readonly mistakes: readonly string[];
}

/** 完整 SOP 步骤（消费者使用的形状） */
export interface FullSopStep {
  phase: string;
  action: string;
  expectedOutput?: string;
  tools?: string[];
  qualityChecklist?: string[];
  [key: string]: unknown;
}

/** 完整 SOP 对象（消费者使用的形状） */
export interface FullSop {
  focusKeywords?: string[];
  steps: FullSopStep[];
  timeEstimate: string;
  commonMistakes: string[];
  [key: string]: unknown;
}
