import type { AgentRunInput } from '@alembic/agent/service';
import type { BootstrapProcessEventDraft } from '#service/bootstrap/bootstrap-event-types.js';
import type { BootstrapDimensionPlan } from '#workflows/capabilities/execution/internal-agent/BootstrapDimensionRuntimeBuilder.js';
import type {
  AgentResultLike,
  BootstrapDimensionProjection,
  ToolCallRecord,
} from '#workflows/capabilities/execution/internal-agent/BootstrapProjections.js';

const MAX_TEXT_CHARS = 6000;
const MAX_JSON_TEXT_CHARS = 12000;
const MAX_TOOL_CALLS = 20;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 32;
const MAX_STRING_CHARS = 1600;
const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|bearer|cookie|password|secret|token)/i;
const SECRET_VALUE_PATTERN =
  /\b(sk-(?:proj-)?[a-zA-Z0-9_-]{12,}|AIza[a-zA-Z0-9_-]{10,}|Bearer\s+[a-zA-Z0-9._-]{12,})\b/g;

export function buildBootstrapDimensionInputProcessEvents({
  dimId,
  label,
  plan,
  runInput,
  sessionId,
}: {
  dimId: string;
  label?: string | null;
  plan: BootstrapDimensionPlan;
  runInput: AgentRunInput;
  sessionId: string;
}): BootstrapProcessEventDraft[] {
  const title = `Bootstrap ${label || dimId} input prepared`;
  const inputProjection = projectAgentRunInput(runInput);
  return [
    {
      content: {
        language: 'json',
        mimeType: 'application/json',
        role: 'developer',
        text: jsonText(inputProjection),
      },
      dimensionId: dimId,
      kind: 'llm.input',
      metadata: {
        dimensionId: dimId,
        hasExistingRecipes: plan.hasExistingRecipes,
        inputProjection: 'agent-run-input-summary',
        needsCandidates: plan.needsCandidates,
        rawProviderPayload: false,
        sessionId,
      },
      phase: 'dimension-input',
      summary:
        'Prepared the internal Agent run input. Full prompt expansion, file contents, provider payloads, and secrets are omitted.',
      targetName: label || dimId,
      title,
    },
  ];
}

export function buildBootstrapDimensionResultProcessEvents({
  dimId,
  label,
  projection,
  runResult,
  sessionId,
}: {
  dimId: string;
  label?: string | null;
  projection: BootstrapDimensionProjection;
  runResult: AgentResultLike;
  sessionId: string;
}): BootstrapProcessEventDraft[] {
  const events: BootstrapProcessEventDraft[] = [];
  const toolEvent = buildToolEvent({ dimId, label, projection, sessionId });
  if (toolEvent) {
    events.push(toolEvent);
  }
  const outputEvent = buildVisibleOutputEvent({ dimId, label, projection, runResult, sessionId });
  if (outputEvent) {
    events.push(outputEvent);
  }
  const reflectionEvent = buildReflectionEvent({ dimId, label, projection, runResult, sessionId });
  if (reflectionEvent) {
    events.push(reflectionEvent);
  }
  return events;
}

export function buildBootstrapTierReflectionProcessEvents({
  reflection,
  sessionId,
}: {
  reflection: {
    completedDimensions?: string[];
    crossDimensionPatterns?: string[];
    suggestionsForNextTier?: string[];
    tierIndex: number;
    topFindings?: unknown[];
  };
  sessionId: string;
}): BootstrapProcessEventDraft[] {
  const tierNumber = reflection.tierIndex + 1;
  return [
    {
      content: {
        language: 'json',
        mimeType: 'application/json',
        role: 'developer',
        text: jsonText({
          completedDimensions: reflection.completedDimensions || [],
          crossDimensionPatterns: reflection.crossDimensionPatterns || [],
          suggestionsForNextTier: reflection.suggestionsForNextTier || [],
          tierIndex: reflection.tierIndex,
          topFindings: sanitizeValue(reflection.topFindings || [], 0),
        }),
      },
      kind: 'llm.reflection',
      metadata: {
        completedDimensions: reflection.completedDimensions?.length || 0,
        reflectionSource: 'tier-rule-reflection',
        sessionId,
        tierIndex: reflection.tierIndex,
      },
      phase: 'tier-reflection',
      summary: `Tier ${tierNumber} reflection collected ${reflection.topFindings?.length || 0} top findings and ${reflection.crossDimensionPatterns?.length || 0} cross-dimension patterns.`,
      targetName: `Tier ${tierNumber}`,
      title: `Bootstrap tier ${tierNumber} reflection`,
    },
  ];
}

