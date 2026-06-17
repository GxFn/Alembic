/**
 * Alembic Resident Tool Handler — alembic_task (Intent Lifecycle + Signal Collection)
 *
 * 5 Operations:
 *   prime            — Load knowledge context + initialize intent
 *   create           — Create in-memory task anchor (generates ID)
 *   close            — Complete task + persist intent chain + trigger Guard
 *   fail             — Abandon task + persist intent chain
 *   record_decision  — Record user preference signal
 *
 * Architecture: Zero DB. Pure memory (IntentState) + SignalBus → JSONL signals.
 */

import type { SignalBus } from '@alembic/core/events';
import type {
  IntentEpisodeHostIntentMeta,
  IntentEpisodeRecord,
  IntentEpisodeSearchMeta,
  IntentEpisodeStore,
} from '#service/task/IntentEpisodeStore.js';
import type { ExtractedIntent } from '#service/task/IntentExtractor.js';
import { extract as extractIntent } from '#service/task/IntentExtractor.js';
import type { PrimeSearchOptions, PrimeSearchResult } from '#service/task/PrimeSearchPipeline.js';
import { envelope } from '../handler-runtime/envelope.js';
import type {
  DecisionRecord,
  IntentChainRecord,
  IntentState,
  McpContext,
  McpServiceContainer,
} from '../handler-runtime/types.js';
import { createIdleIntent } from '../handler-runtime/types.js';
import {
  applyHostIntentContext,
  createHostIntentContextMeta,
  normalizeHostIntentContext,
} from './HostIntentContext.js';
import { buildIntentEvidence, type RelationEvidenceProvider } from './IntentEvidence.js';
import {
  buildIntentSearchPlan,
  type IntentSearchPlan,
  summarizeIntentSearchPlan,
} from './IntentSearchPlan.js';
import { buildPrimeInjectionPackage } from './PrimeInjectionPackage.js';

// ─── Local Types ──────────────────────────────────────────

interface TaskArgs {
  operation?: string;
  id?: string;
  title?: string;
  description?: string;
  reason?: string;
  rationale?: string;
  tags?: string[];
  userQuery?: string;
  activeFile?: string;
  language?: string;
  hostDeclaredIntent?: unknown;
  hostTurnMeta?: unknown;
  intentContext?: unknown;
  sessionHistory?: unknown[];
  [key: string]: unknown;
}

interface EnvelopeResult {
  success: boolean;
  errorCode?: string | null;
  data?: unknown;
  message?: string;
  meta?: Record<string, unknown>;
}

// ─── In-memory task ID counter ───────────────────────────

let _taskCounter = 0;

function _generateTaskId(): string {
  _taskCounter++;
  return `alembic-${Date.now().toString(36)}-${_taskCounter}`;
}

// ─── Task Rules Reminder ─────────────────────────────────

const _taskRules = {
  reminder: [
    '📋 TASK RULES (MANDATORY):',
    '🔑 YOU are the task operator — user speaks naturally, you translate to task operations.',
    '• MUST prime on EVERY message BEFORE anything else',
    '• MUST create task for non-trivial work (≥2 files OR ≥10 lines)',
    '• MUST close when done with meaningful reason',
    '• When user agrees/disagrees → record_decision immediately',
    '• NEVER tell user to run task commands',
  ].join('\n'),
  translationHint: [
    'User Says → You Run:',
    '"fix bug"/"implement" → create→code→close',
    '"continue" → resume in-progress→close',
    '"pause"/"abandon" → fail(id, reason)',
    '"agreed"/"disagree" → record_decision',
    'Quick question → No task. Just answer.',
  ].join('\n'),
};

/**
 * Unified entry point
 */
