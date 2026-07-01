/**
 * BootstrapProjections — AgentRunResult 到领域结构的投影层
 *
 * 将 AgentRuntime 返回的原始 AgentRunResult 投影为 Bootstrap 领域所需的
 * 结构化数据（维度分析报告、候选提取、会话统计等），供 BootstrapConsumers 消费。
 */

import type { AgentDiagnostics, AgentEfficiencySummary } from '@alembic/agent/runtime';
import type { AgentRunResult } from '@alembic/agent/service';
import {
  extractEfficiencyFromDiagnostics,
  normalizeAgentEfficiencySummary,
} from '#service/bootstrap/BootstrapEfficiency.js';
import {
  normalizeProjectScopeSourceRefsForRuntime,
  type ProjectScopeSourceIdentity,
} from '../../project-scope/ProjectScopeAnalysis.js';

export interface ToolCallRecord {
  tool?: string;
  name?: string;
  args?: Record<string, unknown>;
  params?: Record<string, unknown>;
  result?: unknown;
  [key: string]: unknown;
}

export interface AgentResultLike {
  reply?: string;
  status?: AgentRunResult['status'];
  toolCalls?: ToolCallRecord[];
  tokenUsage?: { input: number; output: number };
  // Agent phase results are dynamic because strategies can attach different artifacts.
  phases?: Record<string, { reply?: string; artifact?: Record<string, any>; [key: string]: any }>;
  degraded?: boolean;
  diagnostics?: AgentDiagnostics | null;
  efficiency?: AgentEfficiencySummary | null;
  [key: string]: unknown;
}

export interface DimensionFinding {
  finding?: string;
  evidence?: string[] | string;
  importance?: number;
  category?: string;
  source?: string;
}

export interface BootstrapDimensionAnalysisReport {
  dimensionId?: string;
  analysisText: string;
  findings: Array<DimensionFinding | string>;
  referencedFiles: string[];
  evidenceMap?: Record<string, string[]> | null;
  negativeSignals?: string[];
  metadata?: Record<string, unknown>;
}

export interface BootstrapDimensionProducerResult {
  candidateCount: number;
  rejectedCount?: number;
  toolCalls: ToolCallRecord[];
  reply?: string;
  tokenUsage?: { input: number; output: number };
  efficiency?: AgentEfficiencySummary | null;
}

export interface BootstrapDimensionProjection {
  analyzeResult?: { reply?: string; [key: string]: unknown };
  gateResult?: { action?: string; artifact?: Record<string, any>; [key: string]: unknown };
  produceResult?: { reply?: string; toolCalls?: ToolCallRecord[]; [key: string]: unknown };
  analysisText: string;
  artifact: Record<string, any>;
  runtimeToolCalls: ToolCallRecord[];
  combinedTokenUsage: { input: number; output: number };
  efficiency: AgentEfficiencySummary | null;
  analysisReport: BootstrapDimensionAnalysisReport;
  producerResult: BootstrapDimensionProducerResult;
  submitCalls: ToolCallRecord[];
  successCount: number;
  rejectedCount: number;
}

export type BootstrapDimensionRunIssueStatus =
  | 'timeout'
  | 'blocked'
  | 'aborted'
  | 'error'
  | 'degraded_budget_exhausted'
  | 'degraded_no_findings'
  | 'record_repair_incomplete'
  | 'quality_gate_failed'
  | 'l4_compaction_failed_budget_exhausted';

export interface BootstrapDimensionRunIssue {
  status: BootstrapDimensionRunIssueStatus;
  reason: string;
  diagnostics?: AgentDiagnostics | null;
}

export function isRecoverableProducerTimeoutIssue({
  issue,
  needsCandidates,
  produceResult,
  successCount,
}: {
  issue: BootstrapDimensionRunIssue | null;
  needsCandidates: boolean;
  produceResult?: { reply?: string; toolCalls?: ToolCallRecord[]; [key: string]: unknown };
  successCount: number;
}): boolean {
  const timedOutStages = issue?.diagnostics?.timedOutStages || [];
  const timeoutMatchesProducer = timedOutStages.length === 0 || timedOutStages.includes('produce');
  return (
    issue?.status === 'timeout' &&
    needsCandidates &&
    successCount > 0 &&
    !!produceResult &&
    timeoutMatchesProducer
  );
}

