import type { AgentProgressProcessEvent, ProgressEvent } from '@alembic/agent/runtime';
import type { AgentRunInput } from '@alembic/agent/service';
import type {
  BootstrapProcessEventDraft,
  BootstrapProcessEventTextArtifactCandidate,
} from '#service/bootstrap/bootstrap-event-types.js';
import type { BootstrapDimensionPlan } from '#workflows/capabilities/execution/internal-agent/BootstrapDimensionRuntimeBuilder.js';
import type {
  AgentResultLike,
  BootstrapDimensionProjection,
  DimensionFinding,
  ToolCallRecord,
} from '#workflows/capabilities/execution/internal-agent/BootstrapProjections.js';
import { parseDimensionDigest } from '#workflows/capabilities/execution/internal-agent/DimensionContext.js';

const MAX_TEXT_CHARS = 6000;
const MAX_JSON_TEXT_CHARS = 12000;
const MAX_TOOL_CALLS = 20;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 32;
const MAX_STRING_CHARS = 1600;
const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|bearer|cookie|password|secret|token)/i;
const SECRET_VALUE_PATTERN =
  /\b(sk-(?:proj-)?[a-zA-Z0-9_-]{12,}|AIza[a-zA-Z0-9_-]{10,}|Bearer\s+[a-zA-Z0-9._-]{12,})\b/g;
const AGENT_PROGRESS_PROCESS_EVENT_KINDS = [
  'llm.input',
  'llm.reflection',
  'llm.output',
  'tool',
] as const;
const PROCESS_EVENT_DISPLAY_POLICIES = ['full', 'summary-only', 'hidden'] as const;
const PROCESS_EVENT_RETENTION_POLICIES = [
  'transient',
  'job-retained',
  'artifact-retained',
] as const;
const PROCESS_EVENT_SEVERITIES = ['info', 'success', 'warning', 'error'] as const;
const PROCESS_EVENT_CONTENT_ROLES = ['system', 'developer', 'user', 'assistant', 'tool'] as const;

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
  const findingsEvent = buildFindingsDigestEvent({
    dimId,
    label,
    projection,
    runResult,
    sessionId,
  });
  if (findingsEvent) {
    events.push(findingsEvent);
  }
  return events;
}

export function buildBootstrapAgentProgressProcessEvents({
  dimId,
  event,
  label,
  sessionId,
}: {
  dimId: string;
  event: ProgressEvent;
  label?: string | null;
  sessionId: string;
}): BootstrapProcessEventDraft[] {
  if (event.type !== 'agent_process_event') {
    return [];
  }
  const processEvent = event.processEvent;
  if (!processEvent || !isDeveloperVisibleAgentProcessEvent(processEvent)) {
    return [];
  }
  const kind = pickAllowedString(processEvent.kind, AGENT_PROGRESS_PROCESS_EVENT_KINDS);
  const title = stringValue(processEvent.title);
  if (!kind || !title) {
    return [];
  }
  const processMetadata = asRecord(processEvent.metadata || {});
  const dimensionId = stringValue(processEvent.dimensionId) || dimId;
  const phase = stringValue(processEvent.phase) || null;
  const normalizedContent = normalizeProcessEventContent(processEvent.content, kind);
  const correlationId =
    stringValue(processEvent.correlationId) ||
    buildProcessEventCorrelationId({
      dimensionId,
      kind,
      metadata: processMetadata,
      phase,
      sessionId,
    });
  const parentEventId = stringValue(asRecord(processEvent).parentEventId) || null;
  const llmMetrics = buildLlmEventMetrics({
    kind,
    metadata: processMetadata,
    projection: normalizedContent.projection,
  });
  return [
    {
      ...(normalizedContent.artifactCandidate
        ? { textArtifactCandidate: normalizedContent.artifactCandidate }
        : {}),
      content: normalizedContent.content,
      correlationId,
      createdAt: stringValue(processEvent.createdAt) || undefined,
      dimensionId,
      displayPolicy:
        pickAllowedString(processEvent.displayPolicy, PROCESS_EVENT_DISPLAY_POLICIES) || 'full',
      kind,
      metadata: {
        ...asRecord(sanitizeValue(processMetadata, 0)),
        ...normalizedContent.metadata,
        agentId: event.agentId,
        ...(llmMetrics ? { llmMetrics } : {}),
        preset: event.preset,
        progressType: event.type,
        sessionId,
        traceEnvelope: buildProcessTraceEnvelope({
          correlationId,
          dimensionId,
          kind,
          metadata: processMetadata,
          parentEventId,
          phase,
          sessionId,
        }),
      },
      parentEventId,
      phase,
      retention:
        pickAllowedString(processEvent.retention, PROCESS_EVENT_RETENTION_POLICIES) ||
        'job-retained',
      severity: pickAllowedString(processEvent.severity, PROCESS_EVENT_SEVERITIES) || 'info',
      sourceClass: 'developer-facing',
      summary: stringValue(processEvent.summary) || null,
      targetName: stringValue(processEvent.targetName) || label || dimId,
      title,
    },
  ];
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
  const reflectionEvent: BootstrapProcessEventDraft = {
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
  };
  const findings = normalizeFindingItems(reflection.topFindings || [], 'tier-reflection');
  const findingsEvent =
    findings.length > 0
      ? buildFindingsSummaryEvent({
          dimensionId: null,
          findings,
          metadata: {
            findingSources: ['tier-reflection'],
            projection: 'tier-findings-digest',
            sessionId,
            tierIndex: reflection.tierIndex,
          },
          phase: 'tier-findings',
          sessionId,
          targetName: `Tier ${tierNumber}`,
          title: `Bootstrap tier ${tierNumber} findings digest`,
        })
      : null;
  return [reflectionEvent, ...(findingsEvent ? [findingsEvent] : [])];
}