function buildToolEvent({
  dimId,
  label,
  projection,
  sessionId,
}: {
  dimId: string;
  label?: string | null;
  projection: BootstrapDimensionProjection;
  sessionId: string;
}): BootstrapProcessEventDraft | null {
  const toolCalls = projection.runtimeToolCalls || [];
  if (toolCalls.length === 0) {
    return null;
  }
  const visibleCalls = toolCalls.slice(0, MAX_TOOL_CALLS).map(projectToolCall);
  const toolNames = unique(toolCalls.map((call) => call.tool || call.name || 'unknown'));
  const omittedCount = Math.max(0, toolCalls.length - visibleCalls.length);
  return {
    content: {
      language: 'json',
      mimeType: 'application/json',
      role: 'tool',
      text: jsonText({
        calls: visibleCalls,
        omittedCount,
        totalCount: toolCalls.length,
      }),
    },
    dimensionId: dimId,
    kind: 'tool',
    metadata: {
      dimensionId: dimId,
      omittedToolCallCount: omittedCount,
      sessionId,
      toolCallCount: toolCalls.length,
      toolNames,
    },
    phase: 'dimension-tools',
    summary: `${toolCalls.length} tool call${toolCalls.length === 1 ? '' : 's'} recorded: ${toolNames.slice(0, 8).join(', ') || 'unknown'}.`,
    targetName: label || dimId,
    title: `Bootstrap ${label || dimId} tool calls`,
  };
}

function buildVisibleOutputEvent({
  dimId,
  label,
  projection,
  runResult,
  sessionId,
}: {
  dimId: string;
  label?: string | null;
  projection: BootstrapDimensionProjection;
  runResult: AgentResultLike;
  sessionId: string;
}): BootstrapProcessEventDraft | null {
  const sections = dedupeSections([
    ['Analyze', projection.analyzeResult?.reply],
    ['Produce', projection.produceResult?.reply],
    ['Final', runResult.reply],
  ]);
  const text =
    sections.length > 0
      ? sections
          .map(([name, value]) => `## ${name}\n\n${truncateText(value, MAX_TEXT_CHARS)}`)
          .join('\n\n')
      : '';
  if (!text && !projection.combinedTokenUsage) {
    return null;
  }
  return {
    content: text
      ? {
          mimeType: 'text/markdown',
          role: 'assistant',
          text,
        }
      : null,
    dimensionId: dimId,
    kind: 'llm.output',
    metadata: {
      dimensionId: dimId,
      outputSections: sections.map(([name]) => name),
      sessionId,
      status: runResult.status || null,
      tokenUsage: projection.combinedTokenUsage,
      visibleOutput: Boolean(text),
    },
    phase: 'dimension-output',
    summary: text
      ? `Visible Agent output captured for ${label || dimId}.`
      : `Agent call completed for ${label || dimId} without visible text output.`,
    targetName: label || dimId,
    title: `Bootstrap ${label || dimId} visible output`,
  };
}

function buildReflectionEvent({
  dimId,
  label,
  projection,
  runResult,
  sessionId,
}: {
  dimId: string;
  label?: string | null;
  projection: BootstrapDimensionProjection;
  runResult: AgentResultLike;
  sessionId: string;
}): BootstrapProcessEventDraft | null {
  const qualityGate = projectQualityGate(projection);
  const diagnostics = summarizeDiagnostics(runResult.diagnostics);
  const efficiency = summarizeEfficiency(projection.efficiency || runResult.efficiency || null);
  const hasReflection = Boolean(qualityGate || diagnostics || efficiency);
  if (!hasReflection) {
    return null;
  }
  const gateAction = qualityGate?.action || qualityGate?.pass || 'recorded';
  return {
    content: {
      language: 'json',
      mimeType: 'application/json',
      role: 'developer',
      text: jsonText({
        diagnostics,
        efficiency,
        qualityGate,
      }),
    },
    dimensionId: dimId,
    kind: 'llm.reflection',
    metadata: {
      dimensionId: dimId,
      gateAction,
      reflectionSource: 'quality-gate-diagnostics',
      sessionId,
    },
    phase: 'dimension-reflection',
    summary: `Self-check for ${label || dimId}: ${String(gateAction)}.`,
    targetName: label || dimId,
    title: `Bootstrap ${label || dimId} self-check`,
  };
}

function projectAgentRunInput(runInput: AgentRunInput): Record<string, unknown> {
  const context = asRecord(runInput.context);
  const message = asRecord(runInput.message);
  const fileCache = context.fileCache;
  return {
    context: {
      fileCount: Array.isArray(fileCache) ? fileCache.length : null,
      hasMemoryCoordinator: Boolean(context.memoryCoordinator),
      hasStrategyContext: Boolean(context.strategyContext),
      hasSystemRunContext: Boolean(context.systemRunContext),
      lang: context.lang ?? null,
      promptContext: sanitizeValue(context.promptContext, 0),
      runtimeSource: context.runtimeSource ?? null,
      source: context.source ?? null,
    },
    execution: {
      hasAbortSignal: Boolean(asRecord(runInput.execution).abortSignal),
    },
    message: {
      content: sanitizeValue(message.content, 0),
      metadata: sanitizeValue(message.metadata, 0),
      role: message.role ?? null,
      sessionId: message.sessionId ?? null,
    },
    params: sanitizeValue(runInput.params || {}, 0),
    profile: sanitizeValue(runInput.profile || {}, 0),
  };
}

