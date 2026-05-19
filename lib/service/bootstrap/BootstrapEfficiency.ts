import type { AgentEfficiencySummary } from '@alembic/agent/runtime';

export type { AgentEfficiencySummary };

export function normalizeAgentEfficiencySummary(value: unknown): AgentEfficiencySummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const tokenUsage = isRecord(value.tokenUsage) ? value.tokenUsage : {};
  const summary: AgentEfficiencySummary = {
    toolCalls: finiteNumber(value.toolCalls),
    duplicateToolCalls: finiteNumber(value.duplicateToolCalls),
    cacheHits: finiteNumber(value.cacheHits),
    cacheMisses: finiteNumber(value.cacheMisses),
    tokenUsage: {
      input: finiteNumber(tokenUsage.input),
      output: finiteNumber(tokenUsage.output),
      reasoning: finiteNumber(tokenUsage.reasoning),
      cacheHit: finiteNumber(tokenUsage.cacheHit),
    },
    maxCompactionLevel: finiteNumber(value.maxCompactionLevel),
    totalCompactedItems: finiteNumber(value.totalCompactedItems),
    nudgeCount: finiteNumber(value.nudgeCount),
    replanCount: finiteNumber(value.replanCount),
    emptyRetries: finiteNumber(value.emptyRetries),
    forcedSummary: value.forcedSummary === true,
  };
  const cancelReason = stringValue(value.cancelReason);
  if (cancelReason) {
    summary.cancelReason = cancelReason;
  }
  return summary;
}

export function mergeAgentEfficiencySummaries(
  values: Iterable<unknown>,
  options: { cancelReason?: string | null } = {}
): AgentEfficiencySummary | null {
  let sawSummary = false;
  const merged: AgentEfficiencySummary = {
    toolCalls: 0,
    duplicateToolCalls: 0,
    cacheHits: 0,
    cacheMisses: 0,
    tokenUsage: { input: 0, output: 0, reasoning: 0, cacheHit: 0 },
    maxCompactionLevel: 0,
    totalCompactedItems: 0,
    nudgeCount: 0,
    replanCount: 0,
    emptyRetries: 0,
    forcedSummary: false,
  };

  for (const value of values) {
    const summary = normalizeAgentEfficiencySummary(value);
    if (!summary) {
      continue;
    }
    sawSummary = true;
    merged.toolCalls += summary.toolCalls;
    merged.duplicateToolCalls += summary.duplicateToolCalls;
    merged.cacheHits += summary.cacheHits;
    merged.cacheMisses += summary.cacheMisses;
    merged.tokenUsage.input += summary.tokenUsage.input;
    merged.tokenUsage.output += summary.tokenUsage.output;
    merged.tokenUsage.reasoning += summary.tokenUsage.reasoning;
    merged.tokenUsage.cacheHit += summary.tokenUsage.cacheHit;
    merged.maxCompactionLevel = Math.max(merged.maxCompactionLevel, summary.maxCompactionLevel);
    merged.totalCompactedItems += summary.totalCompactedItems;
    merged.nudgeCount += summary.nudgeCount;
    merged.replanCount += summary.replanCount;
    merged.emptyRetries += summary.emptyRetries;
    merged.forcedSummary = merged.forcedSummary || summary.forcedSummary;
    if (summary.cancelReason) {
      merged.cancelReason = summary.cancelReason;
    }
  }

  const cancelReason = stringValue(options.cancelReason);
  if (cancelReason) {
    merged.cancelReason = cancelReason;
    sawSummary = true;
  }

  return sawSummary ? merged : null;
}

export function extractEfficiencyFromDiagnostics(
  diagnostics: unknown
): AgentEfficiencySummary | null {
  return normalizeAgentEfficiencySummary(isRecord(diagnostics) ? diagnostics.efficiency : null);
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