export function projectAgentRunResult(result: AgentRunResult): AgentResultLike {
  const usage = result.usage || {
    inputTokens: 0,
    outputTokens: 0,
    iterations: 0,
    durationMs: 0,
  };
  return {
    reply: result.reply,
    status: result.status,
    toolCalls: result.toolCalls as unknown as ToolCallRecord[],
    tokenUsage: {
      input: usage.inputTokens,
      output: usage.outputTokens,
    },
    phases: result.phases as AgentResultLike['phases'],
    degraded: result.diagnostics?.degraded || false,
    diagnostics: result.diagnostics,
    efficiency: extractEfficiencyFromDiagnostics(result.diagnostics),
    iterations: usage.iterations,
    durationMs: usage.durationMs,
  };
}

export function resolveBootstrapDimensionRunIssue(
  result: AgentResultLike | AgentRunResult | null | undefined,
  options: { includeDegraded?: boolean } = {}
): BootstrapDimensionRunIssue | null {
  if (!result) {
    return null;
  }
  const status = typeof result.status === 'string' ? result.status : 'success';
  const diagnostics = result.diagnostics || null;
  const efficiency =
    extractEfficiencyFromDiagnostics(diagnostics) ||
    normalizeAgentEfficiencySummary('efficiency' in result ? result.efficiency : null);
  const reply = result.reply || '';
  if (
    status === 'timeout' ||
    efficiency?.cancelReason === 'stage_timeout' ||
    (diagnostics?.timedOutStages?.length ?? 0) > 0
  ) {
    return {
      status: 'timeout',
      reason: reply || 'stage_timeout',
      diagnostics,
    };
  }
  if (
    efficiency?.cancelReason === 'l4_compaction_failed_budget_exhausted' ||
    reply.includes('l4_compaction_failed_budget_exhausted')
  ) {
    return {
      status: 'l4_compaction_failed_budget_exhausted',
      reason: reply || 'l4_compaction_failed_budget_exhausted',
      diagnostics,
    };
  }
  if (status === 'blocked' || status === 'aborted' || status === 'error') {
    return {
      status,
      reason: reply || (status === 'error' ? 'child-run-error' : `child-run-${status}`),
      diagnostics,
    };
  }
  const qualityGateIssue = resolveUnresolvedQualityGateIssue(result, diagnostics);
  if (qualityGateIssue) {
    return qualityGateIssue;
  }
  if (options.includeDegraded === false) {
    return null;
  }
  const diagnosticsRecord = diagnostics as unknown as { gateFailures?: unknown[] } | null;
  const gateFailures = Array.isArray(diagnosticsRecord?.gateFailures)
    ? diagnosticsRecord.gateFailures
    : [];
  const degradedGate = gateFailures.find((gate): gate is { action: string; reason?: string } => {
    if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
      return false;
    }
    const action = (gate as { action?: unknown }).action;
    return (
      action === 'degraded_budget_exhausted' ||
      action === 'degraded_no_findings' ||
      action === 'record_repair_incomplete'
    );
  });
  if (degradedGate?.action === 'degraded_budget_exhausted') {
    return {
      status: 'degraded_budget_exhausted',
      reason:
        (typeof degradedGate.reason === 'string' ? degradedGate.reason : '') ||
        result.reply ||
        'Quality gate degraded because retry would exceed the session token budget',
      diagnostics,
    };
  }
  if (degradedGate?.action === 'degraded_no_findings') {
    return {
      status: 'degraded_no_findings',
      reason:
        (typeof degradedGate.reason === 'string' ? degradedGate.reason : '') ||
        result.reply ||
        'Quality gate degraded because required evidence findings were not recorded',
      diagnostics,
    };
  }
  if (degradedGate?.action === 'record_repair_incomplete') {
    return {
      status: 'record_repair_incomplete',
      reason:
        (typeof degradedGate.reason === 'string' ? degradedGate.reason : '') ||
        result.reply ||
        'Record repair ended without enough findings',
      diagnostics,
    };
  }
  const resultDegraded = 'degraded' in result ? result.degraded : false;
  if (diagnostics?.degraded || resultDegraded) {
    const reply = result.reply || '';
    if (reply.includes('record_repair_incomplete')) {
      return {
        status: 'record_repair_incomplete',
        reason: reply || 'Record repair ended without enough findings',
        diagnostics,
      };
    }
    if (reply.includes('degraded_budget_exhausted')) {
      return {
        status: 'degraded_budget_exhausted',
        reason:
          reply || 'Quality gate degraded because retry would exceed the session token budget',
        diagnostics,
      };
    }
    if (reply.includes('degraded_no_findings')) {
      return {
        status: 'degraded_no_findings',
        reason:
          reply || 'Quality gate degraded because required evidence findings were not recorded',
        diagnostics,
      };
    }
  }
  return null;
}