function projectToolCall(call: ToolCallRecord, index: number): Record<string, unknown> {
  const args = call.args || call.params || {};
  return {
    args: sanitizeValue(args, 0),
    durationMs: typeof call.durationMs === 'number' ? call.durationMs : null,
    index,
    result: summarizeToolResult(call.result),
    tool: call.tool || call.name || 'unknown',
  };
}

function summarizeToolResult(result: unknown): unknown {
  if (!isRecord(result)) {
    return sanitizeValue(result, 0);
  }
  const summaryKeys = [
    'ok',
    'status',
    'error',
    'message',
    'title',
    'id',
    'candidateId',
    'submitted',
    'created',
    'updated',
    'count',
  ];
  const summary: Record<string, unknown> = {};
  for (const key of summaryKeys) {
    if (key in result) {
      summary[key] = sanitizeValue(result[key], 0);
    }
  }
  if (Object.keys(summary).length === 0) {
    summary.keys = Object.keys(result).slice(0, MAX_OBJECT_KEYS);
  }
  return summary;
}

function projectQualityGate(
  projection: BootstrapDimensionProjection
): Record<string, unknown> | null {
  const gate = projection.gateResult;
  const artifact = asRecord(gate?.artifact);
  const qualityReport = asRecord(artifact.qualityReport);
  if (!gate && Object.keys(qualityReport).length === 0) {
    return null;
  }
  return {
    action: gate?.action ?? null,
    pass: typeof gate?.pass === 'boolean' ? gate.pass : null,
    qualityReport: {
      scores: sanitizeValue(qualityReport.scores || {}, 0),
      suggestions: sanitizeValue(qualityReport.suggestions || [], 0),
      totalScore: qualityReport.totalScore ?? null,
    },
    reason: typeof gate?.reason === 'string' ? truncateText(gate.reason, MAX_STRING_CHARS) : null,
  };
}

function summarizeDiagnostics(diagnostics: unknown): Record<string, unknown> | null {
  if (!isRecord(diagnostics)) {
    return null;
  }
  return {
    aiErrorCount: diagnostics.aiErrorCount ?? null,
    degraded: diagnostics.degraded === true,
    emptyResponses: diagnostics.emptyResponses ?? null,
    gateFailures: sanitizeValue(diagnostics.gateFailures || [], 0),
    timedOutStages: sanitizeValue(diagnostics.timedOutStages || [], 0),
  };
}

function summarizeEfficiency(efficiency: unknown): Record<string, unknown> | null {
  if (!isRecord(efficiency)) {
    return null;
  }
  const tokenUsage = asRecord(efficiency.tokenUsage);
  return {
    cacheHits: efficiency.cacheHits ?? null,
    cacheMisses: efficiency.cacheMisses ?? null,
    cancelReason: efficiency.cancelReason ?? null,
    duplicateToolCalls: efficiency.duplicateToolCalls ?? null,
    emptyRetries: efficiency.emptyRetries ?? null,
    forcedSummary: efficiency.forcedSummary === true,
    maxCompactionLevel: efficiency.maxCompactionLevel ?? null,
    nudgeCount: efficiency.nudgeCount ?? null,
    replanCount: efficiency.replanCount ?? null,
    tokenUsage: {
      cacheHit: tokenUsage.cacheHit ?? null,
      input: tokenUsage.input ?? null,
      output: tokenUsage.output ?? null,
      reasoning: tokenUsage.reasoning ?? null,
    },
    toolCalls: efficiency.toolCalls ?? null,
  };
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value ?? null;
  }
  if (typeof value === 'string') {
    return redactSecretText(truncateText(value, MAX_STRING_CHARS));
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push({ omittedItems: value.length - MAX_ARRAY_ITEMS });
    }
    return items;
  }
  if (!isRecord(value)) {
    return String(value);
  }
  if (depth >= 4) {
    return { keys: Object.keys(value).slice(0, MAX_OBJECT_KEYS) };
  }
  const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted-secret]' : sanitizeValue(item, depth + 1);
  }
  if (Object.keys(value).length > MAX_OBJECT_KEYS) {
    out.omittedKeys = Object.keys(value).length - MAX_OBJECT_KEYS;
  }
  return out;
}

function jsonText(value: unknown): string {
  return truncateText(JSON.stringify(value, null, 2), MAX_JSON_TEXT_CHARS);
}

function dedupeSections(sections: Array<[string, unknown]>): Array<[string, string]> {
  const seen = new Set<string>();
  const result: Array<[string, string]> = [];
  for (const [name, value] of sections) {
    if (typeof value !== 'string') {
      continue;
    }
    const text = value.trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push([name, redactSecretText(text)]);
  }
  return result;
}

function redactSecretText(text: string): string {
  return text.replace(SECRET_VALUE_PATTERN, '[redacted-secret]');
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
