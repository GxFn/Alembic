/**
 * CandidateAccounting — 维度候选记账与 [Producer] 汇总日志（含 unique 双口径）
 *
 * 结构清洗 W2：自 GenerateConsumers.ts 纯移动拆出。负责把维度产出折算进
 * 候选账本（accepted/rejected/sourceRefs/摘要），并输出 [Producer] 双口径
 * 汇总日志；submit 调用成败判定等私有助手随行为一并迁入，逻辑与文案不变。
 */

import Logger from '@alembic/core/logging';
import type {
  AgentResultLike,
  GenerateDimensionProjection,
  ToolCallRecord,
} from '../AgentRunProjections.js';
import {
  type CandidateResults,
  type DimensionCandidateData,
  type GenerateDimensionRunIssueState,
  isRecord,
} from './shared.js';

const logger = Logger.getInstance();

export interface GenerateDimensionCandidateAccountingResult {
  acceptedSubmitCalls: ToolCallRecord[];
  acceptedSourceRefs: string[];
  effectiveCandidateCount: number;
  rejectedCount: number;
  submittedCandidateSummaries: Array<{
    subTopic: string;
    summary: string;
    title: string;
  }>;
}

export function applyGenerateDimensionCandidateAccounting({
  candidateResults,
  dimId,
  dimensionCandidates,
  projection,
  runIssueState,
}: {
  candidateResults: CandidateResults;
  dimId: string;
  dimensionCandidates: Record<string, DimensionCandidateData>;
  projection: GenerateDimensionProjection;
  runIssueState: GenerateDimensionRunIssueState;
}): GenerateDimensionCandidateAccountingResult {
  candidateResults.created += runIssueState.effectiveCandidateCount;
  dimensionCandidates[dimId] = {
    analysisReport: projection.analysisReport,
    producerResult: projection.producerResult,
  };

  const acceptedSubmitCalls = runIssueState.isNormalCompletion
    ? projection.submitCalls.filter(isSuccessfulToolCall)
    : [];
  return {
    acceptedSubmitCalls,
    acceptedSourceRefs: collectAcceptedSubmitCallSourceRefs(acceptedSubmitCalls),
    effectiveCandidateCount: runIssueState.effectiveCandidateCount,
    rejectedCount: runIssueState.isNormalCompletion
      ? projection.producerResult.rejectedCount || 0
      : projection.submitCalls.length,
    submittedCandidateSummaries: acceptedSubmitCalls.map((call) =>
      buildSubmittedCandidateSummary(call, dimId)
    ),
  };
}

/**
 * W2 纯移动：原 consumeGenerateDimensionResult 内联的 [Producer] 汇总日志段
 * （含 M1d 唯一候选双口径计算）整块迁入本模块；触发条件、计算与日志文案逐字不变。
 */
export function logGenerateDimensionProducerSummary({
  dimId,
  needsCandidates,
  projection,
  runIssueState,
  runResult,
}: {
  dimId: string;
  needsCandidates: boolean;
  projection: GenerateDimensionProjection;
  runIssueState: GenerateDimensionRunIssueState;
  runResult: AgentResultLike;
}): void {
  const { analysisReport, analysisText, produceResult, rejectedCount, submitCalls, successCount } =
    projection;
  if (needsCandidates) {
    const producerToolCalls = produceResult?.toolCalls || [];
    const producerToolNames = producerToolCalls.map(
      (tc: ToolCallRecord) => tc?.tool || tc?.name || 'unknown'
    );
    const toolBreakdown: Record<string, number> = {};
    for (const name of producerToolNames) {
      toolBreakdown[name] = (toolBreakdown[name] || 0) + 1;
    }
    const breakdownStr = Object.entries(toolBreakdown)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');

    // M1d（挖掘产出升级）：唯一候选双口径——attempt 口径把"被拒后自救成功"记 1 拒+1 收，
    // 掩盖真实链路健康度；uniqueAttempted 按标题去重（同题重试合并），uniqueRate 才是
    // 接受率的真话（accepted 标题天然互异：同题二收会被查重挡）。
    const uniqueAttempted = new Set(
      submitCalls
        .map((tc: ToolCallRecord) => {
          const params = (tc.args?.params ?? tc.params ?? tc.args ?? {}) as Record<string, unknown>;
          return typeof params.title === 'string' ? params.title.trim().toLowerCase() : '';
        })
        .filter((title: string) => title.length > 0)
    ).size;
    const uniqueRate = uniqueAttempted > 0 ? Math.round((successCount / uniqueAttempted) * 100) : 0;
    logger.info(
      `[Producer] "${dimId}": submitted=${submitCalls.length}, accepted=${successCount}, rejected=${rejectedCount}, ` +
        `unique=${successCount}/${uniqueAttempted || submitCalls.length} (${uniqueRate}%), ` +
        `producerToolCalls=${producerToolCalls.length} (${breakdownStr || 'none'}), ` +
        `analysisInput=${analysisText.length} chars`
    );

    if (successCount === 0 && submitCalls.length === 0 && runIssueState.isNormalCompletion) {
      logger.warn(
        `[Producer] "${dimId}": ⚠ Producer 未提交任何候选。` +
          `分析文本=${analysisText.length} chars, findings=${(analysisReport.findings || []).length}, ` +
          `producerIterations=${producerToolCalls.length}, degraded=${runResult?.degraded || false}`
      );
    }
  }
}

function buildSubmittedCandidateSummary(tc: ToolCallRecord, dimId: string) {
  const params = extractSubmitParams(tc);
  const result = isRecord(tc.result) ? tc.result : {};
  return {
    title: pickString(params.title) || pickString(result.title),
    subTopic: pickString(params.category) || pickString(params.knowledgeType) || dimId,
    summary: pickString(params.summary) || pickString(params.description),
  };
}

function collectAcceptedSubmitCallSourceRefs(acceptedSubmitCalls: readonly ToolCallRecord[]) {
  const refs = acceptedSubmitCalls.flatMap((tc) => {
    const params = extractSubmitParams(tc);
    const reasoningRefs = isRecord(params.reasoning) ? stringArray(params.reasoning.sources) : [];
    return [
      ...stringArray(params.sourceRefs),
      ...stringArray(params.referencedFiles),
      ...reasoningRefs,
    ];
  });
  return uniqueStrings(refs);
}

function extractSubmitParams(tc: ToolCallRecord): Record<string, unknown> {
  const rawArgs = tc.params || tc.args || {};
  const nestedParams = rawArgs.params;
  return isRecord(nestedParams) ? nestedParams : rawArgs;
}

function isSuccessfulToolCall(tc: ToolCallRecord): boolean {
  const res = tc.result;
  // 核心修正:失败的 submit 经 fail(...) → data:null 折叠成 null 结果；非结构化结果同样不是成功。
  // 旧逻辑把这两种都 return true(误记为 accepted，掩盖了真库 0 行)。null/非结构化判为失败;其余保持原判据。
  if (!res) {
    return false;
  }
  if (typeof res === 'string') {
    return !res.includes('rejected') && !res.includes('error');
  }
  if (!isRecord(res)) {
    return false;
  }
  if (res.error || res.submitted === false) {
    return false;
  }
  return res.status !== 'rejected' && res.status !== 'error';
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}