export async function taskHandler(ctx: McpContext, args: TaskArgs) {
  // Normalize taskId → id (schema accepts both for convenience)
  if (!args.id && typeof args.taskId === 'string') {
    args.id = args.taskId;
  }

  let result: EnvelopeResult;

  switch (args.operation) {
    case 'prime':
      return _prime(ctx, args);
    case 'create':
      result = await _create(ctx, args);
      break;
    case 'close':
      result = await _close(ctx, args);
      break;
    case 'fail':
      result = await _fail(ctx, args);
      break;
    case 'record_decision':
      result = await _recordDecision(ctx, args);
      break;
    default:
      return envelope({
        success: false,
        message: `Unknown operation: ${args.operation}. Valid: prime, create, close, fail, record_decision.`,
        meta: { tool: 'alembic_task' },
      });
  }

  return result;
}

// ═══ prime ═══════════════════════════════════════════════

async function _prime(ctx: McpContext, args: TaskArgs) {
  const intent = ctx.session?.intent;

  // If there is an active intent, persist it as abandoned before starting fresh
  if (intent && intent.phase === 'active') {
    _persistIntentChain(ctx, intent, 'abandoned', 'New prime received');
  }

  // ─── Intake: consume optional Plugin host intent context, then fall back to legacy args ───
  const hostIntentContext = normalizeHostIntentContext({
    activeFile: args.activeFile,
    hostDeclaredIntent: args.hostDeclaredIntent,
    hostTurnMeta: args.hostTurnMeta,
    intentContext: args.intentContext,
    language: args.language,
    sessionHistory: args.sessionHistory,
    userQuery: args.userQuery,
  });
  const hostIntentMeta = createHostIntentContextMeta(hostIntentContext);
  const extracted = applyHostIntentContext(
    extractIntent(
      hostIntentContext.userQuery || '',
      hostIntentContext.activeFile,
      hostIntentContext.language
    ),
    hostIntentContext
  );
  const intentSearchPlan = buildIntentSearchPlan({
    episodeStore: _getIntentEpisodeStore(ctx.container, { logMissing: false }),
    hostDeclaredIntent: args.hostDeclaredIntent,
    hostIntentContext,
    hostTurnMeta: args.hostTurnMeta,
    intentContext: args.intentContext,
    mode: 'prime',
    rawQuery: args.userQuery ?? hostIntentContext.userQuery,
  });

  const searchResult = await _runPrimeSearch({
    ctx,
    extracted,
    hostIntentMeta,
    intentSearchPlan,
    query: hostIntentContext.userQuery || '',
    sessionHistory: hostIntentContext.sessionHistory,
  });

  // ─── Lifecycle: initialize IntentState ───
  const freshIntent = createIdleIntent();
  freshIntent.phase = 'active';
  freshIntent.primeQuery = hostIntentContext.userQuery || '';
  freshIntent.primeActiveFile = hostIntentContext.activeFile;
  freshIntent.primeLanguage = extracted.language;
  freshIntent.primeModule = extracted.module;
  freshIntent.primeScenario = extracted.scenario;
  freshIntent.primeAt = Date.now();

  _bindPrimeSearchResult(freshIntent, searchResult);

  const episode = _startIntentEpisode(ctx, {
    activeFile: hostIntentContext.activeFile,
    hostIntent: hostIntentMeta,
    language: extracted.language,
    module: extracted.module,
    query: hostIntentContext.userQuery || '',
    scenario: extracted.scenario,
    searchMeta: freshIntent.searchMeta,
    sessionId: ctx.session?.id,
    sourceRefs: hostIntentContext.sourceRefs,
    turnId:
      _stringProperty(args.hostTurnMeta, 'turnId') ?? _stringProperty(args.hostTurnMeta, 'id'),
  });
  if (episode) {
    freshIntent.episodeId = episode.episodeId;
    freshIntent.episodeSessionKey = episode.sessionKey;
  }

  // Bind intent to session
  if (ctx.session) {
    ctx.session.intent = freshIntent;
  }

  return envelope({
    success: true,
    data: {
      knowledge: searchResult
        ? {
            relatedKnowledge: searchResult.relatedKnowledge,
            guardRules: searchResult.guardRules,
          }
        : null,
      searchMeta: searchResult?.searchMeta ?? null,
      intentSearchPlan: summarizeIntentSearchPlan(intentSearchPlan),
      primeInjectionPackage: searchResult?.searchMeta.primeInjectionPackage ?? null,
      intentEpisode: episode
        ? {
            episodeId: episode.episodeId,
            sessionKey: episode.sessionKey,
            status: episode.status,
          }
        : null,
      intentContext: hostIntentMeta,
      _taskRules,
    },
    message: _primeMessage(searchResult),
    meta: { tool: 'alembic_task' },
  });
}

