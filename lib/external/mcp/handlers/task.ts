/**
 * MCP Handler — autosnippet_task (Intent Lifecycle + Signal Collection)
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

import { notifyTaskProgress } from '#infra/notification/LarkNotifier.js';
import type { SignalBus } from '#infra/signal/SignalBus.js';
import type { ExtractedIntent } from '#service/task/IntentExtractor.js';
import { extract as extractIntent } from '#service/task/IntentExtractor.js';
import type { PrimeSearchResult } from '#service/task/PrimeSearchPipeline.js';
import { envelope } from '../envelope.js';
import type {
  DecisionRecord,
  IntentChainRecord,
  IntentState,
  McpContext,
  McpServiceContainer,
} from './types.js';
import { createIdleIntent } from './types.js';

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
  return `asd-${Date.now().toString(36)}-${_taskCounter}`;
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
        meta: { tool: 'autosnippet_task' },
      });
  }

  // ── Lark notification (async, non-blocking) ──
  notifyTaskProgress(args.operation!, args, result).catch((err: unknown) => {
    process.stderr.write(
      `[MCP/Task] Notify error: ${err instanceof Error ? err.message : String(err)}\n`
    );
  });

  return result;
}

// ═══ prime ═══════════════════════════════════════════════

async function _prime(ctx: McpContext, args: TaskArgs) {
  const intent = ctx.session?.intent;

  // If there is an active intent, persist it as abandoned before starting fresh
  if (intent && intent.phase === 'active') {
    _persistIntentChain(ctx, intent, 'abandoned', 'New prime received');
  }

  // ─── Intake: extract intent signals ───
  const extracted = extractIntent(args.userQuery || '', args.activeFile, args.language);

  // ─── Enrichment: multi-query search via PrimeSearchPipeline ───
  const pipeline = _getPipeline(ctx.container);
  let searchResult: PrimeSearchResult | null = null;
  if (pipeline && extracted.queries[0]?.trim()) {
    try {
      searchResult = await pipeline.search(extracted);
      if (!searchResult) {
        process.stderr.write('[MCP/Task] prime: pipeline.search returned null (all filtered)\n');
      }
    } catch (err: unknown) {
      process.stderr.write(
        `[MCP/Task] prime search error: ${err instanceof Error ? err.stack || err.message : String(err)}\n`
      );
    }
  } else if (!pipeline) {
    process.stderr.write('[MCP/Task] prime: pipeline is null, skipping search\n');
  } else {
    process.stderr.write(
      `[MCP/Task] prime: queries empty, skipping search. queries=${JSON.stringify(extracted.queries)}\n`
    );
  }

  // ─── Lifecycle: initialize IntentState ───
  const freshIntent = createIdleIntent();
  freshIntent.phase = 'active';
  freshIntent.primeQuery = args.userQuery || '';
  freshIntent.primeActiveFile = args.activeFile;
  freshIntent.primeLanguage = extracted.language;
  freshIntent.primeModule = extracted.module;
  freshIntent.primeScenario = extracted.scenario;
  freshIntent.primeAt = Date.now();

  if (searchResult) {
    freshIntent.primeRecipeIds = [...searchResult.relatedKnowledge, ...searchResult.guardRules]
      .map((r) => r.id)
      .filter(Boolean);
    freshIntent.searchMeta = {
      queries: searchResult.searchMeta.queries,
      resultCount: searchResult.searchMeta.resultCount,
      filteredCount: searchResult.searchMeta.filteredCount,
    };
  }

  // Bind intent to session
  if (ctx.session) {
    ctx.session.intent = freshIntent;
  }

  // ─── Delivery: build response ───
  const relatedCount = searchResult?.relatedKnowledge.length ?? 0;
  const ruleCount = searchResult?.guardRules.length ?? 0;

  const lines: string[] = [];
  if (relatedCount > 0 || ruleCount > 0) {
    lines.push(`📋 Found ${relatedCount} recipe(s), ${ruleCount} guard rule(s).`);
    for (const r of searchResult!.relatedKnowledge) {
      const hint = r.actionHint ? ` — ${r.actionHint}` : '';
      const refs = r.sourceRefs?.length ? `\n    📍 ${r.sourceRefs.join(', ')}` : '';
      lines.push(`  • ${r.trigger || r.title}${hint}${refs}`);
    }
    for (const r of searchResult!.guardRules) {
      lines.push(`  • [rule] ${r.trigger || r.title}`);
    }
  } else {
    lines.push('No matching recipes found.');
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
      _taskRules,
    },
    message: lines.join('\n'),
    meta: { tool: 'autosnippet_task' },
  });
}

// ═══ create ═════════════════════════════════════════════

async function _create(ctx: McpContext, args: TaskArgs) {
  if (!args.title) {
    return envelope({
      success: false,
      message: 'title is required',
      meta: { tool: 'autosnippet_task' },
    });
  }

  const taskId = _generateTaskId();
  const intent = ctx.session?.intent;

  // Bind task ID to current intent
  if (intent && intent.phase === 'active') {
    intent.taskId = taskId;
    intent.taskTitle = args.title;
  }

  return envelope({
    success: true,
    data: { id: taskId, title: args.title },
    message: `📌 Created: ${taskId} — ${args.title}`,
    meta: { tool: 'autosnippet_task' },
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
      meta: { tool: 'autosnippet_task' },
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
    '⚠️ REQUIRED: You MUST call autosnippet_guard (no args) NOW to review changed files for compliance violations.'
  );

  return envelope({
    success: true,
    data: {
      closed: { id, reason, closedAt: Date.now() },
      nextAction: {
        tool: 'autosnippet_guard',
        args: {},
        required: true,
        reason: 'Post-close compliance review — check diff for violations before moving on.',
      },
    },
    message: lines.join('\n'),
    meta: { tool: 'autosnippet_task' },
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
      meta: { tool: 'autosnippet_task' },
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
    meta: { tool: 'autosnippet_task' },
  });
}

// ═══ record_decision ════════════════════════════════════

async function _recordDecision(ctx: McpContext, args: TaskArgs) {
  if (!args.title) {
    return envelope({
      success: false,
      message: 'title is required',
      meta: { tool: 'autosnippet_task' },
    });
  }
  if (!args.description) {
    return envelope({
      success: false,
      message: 'description is required',
      meta: { tool: 'autosnippet_task' },
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
    meta: { tool: 'autosnippet_task' },
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
  search(intent: ExtractedIntent): Promise<PrimeSearchResult | null>;
}

function _getPipeline(container: McpServiceContainer): PipelineLike | null {
  try {
    const p = container.get('primeSearchPipeline') as PipelineLike | null;
    if (!p) {
      process.stderr.write('[MCP/Task] _getPipeline: container returned null/undefined\n');
    }
    return p;
  } catch (err: unknown) {
    process.stderr.write(
      `[MCP/Task] _getPipeline failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
}