function resolveUnresolvedQualityGateIssue(
  result: AgentResultLike | AgentRunResult,
  diagnostics: AgentDiagnostics | null
): BootstrapDimensionRunIssue | null {
  const phases = result.phases || {};
  const gate = phases.quality_gate as
    | {
        pass?: boolean;
        action?: string;
        reason?: string;
        artifact?: { qualityReport?: { suggestions?: string[] } };
      }
    | undefined;
  if (!gate || gate.pass !== false || phases.produce) {
    return null;
  }
  const suggestion = Array.isArray(gate.artifact?.qualityReport?.suggestions)
    ? gate.artifact.qualityReport.suggestions.find(
        (item): item is string => typeof item === 'string' && item.trim().length > 0
      )
    : '';
  return {
    status: 'quality_gate_failed',
    reason: gate.reason || gate.action || suggestion || 'Quality gate failed before producer stage',
    diagnostics,
  };
}

export function projectBootstrapDimensionAgentOutput({
  dimId,
  needsCandidates,
  runResult,
  projectScopeSourceIdentities = [],
}: {
  dimId: string;
  needsCandidates: boolean;
  runResult: AgentResultLike;
  projectScopeSourceIdentities?: ProjectScopeSourceIdentity[];
}): BootstrapDimensionProjection {
  const analyzeResult = runResult?.phases?.analyze;
  const gateResult = runResult?.phases?.quality_gate;
  const produceResult = runResult?.phases?.produce;
  const analysisText = (analyzeResult?.reply || runResult?.reply || '').trim();
  const artifact = gateResult?.artifact || {
    analysisText,
    referencedFiles: [],
    findings: [],
    metadata: { toolCallCount: 0 },
  };

  const runtimeToolCalls = runResult?.toolCalls || [];
  const combinedTokenUsage = runResult?.tokenUsage || { input: 0, output: 0 };
  const efficiency =
    runResult?.efficiency || extractEfficiencyFromDiagnostics(runResult?.diagnostics) || null;
  const rawReferencedFiles =
    artifact.referencedFiles?.length > 0
      ? artifact.referencedFiles
      : [
          ...new Set(
            runtimeToolCalls.flatMap((tc: ToolCallRecord) => {
              const a = tc?.args || tc?.params || {};
              const files: string[] = [];
              if (typeof a.filePath === 'string' && a.filePath.trim()) {
                files.push(a.filePath.trim());
              }
              if (Array.isArray(a.filePaths)) {
                for (const f of a.filePaths) {
                  if (typeof f === 'string' && f.trim()) {
                    files.push(f.trim());
                  }
                }
              }
              return files;
            })
          ),
        ];
  const referencedFilesNormalization = normalizeProjectScopeSourceRefsForRuntime(
    rawReferencedFiles,
    projectScopeSourceIdentities
  );
  const referencedFiles =
    projectScopeSourceIdentities.length > 0
      ? referencedFilesNormalization.activeSourceRefs
      : rawReferencedFiles;

  const analysisReport = {
    dimensionId: dimId,
    analysisText: artifact.analysisText || analysisText,
    findings: artifact.findings || [],
    referencedFiles,
    evidenceMap: artifact.evidenceMap || null,
    negativeSignals: artifact.negativeSignals || [],
    metadata: {
      toolCallCount: runtimeToolCalls.length,
      tokenUsage: combinedTokenUsage,
      efficiency,
      artifactVersion: artifact.metadata?.artifactVersion || 1,
      ...(referencedFilesNormalization.rejected.length > 0
        ? {
            projectScopeSourceRefRejections: referencedFilesNormalization.rejected.map(
              (rejection) => ({
                input: rejection.input,
                reason: rejection.reason,
                status: rejection.status,
              })
            ),
          }
        : {}),
    },
  };

  const producerToolCalls = Array.isArray(produceResult?.toolCalls)
    ? produceResult.toolCalls
    : runtimeToolCalls;
  const submitCalls = producerToolCalls.filter((tc: ToolCallRecord) => {
    const tool = tc?.tool || tc?.name;
    if (tool !== 'knowledge') {
      return false;
    }
    const args = (tc?.args || tc?.params) as Record<string, unknown> | undefined;
    return args?.action === 'submit';
  });
  const successCount = submitCalls.filter((tc: ToolCallRecord) => {
    const res = tc?.result;
    // 核心修正:提交失败时 handleSubmit 走 fail(...)，其 data:null 经信封折叠成 structuredContent:null，
    // 记录到 tc.result 就是 null/undefined。旧逻辑 `if(!res) return true` 把失败当成 accepted，导致
    // 「submitted=N, accepted=N, rejected=0」而真库 0 行。null/非结构化结果一律判为失败;其余保持原判据
    // (显式 rejected/error/error 字段/submitted:false 才算失败，其余非空结果算成功)。
    if (!res) {
      return false;
    }
    if (typeof res === 'string') {
      return !res.includes('rejected') && !res.includes('error');
    }
    const resObj = res as Record<string, unknown>;
    if (resObj.error || resObj.submitted === false) {
      return false;
    }
    return resObj.status !== 'rejected' && resObj.status !== 'error';
  }).length;
  const rejectedCount = submitCalls.length - successCount;

  return {
    analyzeResult,
    gateResult,
    produceResult,
    analysisText,
    artifact,
    runtimeToolCalls,
    combinedTokenUsage,
    efficiency,
    analysisReport,
    producerResult: {
      candidateCount: needsCandidates ? successCount : 0,
      rejectedCount: needsCandidates ? rejectedCount : 0,
      toolCalls: producerToolCalls,
      reply: produceResult?.reply || analysisText,
      tokenUsage: combinedTokenUsage,
      efficiency,
    },
    submitCalls,
    successCount,
    rejectedCount,
  };
}