interface NormalizedFindingItem {
  evidence?: string;
  finding: string;
  importance?: number;
  source: string;
}

interface NormalizedProcessEventContent {
  artifactCandidate?: BootstrapProcessEventTextArtifactCandidate;
  content: BootstrapProcessEventDraft['content'];
  metadata: Record<string, unknown>;
  projection: TextProjection;
}

interface TextProjection {
  limit: number;
  originalChars: number;
  retainedChars: number;
  text: string;
  truncated: boolean;
  truncatedChars: number;
}

interface OutputSectionProjection {
  name: string;
  projection: TextProjection;
}

function buildFindingsDigestEvent({
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
  const digest = parseDimensionDigest(projection.producerResult?.reply || runResult.reply);
  const digestFindings = normalizeFindingItems(digest?.keyFindings || [], 'dimension-digest');
  const reportFindings = normalizeFindingItems(
    projection.analysisReport?.findings || [],
    'analysis-report'
  );
  const findings = dedupeFindings([...digestFindings, ...reportFindings]).slice(0, 10);
  if (findings.length === 0) {
    return null;
  }
  const findingSources = unique(findings.map((finding) => finding.source));
  return buildFindingsSummaryEvent({
    dimensionId: dimId,
    findings,
    metadata: {
      candidateCount: digest?.candidateCount ?? projection.producerResult?.candidateCount ?? null,
      dimensionId: dimId,
      digestSummary: digest?.summary || null,
      findingSources,
      projection: 'dimension-findings-digest',
      referencedFiles: projection.analysisReport?.referencedFiles || [],
      sessionId,
    },
    phase: 'dimension-findings',
    sessionId,
    targetName: label || dimId,
    title: `Bootstrap ${label || dimId} findings digest`,
  });
}

function buildFindingsSummaryEvent({
  dimensionId,
  findings,
  metadata,
  phase,
  sessionId,
  targetName,
  title,
}: {
  dimensionId?: string | null;
  findings: NormalizedFindingItem[];
  metadata: Record<string, unknown>;
  phase: string;
  sessionId: string;
  targetName: string;
  title: string;
}): BootstrapProcessEventDraft {
  const lines = ['## 关键发现 / Findings digest', ''];
  for (const [index, finding] of findings.entries()) {
    const importance = typeof finding.importance === 'number' ? ` [${finding.importance}/10]` : '';
    const evidence = finding.evidence ? ` - ${finding.evidence}` : '';
    lines.push(`${index + 1}. ${finding.finding}${importance}${evidence}`);
  }
  return {
    content: {
      mimeType: 'text/markdown',
      role: 'developer',
      text: redactSecretText(lines.join('\n')),
    },
    dimensionId,
    kind: 'summary',
    metadata: {
      ...metadata,
      findingCount: findings.length,
      findings: sanitizeValue(findings, 0),
      sessionId,
    },
    phase,
    summary: `${findings.length} developer-facing key finding${findings.length === 1 ? '' : 's'} projected for ${targetName}.`,
    targetName,
    title,
  };
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
  const projectedSections = sections.map(([name, value]) => ({
    name,
    projection: projectText(value, MAX_TEXT_CHARS),
  }));
  const text =
    projectedSections.length > 0
      ? projectedSections
          .map(({ name, projection: textProjection }) => `## ${name}\n\n${textProjection.text}`)
          .join('\n\n')
      : '';
  const fullText =
    sections.length > 0
      ? sections.map(([name, value]) => `## ${name}\n\n${redactSecretText(value)}`).join('\n\n')
      : '';
  const outputProjectionTotals = summarizeTextProjections(
    projectedSections.map(({ projection: textProjection }) => textProjection)
  );
  if (!text && !projection.combinedTokenUsage) {
    return null;
  }
  return {
    ...(fullText
      ? {
          textArtifactCandidate: {
            kind: 'llm-output-full-redacted',
            label: `Full redacted LLM output for ${label || dimId}`,
            mimeType: 'text/markdown; charset=utf-8',
            originalChars: fullText.length,
            redactionState: 'developer-visible-redacted',
            text: fullText,
          } satisfies BootstrapProcessEventTextArtifactCandidate,
        }
      : {}),
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
      ...buildOutputSectionTruncationMetadata(projectedSections),
      dimensionId: dimId,
      llmMetrics: {
        chars: {
          original: outputProjectionTotals.originalChars,
          retained: outputProjectionTotals.retainedChars,
          truncated: outputProjectionTotals.truncated,
          truncatedChars: outputProjectionTotals.truncatedChars,
          truncationLimit: outputProjectionTotals.limit,
        },
        estimatedTokens: estimateTokens(outputProjectionTotals.originalChars),
        outputSectionCount: projectedSections.length,
        tokenUsage: projection.combinedTokenUsage,
      },
      outputSections: projectedSections.map(({ name }) => name),
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
      hasProgressCallback: Boolean(asRecord(runInput.execution).onProgress),
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

function isDeveloperVisibleAgentProcessEvent(event: AgentProgressProcessEvent): boolean {
  return event.sourceClass === 'developer-facing' && event.displayPolicy !== 'hidden';
}

function normalizeProcessEventContent(
  content: AgentProgressProcessEvent['content'] | undefined,
  kind: (typeof AGENT_PROGRESS_PROCESS_EVENT_KINDS)[number]
): NormalizedProcessEventContent {
  if (!content) {
    const projection = emptyTextProjection();
    return {
      content: null,
      metadata: buildContentTruncationMetadata(projection),
      projection,
    };
  }
  const role = pickAllowedString(content.role, PROCESS_EVENT_CONTENT_ROLES) || null;
  const fullRedactedText =
    typeof content.text === 'string' ? redactSecretText(content.text) : undefined;
  const textProjection = fullRedactedText
    ? projectRedactedText(fullRedactedText, MAX_TEXT_CHARS)
    : emptyTextProjection();
  const artifactCandidate = buildProcessTextArtifactCandidate({
    content,
    fullRedactedText,
    kind,
  });
  return {
    ...(artifactCandidate ? { artifactCandidate } : {}),
    content: {
      data: sanitizeValue(content.data, 0),
      language: stringValue(content.language) || null,
      mimeType: stringValue(content.mimeType) || null,
      role,
      text: typeof content.text === 'string' ? textProjection.text : null,
    },
    metadata: buildContentTruncationMetadata(textProjection),
    projection: textProjection,
  };
}

function buildProcessTextArtifactCandidate({
  content,
  fullRedactedText,
  kind,
}: {
  content: NonNullable<AgentProgressProcessEvent['content']>;
  fullRedactedText?: string;
  kind: (typeof AGENT_PROGRESS_PROCESS_EVENT_KINDS)[number];
}): BootstrapProcessEventTextArtifactCandidate | undefined {
  if (!fullRedactedText || (kind !== 'llm.input' && kind !== 'llm.output')) {
    return undefined;
  }
  const artifactKind =
    kind === 'llm.input' ? 'llm-input-full-redacted' : 'llm-output-full-redacted';
  return {
    kind: artifactKind,
    label: kind === 'llm.input' ? 'Full redacted LLM input' : 'Full redacted LLM output',
    mimeType: stringValue(content.mimeType) || 'text/markdown; charset=utf-8',
    originalChars: fullRedactedText.length,
    redactionState: 'developer-visible-redacted',
    text: fullRedactedText,
  };
}

function buildProcessTraceEnvelope({
  correlationId,
  dimensionId,
  kind,
  metadata,
  parentEventId,
  phase,
  sessionId,
}: {
  correlationId: string | null;
  dimensionId: string | null;
  kind: string;
  metadata: Record<string, unknown>;
  parentEventId: string | null;
  phase: string | null;
  sessionId: string;
}): Record<string, unknown> {
  const inputStageProfile = stringValue(metadata.inputStageProfile);
  return {
    chainNodeId: stringValue(metadata.chainNodeId) || null,
    correlationId,
    dimensionId,
    eventKind: kind,
    iteration: finiteNumber(metadata.iteration),
    jobId: null,
    parentEventId,
    phase,
    sessionId,
    stageId: stringValue(metadata.stageId) || inputStageProfile || phase || null,
  };
}

function buildProcessEventCorrelationId({
  dimensionId,
  kind,
  metadata,
  phase,
  sessionId,
}: {
  dimensionId: string | null;
  kind: string;
  metadata: Record<string, unknown>;
  phase: string | null;
  sessionId: string;
}): string | null {
  const iteration = finiteNumber(metadata.iteration);
  if (!dimensionId && iteration === null && !phase) {
    return null;
  }
  return [
    'llm',
    sessionId,
    dimensionId || 'global',
    phase || 'unknown-phase',
    iteration === null ? 'unknown-iteration' : `iteration-${iteration}`,
    kind,
  ]
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, '_'))
    .join(':');
}

function buildLlmEventMetrics({
  kind,
  metadata,
  projection,
}: {
  kind: (typeof AGENT_PROGRESS_PROCESS_EVENT_KINDS)[number];
  metadata: Record<string, unknown>;
  projection: TextProjection;
}): Record<string, unknown> | null {
  if (kind !== 'llm.input' && kind !== 'llm.output') {
    return null;
  }
  const out: Record<string, unknown> = {
    chars: {
      original: projection.originalChars,
      retained: projection.retainedChars,
      truncated: projection.truncated,
      truncatedChars: projection.truncatedChars,
      truncationLimit: projection.limit,
    },
    estimatedTokens: estimateTokens(projection.originalChars),
  };
  addMetric(out, 'durationMs', finiteNumber(metadata.durationMs));
  addMetric(out, 'finishReason', stringValue(metadata.finishReason));
  addMetric(out, 'messageCount', finiteNumber(metadata.messageCount));
  addMetric(out, 'toolSchemaCount', arrayLength(metadata.toolSchemaNames));
  addMetric(out, 'requestedToolChoice', stringValue(metadata.requestedToolChoice));
  addMetric(out, 'effectiveToolChoice', stringValue(metadata.effectiveToolChoice));
  addMetric(out, 'inputStageProfile', stringValue(metadata.inputStageProfile));
  addMetric(out, 'sectionCount', arrayLength(metadata.inputSectionIds));
  addMetric(out, 'outputSectionCount', arrayLength(metadata.outputSections));
  addMetric(out, 'duplicateToolCalls', finiteNumber(metadata.duplicateToolCalls));
  addMetric(out, 'emptyRetries', finiteNumber(metadata.emptyRetries));
  addMetric(out, 'cacheHits', finiteNumber(metadata.cacheHits));
  addMetric(out, 'cacheMisses', finiteNumber(metadata.cacheMisses));
  const tokenUsage = normalizeTokenUsage(metadata.tokenUsage);
  if (tokenUsage) {
    out.tokenUsage = tokenUsage;
  }
  return out;
}

function buildOutputSectionTruncationMetadata(
  sections: OutputSectionProjection[]
): Record<string, unknown> {
  const totals = summarizeTextProjections(sections.map(({ projection }) => projection));
  return {
    ...buildContentTruncationMetadata(totals),
    outputSectionStats: sections.map(({ name, projection }) => ({
      name,
      originalChars: projection.originalChars,
      retainedChars: projection.retainedChars,
      truncated: projection.truncated,
      truncatedChars: projection.truncatedChars,
    })),
    outputTruncatedSections: sections
      .filter(({ projection }) => projection.truncated)
      .map(({ name }) => name),
  };
}

function buildContentTruncationMetadata(projection: TextProjection): Record<string, unknown> {
  return {
    contentOriginalChars: projection.originalChars,
    contentRetainedChars: projection.retainedChars,
    contentTruncated: projection.truncated,
    contentTruncatedChars: projection.truncatedChars,
    contentTruncationLimit: projection.limit,
    ...(projection.truncated ? { contentTruncationSource: 'alembic-process-event-bridge' } : {}),
  };
}

function summarizeTextProjections(projections: TextProjection[]): TextProjection {
  const totals = projections.reduce(
    (acc, projection) => ({
      originalChars: acc.originalChars + projection.originalChars,
      retainedChars: acc.retainedChars + projection.retainedChars,
      truncated: acc.truncated || projection.truncated,
      truncatedChars: acc.truncatedChars + projection.truncatedChars,
    }),
    {
      originalChars: 0,
      retainedChars: 0,
      truncated: false,
      truncatedChars: 0,
    }
  );
  return {
    limit: MAX_TEXT_CHARS,
    originalChars: totals.originalChars,
    retainedChars: totals.retainedChars,
    text: '',
    truncated: totals.truncated,
    truncatedChars: totals.truncatedChars,
  };
}

function normalizeFindingItems(values: unknown[], source: string): NormalizedFindingItem[] {
  return values
    .map((value) => normalizeFindingItem(value, source))
    .filter((value): value is NormalizedFindingItem => value !== null);
}

function normalizeFindingItem(value: unknown, source: string): NormalizedFindingItem | null {
  if (typeof value === 'string') {
    const finding = value.trim();
    return finding ? { finding, source } : null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const finding = stringValue((value as DimensionFinding).finding)?.trim();
  if (!finding) {
    return null;
  }
  const evidenceValue = (value as DimensionFinding).evidence;
  const evidence = Array.isArray(evidenceValue)
    ? evidenceValue.filter((item): item is string => typeof item === 'string').join(', ')
    : stringValue(evidenceValue);
  const importanceValue = (value as DimensionFinding).importance;
  const importance =
    typeof importanceValue === 'number' && Number.isFinite(importanceValue)
      ? importanceValue
      : undefined;
  return {
    evidence: evidence || undefined,
    finding,
    importance,
    source,
  };
}

function dedupeFindings(findings: NormalizedFindingItem[]): NormalizedFindingItem[] {
  const seen = new Set<string>();
  const result: NormalizedFindingItem[] = [];
  for (const finding of findings) {
    const key = finding.finding.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(finding);
  }
  return result;
}

function pickAllowedString<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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

function projectText(text: string, maxChars: number): TextProjection {
  return projectRedactedText(redactSecretText(text), maxChars);
}

function projectRedactedText(safeText: string, maxChars: number): TextProjection {
  if (safeText.length <= maxChars) {
    return {
      limit: maxChars,
      originalChars: safeText.length,
      retainedChars: safeText.length,
      text: safeText,
      truncated: false,
      truncatedChars: 0,
    };
  }
  const retainedText = safeText.slice(0, maxChars);
  return {
    limit: maxChars,
    originalChars: safeText.length,
    retainedChars: retainedText.length,
    text: `${retainedText}\n...[truncated ${safeText.length - maxChars} chars]`,
    truncated: true,
    truncatedChars: safeText.length - maxChars,
  };
}

function addMetric(out: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== null && value !== undefined) {
    out[key] = value;
  }
}

function normalizeTokenUsage(value: unknown): Record<string, number> | null {
  const tokenUsage = asRecord(value);
  const out: Record<string, number> = {};
  for (const [sourceKey, targetKey] of [
    ['input', 'input'],
    ['inputTokens', 'input'],
    ['output', 'output'],
    ['outputTokens', 'output'],
    ['reasoning', 'reasoning'],
    ['reasoningTokens', 'reasoning'],
    ['cacheHit', 'cacheHit'],
    ['cacheHitTokens', 'cacheHit'],
  ] as const) {
    const numberValue = finiteNumber(tokenUsage[sourceKey]);
    if (numberValue !== null && out[targetKey] === undefined) {
      out[targetKey] = numberValue;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function estimateTokens(chars: number): number {
  return chars > 0 ? Math.ceil(chars / 4) : 0;
}

function arrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function emptyTextProjection(): TextProjection {
  return {
    limit: MAX_TEXT_CHARS,
    originalChars: 0,
    retainedChars: 0,
    text: '',
    truncated: false,
    truncatedChars: 0,
  };
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
