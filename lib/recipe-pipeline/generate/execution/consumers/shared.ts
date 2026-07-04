/**
 * shared — consumers/ 拆分模块间真实共享的类型与判定助手
 *
 * 结构清洗 W2：自 GenerateConsumers.ts 纯移动拆出。仅存放被 2+ 拆分模块
 * （DimensionResultConsumer / CandidateAccounting / SessionResultConsumer /
 * TierReflectionConsumer / skill-delivery/SkillConsumer）共同消费的符号：
 *   - DimensionStat：维度统计（Dimension/Session/Tier 三方消费）
 *   - CandidateResults：候选计数账本（Dimension 结果/错误路径 + 候选记账）
 *   - DimensionCandidateData：维度候选产物（Dimension/记账/Skill 三方消费）
 *   - GenerateDimensionRunIssueState：运行问题判定态（Dimension 产出、记账消费）
 *   - isRecord：结构化记录判定（记账助手与错误归类共用）
 */

import type { AgentEfficiencySummary } from '#recipe-pipeline/generate/runtime/GenerateEfficiency.js';
import type {
  GenerateDimensionAnalysisReport,
  GenerateDimensionProducerResult,
  GenerateDimensionRunIssue,
} from '../AgentRunProjections.js';
import type { PcvNodeEvidenceEnvelope } from '../PcvStageNodeMap.js';

export interface DimensionStat {
  candidateCount: number;
  rejectedCount?: number;
  analysisChars?: number;
  referencedFiles?: number;
  referencedFilesList?: string[];
  durationMs: number;
  toolCallCount?: number;
  tokenUsage?: { input: number; output: number };
  efficiency?: AgentEfficiencySummary | null;
  skipped?: boolean;
  restoredFromCheckpoint?: boolean;
  restoredFromIncremental?: boolean;
  analysisText?: string;
  error?: string;
  pcvNodeEvidenceEnvelope?: PcvNodeEvidenceEnvelope;
  [key: string]: unknown;
}

export interface CandidateResults {
  created: number;
  failed: number;
  errors: Array<{ dimId: string; error: string }>;
}

export interface DimensionCandidateData {
  analysisReport: GenerateDimensionAnalysisReport;
  producerResult: GenerateDimensionProducerResult;
}

export interface GenerateDimensionRunIssueState {
  effectiveCandidateCount: number;
  isNormalCompletion: boolean;
  rawRunIssue: GenerateDimensionRunIssue | null;
  recoveredProducerTimeout: boolean;
  runIssue: GenerateDimensionRunIssue | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