async function _runPrimeSearch({
  ctx,
  extracted,
  hostIntentMeta,
  intentSearchPlan,
  query,
  sessionHistory,
}: {
  ctx: McpContext;
  extracted: ExtractedIntent;
  hostIntentMeta: ReturnType<typeof createHostIntentContextMeta>;
  intentSearchPlan: IntentSearchPlan;
  query: string;
  sessionHistory: PrimeSearchOptions['sessionHistory'];
}): Promise<PrimeSearchResult | null> {
  const pipeline = _getPipeline(ctx.container);
  if (!pipeline) {
    process.stderr.write('[ResidentTool/Task] prime: pipeline is null, skipping search\n');
    return null;
  }
  if (!extracted.queries[0]?.trim()) {
    process.stderr.write(
      `[ResidentTool/Task] prime: queries empty, skipping search. queries=${JSON.stringify(
        extracted.queries
      )}\n`
    );
    return null;
  }

  try {
    const searchResult = await pipeline.search(extracted, {
      hostIntent: hostIntentMeta,
      intentSearchPlan,
      sessionHistory,
    });
    if (!searchResult) {
      process.stderr.write(
        '[ResidentTool/Task] prime: pipeline.search returned null (all filtered)\n'
      );
      return null;
    }
    await _refreshPrimeSearchMeta({ ctx, hostIntentMeta, intentSearchPlan, query, searchResult });
    return searchResult;
  } catch (err: unknown) {
    process.stderr.write(
      `[ResidentTool/Task] prime search error: ${
        err instanceof Error ? err.stack || err.message : String(err)
      }\n`
    );
    return null;
  }
}

async function _refreshPrimeSearchMeta({
  ctx,
  hostIntentMeta,
  intentSearchPlan,
  query,
  searchResult,
}: {
  ctx: McpContext;
  hostIntentMeta: ReturnType<typeof createHostIntentContextMeta>;
  intentSearchPlan: IntentSearchPlan;
  query: string;
  searchResult: PrimeSearchResult;
}): Promise<void> {
  const regionMeta = searchResult.searchMeta.residentRegionRetrieval;
  const regionUsed = regionMeta?.used === true;
  const items = [...searchResult.relatedKnowledge, ...searchResult.guardRules];
  searchResult.searchMeta.intentEvidence = await buildIntentEvidence({
    actualMode: 'prime',
    intentSearchPlan,
    items,
    relationProvider: _getRelationProvider(ctx.container),
    requestedMode: 'prime',
    semanticUsed: regionUsed,
    vectorAvailable: regionMeta?.vectorAvailable,
    vectorUsed: regionUsed,
  });
  searchResult.searchMeta.primeInjectionPackage = buildPrimeInjectionPackage({
    hostIntent: hostIntentMeta,
    intentEvidence: searchResult.searchMeta.intentEvidence,
    intentSearchPlan,
    items,
    search: {
      actualMode: 'prime',
      filteredCount: searchResult.searchMeta.filteredCount,
      query,
      queries: searchResult.searchMeta.queries,
      requestedMode: 'prime',
      resultCount: searchResult.searchMeta.resultCount,
    },
    residentRegionRetrieval: regionMeta,
    semanticUsed: regionUsed,
    vectorAvailable: regionMeta?.vectorAvailable,
    vectorUsed: regionUsed,
  });
}

