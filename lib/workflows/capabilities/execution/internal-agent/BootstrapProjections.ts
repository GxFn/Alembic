import type { AgentRunResult } from '#agent/service/index.js';

// ---------------------------------------------------------------------------
// Dimension projection
// ---------------------------------------------------------------------------

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
  toolCalls?: ToolCallRecord[];
  tokenUsage?: { input: number; output: number };
  // Agent phase results are dynamic because strategies can attach different artifacts.
  phases?: Record<string, { reply?: string; artifact?: Record<string, any>; [key: string]: any }>;
  degraded?: boolean;
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
}

export interface BootstrapDimensionProjection {
  analyzeResult?: { reply?: string; [key: string]: unknown };
  gateResult?: { action?: string; artifact?: Record<string, any>; [key: string]: unknown };
  produceResult?: { reply?: string; toolCalls?: ToolCallRecord[]; [key: string]: unknown };
  analysisText: string;
  artifact: Record<string, any>;
  runtimeToolCalls: ToolCallRecord[];
  combinedTokenUsage: { input: number; output: number };
  analysisReport: BootstrapDimensionAnalysisReport;
  producerResult: BootstrapDimensionProducerResult;
  submitCalls: ToolCallRecord[];
  successCount: number;
  rejectedCount: number;
}

export function projectAgentRunResult(result: AgentRunResult): AgentResultLike {
  return {
    reply: result.reply,
    toolCalls: result.toolCalls as unknown as ToolCallRecord[],
    tokenUsage: {
      input: result.usage.inputTokens,
      output: result.usage.outputTokens,
    },
    phases: result.phases as AgentResultLike['phases'],
    degraded: result.diagnostics?.degraded || false,
    diagnostics: result.diagnostics,
    iterations: result.usage.iterations,
    durationMs: result.usage.durationMs,
  };
}

export function projectBootstrapDimensionAgentOutput({
  dimId,
  needsCandidates,
  runResult,
}: {
  dimId: string;
  needsCandidates: boolean;
  runResult: AgentResultLike;
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
  const referencedFiles =
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
      artifactVersion: artifact.metadata?.artifactVersion || 1,
    },
  };

  const submitCalls = runtimeToolCalls.filter((tc: ToolCallRecord) => {
    const tool = tc?.tool || tc?.name;
    return tool === 'submit_knowledge' || tool === 'submit_with_check';
  });
  const successCount = submitCalls.filter((tc: ToolCallRecord) => {
    const res = tc?.result;
    if (!res) {
      return true;
    }
    if (typeof res === 'string') {
      return !res.includes('rejected') && !res.includes('error');
    }
    return (
      (res as Record<string, unknown>).status !== 'rejected' &&
      (res as Record<string, unknown>).status !== 'error'
    );
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
    analysisReport,
    producerResult: {
      candidateCount: needsCandidates ? successCount : 0,
      rejectedCount: needsCandidates ? rejectedCount : 0,
      toolCalls: runtimeToolCalls,
      reply: produceResult?.reply || analysisText,
      tokenUsage: combinedTokenUsage,
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
  const failedStatuses = new Set<AgentRunResult['status']>(['error', 'blocked', 'timeout']);
  const failedDimensionIds = Object.entries(dimensionResults)
    .filter(([, result]) => failedStatuses.has(result.status))
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
