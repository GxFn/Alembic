import type { BootstrapDimensionFillResult } from '#workflows/bootstrap/BootstrapWorkflow.js';
import type { ColdStartScanContext } from '#workflows/scan/lifecycle/ColdStartScanContext.js';

export interface ColdStartBaselineCoverageSummary extends Record<string, unknown> {
  dimensionsTotal: number;
  dimensionsActive: number;
  dimensionsSkipped: number;
  dimensionsIncrementalSkipped: number;
  dimensionsWithCandidates: number;
  dimensionsWithAnalysis: number;
  dimensionCoverageRatio: number;
  filesTotal: number;
  referencedFiles: number;
  referencedFileMentions: number;
  fileCoverageRatio: number;
}

export interface ColdStartBaselineResult extends Record<string, unknown> {
  mode: 'cold-start';
  baselineRunId: string | null;
  baselineSnapshotId: string | null;
  executionStatus: BootstrapDimensionFillResult['status'] | 'handler-complete';
  coverage: ColdStartBaselineCoverageSummary;
  candidates: { created: number; failed: number };
  skills: { created: number; failed: number };
  evidence: Record<string, unknown> | null;
  totalTimeMs: number;
  totalToolCalls: number;
  totalTokenUsage: { input: number; output: number };
  incremental: boolean;
  recommendations: [];
}

export interface ProjectColdStartBaselineOptions {
  scanRunId?: string | null;
  scanContext?: ColdStartScanContext | null;
  execution?: BootstrapDimensionFillResult | null;
  summary?: Record<string, unknown> | null;
}

export function projectColdStartBaselineResult({
  scanRunId,
  scanContext,
  execution,
  summary,
}: ProjectColdStartBaselineOptions): ColdStartBaselineResult {
  const rawSummary = execution?.summary ?? summary ?? {};
  const coverage = readCoverage(rawSummary.coverage);
  const baselineRunId = scanRunId ?? scanContext?.run?.id ?? null;

  return {
    mode: 'cold-start',
    baselineRunId,
    baselineSnapshotId: readNullableString(rawSummary.snapshotId),
    executionStatus: execution?.status ?? 'handler-complete',
    coverage,
    candidates: {
      created: readNumber(rawSummary.candidatesCreated),
      failed: readNumber(rawSummary.candidatesFailed),
    },
    skills: {
      created: readNumber(rawSummary.skillsCreated),
      failed: readNumber(rawSummary.skillsFailed),
    },
    evidence: scanContext?.evidenceSummary ?? null,
    totalTimeMs: readNumber(rawSummary.totalTimeMs),
    totalToolCalls: readNumber(rawSummary.totalToolCalls),
    totalTokenUsage: readTokenUsage(rawSummary.totalTokenUsage),
    incremental: readBoolean(rawSummary.incremental),
    recommendations: [],
  };
}

function readCoverage(value: unknown): ColdStartBaselineCoverageSummary {
  const coverage = asRecord(value);
  const dimensionsTotal = readNumber(coverage.dimensionsTotal);
  const dimensionsActive = readNumber(coverage.dimensionsActive);
  const dimensionsSkipped = readNumber(coverage.dimensionsSkipped);
  const dimensionsIncrementalSkipped = readNumber(coverage.dimensionsIncrementalSkipped);
  const dimensionsWithCandidates = readNumber(coverage.dimensionsWithCandidates);
  const dimensionsWithAnalysis = readNumber(coverage.dimensionsWithAnalysis);
  const filesTotal = readNumber(coverage.filesTotal);
  const referencedFiles = readNumber(coverage.referencedFiles);
  const referencedFileMentions = readNumber(coverage.referencedFileMentions);

  return {
    dimensionsTotal,
    dimensionsActive,
    dimensionsSkipped,
    dimensionsIncrementalSkipped,
    dimensionsWithCandidates,
    dimensionsWithAnalysis,
    dimensionCoverageRatio: ratio(dimensionsWithAnalysis, Math.max(dimensionsActive, 1)),
    filesTotal,
    referencedFiles,
    referencedFileMentions,
    fileCoverageRatio: ratio(referencedFiles, Math.max(filesTotal, 1)),
  };
}

function readTokenUsage(value: unknown): { input: number; output: number } {
  const tokenUsage = asRecord(value);
  return {
    input: readNumber(tokenUsage.input),
    output: readNumber(tokenUsage.output),
  };
}

function ratio(value: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Number(Math.min(value / total, 1).toFixed(4));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readBoolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false;
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