export function normalizeDimensionFindings(
  findings: Array<DimensionFinding | string> | undefined
): DimensionFinding[] {
  return (findings || [])
    .map((finding) => {
      if (typeof finding === 'string') {
        const normalizedFinding = finding.trim();
        return normalizedFinding ? { finding: normalizedFinding } : null;
      }
      return finding;
    })
    .filter((finding): finding is DimensionFinding => !!finding);
}

// ---------------------------------------------------------------------------
// Session projection
// ---------------------------------------------------------------------------

export interface BootstrapSessionProjection {
  dimensionResults: Record<string, AgentRunResult>;
  completedDimensions: number;
  failedDimensionIds: string[];
  abortedDimensionIds: string[];
  missingDimensionIds: string[];
  parentStatus: AgentRunResult['status'];
}

export function projectBootstrapSessionResult({
  parentRunResult,
  activeDimIds,
  skippedDimIds,
}: {
  parentRunResult: AgentRunResult;
  activeDimIds: string[];
  skippedDimIds: string[];
}): BootstrapSessionProjection {
  const dimensionResults = toBootstrapSessionDimensionResults(parentRunResult);
  const skipped = new Set(skippedDimIds);
  const runnableDimIds = activeDimIds.filter((dimId) => !skipped.has(dimId));
  const failedDimensionIds = Object.entries(dimensionResults)
    .filter(([, result]) => {
      const issue = resolveBootstrapDimensionRunIssue(result);
      if (issue?.status === 'timeout') {
        const projection = projectBootstrapDimensionAgentOutput({
          dimId: '',
          needsCandidates: true,
          runResult: projectAgentRunResult(result),
        });
        if (
          isRecoverableProducerTimeoutIssue({
            issue,
            needsCandidates: true,
            produceResult: projection.produceResult,
            successCount: projection.successCount,
          })
        ) {
          return false;
        }
      }
      if (issue && issue.status !== 'aborted') {
        return true;
      }
      return typeof result.reply === 'string'
        ? result.reply.includes('l4_compaction_failed_budget_exhausted')
        : false;
    })
    .map(([dimId]) => dimId);
  const abortedDimensionIds = Object.entries(dimensionResults)
    .filter(([, result]) => result.status === 'aborted')
    .map(([dimId]) => dimId);
  const missingDimensionIds = runnableDimIds.filter((dimId) => !dimensionResults[dimId]);
  return {
    dimensionResults,
    completedDimensions: Object.keys(dimensionResults).length,
    failedDimensionIds,
    abortedDimensionIds,
    missingDimensionIds,
    parentStatus: parentRunResult.status,
  };
}

export function toBootstrapSessionDimensionResults(parentRunResult: AgentRunResult) {
  const dimensionResults = parentRunResult.phases?.dimensionResults;
  if (
    !dimensionResults ||
    typeof dimensionResults !== 'object' ||
    Array.isArray(dimensionResults)
  ) {
    return {};
  }
  return dimensionResults as Record<string, AgentRunResult>;
}