function _bindPrimeSearchResult(intent: IntentState, searchResult: PrimeSearchResult | null): void {
  if (!searchResult) {
    return;
  }
  intent.primeRecipeIds = [...searchResult.relatedKnowledge, ...searchResult.guardRules]
    .map((r) => r.id)
    .filter(Boolean);
  intent.searchMeta = {
    queries: searchResult.searchMeta.queries,
    resultCount: searchResult.searchMeta.resultCount,
    filteredCount: searchResult.searchMeta.filteredCount,
    hostIntentApplied: searchResult.searchMeta.hostIntentApplied,
    hostIntentConfidence: searchResult.searchMeta.hostIntentConfidence,
    hostIntentDegraded: searchResult.searchMeta.hostIntentDegraded,
    hostIntentDegradedReason: searchResult.searchMeta.hostIntentDegradedReason,
    hostIntentSourceRefs: searchResult.searchMeta.hostIntentSourceRefs,
    intentEvidence: searchResult.searchMeta.intentEvidence,
    intentSearchPlan: searchResult.searchMeta.intentSearchPlan,
    primeInjectionPackage: searchResult.searchMeta.primeInjectionPackage,
    residentRegionRetrieval: searchResult.searchMeta.residentRegionRetrieval,
  };
}

function _primeMessage(searchResult: PrimeSearchResult | null): string {
  const relatedKnowledge = searchResult?.relatedKnowledge ?? [];
  const guardRules = searchResult?.guardRules ?? [];
  const relatedCount = relatedKnowledge.length;
  const ruleCount = guardRules.length;
  const lines: string[] = [];

  if (relatedCount === 0 && ruleCount === 0) {
    return 'No matching recipes found.';
  }

  lines.push(`📋 Found ${relatedCount} recipe(s), ${ruleCount} guard rule(s).`);
  for (const r of relatedKnowledge) {
    const hint = r.actionHint ? ` — ${r.actionHint}` : '';
    const refs = r.sourceRefs?.length ? `\n    📍 ${r.sourceRefs.join(', ')}` : '';
    lines.push(`  • ${r.trigger || r.title}${hint}${refs}`);
  }
  for (const r of guardRules) {
    lines.push(`  • [rule] ${r.trigger || r.title}`);
  }
  return lines.join('\n');
}

// ═══ create ═════════════════════════════════════════════

async function _create(ctx: McpContext, args: TaskArgs) {
  if (!args.title) {
    return envelope({
      success: false,
      message: 'title is required',
      meta: { tool: 'alembic_task' },
    });
  }

  const taskId = _generateTaskId();
  const intent = ctx.session?.intent;

  // Bind task ID to current intent
  if (intent && intent.phase === 'active') {
    intent.taskId = taskId;
    intent.taskTitle = args.title;
    _attachIntentEpisodeTask(ctx, intent, taskId);
  }

  return envelope({
    success: true,
    data: {
      id: taskId,
      intentEpisode: intent?.episodeId
        ? { episodeId: intent.episodeId, sessionKey: intent.episodeSessionKey ?? null }
        : null,
      title: args.title,
    },
    message: `📌 Created: ${taskId} — ${args.title}`,
    meta: { tool: 'alembic_task' },
  });
}

// ═══ close ══════════════════════════════════════════════

async function _close(ctx: McpContext, args: TaskArgs) {
  const intent = ctx.session?.intent;
  // Resolve id: explicit arg > session intent > fail
  const id = args.id || (intent?.taskId ?? '');
  if (!id) {
    return envelope({
      success: false,
      message: 'id is required (pass id or ensure a task was created in this session)',
      meta: { tool: 'alembic_task' },
    });
  }

  const reason = args.reason || 'Completed';

  // Persist intent chain via SignalBus
  if (intent && intent.phase === 'active') {
    _persistIntentChain(ctx, intent, 'completed', reason);
  }

  // Reset intent to idle
  if (ctx.session) {
    ctx.session.intent = createIdleIntent();
  }

  const lines = [`✅ Closed: ${id} — ${reason}`];
  lines.push('');
  lines.push(
    '⚠️ REQUIRED: You MUST call alembic_guard (no args) NOW to review changed files for compliance violations.'
  );

  return envelope({
    success: true,
    data: {
      closed: { id, reason, closedAt: Date.now() },
      nextAction: {
        tool: 'alembic_guard',
        args: {},
        required: true,
        reason: 'Post-close compliance review — check diff for violations before moving on.',
      },
    },
    message: lines.join('\n'),
    meta: { tool: 'alembic_task' },
  });
}

