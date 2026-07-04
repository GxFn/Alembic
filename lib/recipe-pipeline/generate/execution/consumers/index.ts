/**
 * consumers/index — 结构清洗 W2 拆分后的兼容 re-export 入口
 *
 * 逐一原样重导出拆分前 GenerateConsumers.ts 的全部导出符号（同名同面），
 * 既有 import 经 GenerateConsumers.ts → 本文件零断裂；拆分模块内部新增的
 * 跨模块助手（如 logGenerateDimensionProducerSummary / isRecord）不在此
 * 暴露，保持旧导出面字节不变。
 */

export {
  buildEffectiveSkillAnalysisText,
  type ConsumeGenerateSkillsOptions,
  consumeGenerateSkills,
  extractSkillKeyFindings,
  type GenerateSkillDimension,
  type SkillResults,
} from '../../skill-delivery/SkillConsumer.js';
export {
  applyGenerateDimensionCandidateAccounting,
  type GenerateDimensionCandidateAccountingResult,
} from './CandidateAccounting.js';
export {
  applyGenerateDimensionErrorAccounting,
  buildGenerateDimensionCompleteEventPayload,
  buildGenerateDimensionErrorEventPayload,
  buildGenerateDimensionErrorPcvEvidenceEnvelope,
  buildGenerateDimensionPcvEvidenceEnvelope,
  type ConsumeGenerateDimensionResultOptions,
  consumeGenerateDimensionError,
  consumeGenerateDimensionResult,
  decideGenerateDimensionCheckpoint,
  type GenerateDimensionCheckpointDecision,
  type GenerateDimensionPcvEvidenceResult,
  recordGenerateDimensionTokenUsage,
  resolveGenerateDimensionConsumerRunIssue,
} from './DimensionResultConsumer.js';
export {
  type ConsumeGenerateSessionResultOptions,
  consumeGenerateSessionResult,
  consumeMissingGenerateDimensions,
} from './SessionResultConsumer.js';
export type {
  CandidateResults,
  DimensionCandidateData,
  DimensionStat,
  GenerateDimensionRunIssueState,
} from './shared.js';
export {
  type ConsumeGenerateTierReflectionOptions,
  consumeGenerateTierReflection,
  type GenerateTierReflection,
} from './TierReflectionConsumer.js';