// ═══ fail ═══════════════════════════════════════════════

async function _fail(ctx: McpContext, args: TaskArgs) {
  const intent = ctx.session?.intent;
  // Resolve id: explicit arg > session intent > fail
  const id = args.id || (intent?.taskId ?? '');
  if (!id) {
    return envelope({
      success: false,
      message: 'id is required (pass id or ensure a task was created in this session)',
      meta: { tool: 'alembic_task' },
    });
  }

  const reason = args.reason || 'Agent execution failed';

  // Persist intent chain via SignalBus
  if (intent && intent.phase === 'active') {
    _persistIntentChain(ctx, intent, 'failed', reason);
  }

  // Reset intent to idle
  if (ctx.session) {
    ctx.session.intent = createIdleIntent();
  }

  return envelope({
    success: true,
    data: {
      failed: { id, reason, failedAt: Date.now() },
    },
    message: `❌ Failed: ${id} — ${reason}`,
    meta: { tool: 'alembic_task' },
  });
}

// ═══ record_decision ════════════════════════════════════

async function _recordDecision(ctx: McpContext, args: TaskArgs) {
  if (!args.title) {
    return envelope({
      success: false,
      message: 'title is required',
      meta: { tool: 'alembic_task' },
    });
  }
  if (!args.description) {
    return envelope({
      success: false,
      message: 'description is required',
      meta: { tool: 'alembic_task' },
    });
  }

  const decisionId = `dec-${Date.now().toString(36)}`;
  const decision: DecisionRecord = {
    id: decisionId,
    title: args.title,
    description: args.description,
    rationale: args.rationale,
    tags: args.tags,
    recordedAt: Date.now(),
  };

  // Push to current intent's decisions
  const intent = ctx.session?.intent;
  if (intent && intent.phase === 'active') {
    intent.decisions.push(decision);
  }

  return envelope({
    success: true,
    data: { decision: { id: decisionId, title: args.title } },
    message: `📌 Decision recorded: ${args.title}`,
    meta: { tool: 'alembic_task' },
  });
}

// ═══ Intent Chain Persistence (via SignalBus) ═══════════

function _persistIntentChain(
  ctx: McpContext,
  intent: IntentState,
  outcome: 'completed' | 'failed' | 'abandoned',
  reason?: string
) {
  const now = Date.now();
  const chain: IntentChainRecord = {
    sessionId: ctx.session?.id || 'unknown',
    taskId: intent.taskId,
    outcome,

    primeQuery: intent.primeQuery,
    primeActiveFile: intent.primeActiveFile,
    primeRecipeIds: intent.primeRecipeIds,
    primeAt: intent.primeAt || now,
    primeLanguage: intent.primeLanguage ?? null,
    primeModule: intent.primeModule ?? null,
    primeScenario: intent.primeScenario ?? 'search',

    searchMeta: intent.searchMeta,

    toolCalls: intent.toolCalls,
    searchQueries: intent.searchQueries,
    mentionedFiles: intent.mentionedFiles,
    decisions: intent.decisions,

    driftEvents: intent.driftEvents,
    driftScore: _computeDriftScore(intent),

    closeReason: outcome === 'completed' ? reason : undefined,
    failReason: outcome !== 'completed' ? reason : undefined,
    startedAt: intent.primeAt || now,
    endedAt: now,
    duration: now - (intent.primeAt || now),
  };

  // Emit via SignalBus — subscribers handle JSONL persistence
  try {
    const signalBus = ctx.container.get('signalBus') as SignalBus;
    signalBus.send('intent', 'TaskHandler', _computeDriftScore(intent), {
      target: intent.taskId ?? null,
      metadata: { chain },
    });
  } catch {
    // signalBus unavailable — silent failure, non-blocking
  }

  _updateIntentEpisodeOutcome(ctx, intent, outcome, reason);
}

function _computeDriftScore(intent: IntentState): number {
  if (intent.driftEvents.length === 0) {
    return 0;
  }
  const sum = intent.driftEvents.reduce((acc, d) => acc + (1 - d.primeOverlap), 0);
  return sum / intent.driftEvents.length;
}

// ═══ PrimeSearchPipeline accessor ═══════════════════════

interface PipelineLike {
  search(intent: ExtractedIntent, options?: PrimeSearchOptions): Promise<PrimeSearchResult | null>;
}

function _getPipeline(container: McpServiceContainer): PipelineLike | null {
  try {
    const p = container.get('primeSearchPipeline') as PipelineLike | null;
    if (!p) {
      process.stderr.write('[ResidentTool/Task] _getPipeline: container returned null/undefined\n');
    }
    return p;
  } catch (err: unknown) {
    process.stderr.write(
      `[ResidentTool/Task] _getPipeline failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    return null;
  }
}

interface IntentEpisodeStartContext {
  activeFile?: string;
  hostIntent: IntentEpisodeHostIntentMeta | null;
  language: string | null;
  module: string | null;
  query: string;
  scenario: string;
  searchMeta?: IntentEpisodeSearchMeta | null;
  sessionId?: string;
  sourceRefs?: string[];
  turnId?: string;
}

function _startIntentEpisode(
  ctx: McpContext,
  input: IntentEpisodeStartContext
): IntentEpisodeRecord | null {
  const store = _getIntentEpisodeStore(ctx.container);
  if (!store) {
    return null;
  }
  try {
    return store.start({
      activeFile: input.activeFile,
      hostIntent: input.hostIntent,
      language: input.language,
      module: input.module,
      query: input.query,
      scenario: input.scenario,
      searchMeta: input.searchMeta ?? null,
      sessionId: input.sessionId,
      sourceRefs: input.sourceRefs,
      turnId: input.turnId,
    });
  } catch (err: unknown) {
    process.stderr.write(
      `[ResidentTool/Task] intent episode start failed: ${
        err instanceof Error ? err.stack || err.message : String(err)
      }\n`
    );
    return null;
  }
}

function _attachIntentEpisodeTask(ctx: McpContext, intent: IntentState, taskId: string): void {
  if (!intent.episodeId) {
    return;
  }
  const store = _getIntentEpisodeStore(ctx.container);
  if (!store) {
    return;
  }
  try {
    store.attachTask(intent.episodeId, taskId);
  } catch (err: unknown) {
    process.stderr.write(
      `[ResidentTool/Task] intent episode task attach failed: ${
        err instanceof Error ? err.stack || err.message : String(err)
      }\n`
    );
  }
}

function _updateIntentEpisodeOutcome(
  ctx: McpContext,
  intent: IntentState,
  outcome: 'completed' | 'failed' | 'abandoned',
  reason?: string
): void {
  if (!intent.episodeId) {
    return;
  }
  const store = _getIntentEpisodeStore(ctx.container);
  if (!store) {
    return;
  }
  try {
    store.updateOutcome(intent.episodeId, {
      reason,
      searchMeta: intent.searchMeta ?? null,
      status: outcome,
      taskId: intent.taskId,
    });
  } catch (err: unknown) {
    process.stderr.write(
      `[ResidentTool/Task] intent episode outcome update failed: ${
        err instanceof Error ? err.stack || err.message : String(err)
      }\n`
    );
  }
}

function _getIntentEpisodeStore(
  container: McpServiceContainer,
  options: { logMissing?: boolean } = {}
): IntentEpisodeStore | null {
  try {
    return container.get('intentEpisodeStore') as IntentEpisodeStore;
  } catch (err: unknown) {
    if (options.logMissing !== false) {
      process.stderr.write(
        `[ResidentTool/Task] _getIntentEpisodeStore failed: ${
          err instanceof Error ? err.message : String(err)
        }\n`
      );
    }
    return null;
  }
}

function _getRelationProvider(container: McpServiceContainer): RelationEvidenceProvider | null {
  try {
    return container.get('knowledgeGraphService') as RelationEvidenceProvider;
  } catch {
    return null;
  }
}

function _stringProperty(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}
