/**
 * MCP Handler — autosnippet_task (Unified Task & Decision Management)
 *
 * Operations:
 *   Session:   prime (session entry — loads decisions + ready tasks + stats)
 *   Tasks:     create / ready / claim / close / fail / defer / progress
 *              show / list / stats / blocked / decompose / dep_add / dep_tree
 *   Decisions: record_decision / revise_decision / unpin_decision / list_decisions
 */

import { envelope } from '../envelope.js';
import type { McpContext } from './types.js';

// Guard auto-review: task close 自动触发 diff 合规检查（发现违规 → Agent 自修复）

// ─── Local Types ──────────────────────────────────────────

interface TaskLike {
  id: string;
  title: string;
  taskType?: string;
  priority?: number;
  failCount?: number;
  lastFailReason?: string;
  closeReason?: string;
  updatedAt?: number;
  toJSON(): Record<string, unknown>;
}

interface TaskArgs {
  operation?: string;
  id?: string;
  title?: string;
  description?: string;
  design?: string;
  acceptance?: string;
  priority?: number;
  taskType?: string;
  parentId?: string | null;
  limit?: number;
  withKnowledge?: boolean;
  userQuery?: string;
  activeFile?: string;
  language?: string;
  status?: string;
  subtasks?: unknown[];
  dependsOn?: string;
  depType?: string;
  reason?: string;
  rationale?: string;
  tags?: string[];
  relatedTaskId?: string | null;
  [key: string]: unknown;
}

interface TaskGraphServiceLike {
  create(opts: Record<string, unknown>): Promise<{ task: TaskLike; isDuplicate: boolean }>;
  ready(opts: {
    limit: number;
    withKnowledge: boolean;
    userQuery?: string;
    activeFile?: string;
    language?: string;
  }): Promise<TaskLike[]>;
  claim(
    id: string,
    assignee?: string,
    knowledgeOptions?: { userQuery?: string; activeFile?: string; language?: string }
  ): Promise<TaskLike>;
  close(id: string, reason: string): Promise<{ task: TaskLike; newlyReady: unknown[] }>;
  fail(id: string, reason: string): Promise<TaskLike>;
  defer(id: string, reason: string): Promise<TaskLike>;
  progress(id: string, note: string): Promise<TaskLike>;
  decompose(id: string, subtasks: unknown[]): Promise<TaskLike[]>;
  show(id: string): Promise<TaskLike | null>;
  list(filters: Record<string, unknown>, opts: { limit: number }): Promise<TaskLike[]>;
  blocked(): Promise<unknown[]>;
  addDependency(id: string, dependsOn: string, depType: string): Promise<void>;
  depTree(id: string): Promise<unknown[]>;
  stats(): Promise<Record<string, unknown>>;
  prime(opts: {
    limit: number;
    withKnowledge: boolean;
    userQuery?: string;
    activeFile?: string;
    language?: string;
  }): Promise<PrimeResult>;
  recordDecision(opts: Record<string, unknown>): Promise<{ task: TaskLike; isDuplicate: boolean }>;
  reviseDecision(
    opts: Record<string, unknown>
  ): Promise<{ newDecision: TaskLike; oldDecisionId: string }>;
  unpinDecision(id: string, reason: string): Promise<TaskLike>;
}

interface PrimeResult {
  decisions: Array<{ title: string; [key: string]: unknown }>;
  staleDecisions: unknown[];
  inProgress: Array<{ id: string; title: string; updatedAt?: number; [key: string]: unknown }>;
  ready: unknown[];
  stats: { total: number; [key: string]: unknown };
  _taskRules?: unknown;
  _resumePrompt?: Record<string, unknown>;
  [key: string]: unknown;
}

interface EnvelopeResult {
  success: boolean;
  errorCode?: string | null;
  data?: unknown;
  message?: string;
  meta?: Record<string, unknown>;
}

/**
 * 统一入口
 * @param ctx { container }
 * @param args { operation, ...params }
 */
export async function taskHandler(ctx: McpContext, args: TaskArgs) {
  const taskService = ctx.container.get('taskGraphService') as TaskGraphServiceLike;

  let result: EnvelopeResult;
  switch (args.operation) {
    // ── Session ──
    case 'prime':
      return _prime(taskService, args);
    // ── Task CRUD ──
    case 'create':
      result = await _create(taskService, args);
      break;
    case 'ready':
      return _ready(taskService, args);
    case 'claim':
      result = await _claim(taskService, args);
      break;
    case 'close':
      result = await _close(ctx, taskService, args);
      break;
    case 'fail':
      result = await _fail(taskService, args);
      break;
    case 'defer':
      result = await _defer(taskService, args);
      break;
    case 'progress':
      result = await _progress(taskService, args);
      break;
    case 'decompose':
      result = await _decompose(taskService, args);
      break;
    case 'show':
      return _show(taskService, args);
    case 'list':
      return _list(taskService, args);
    case 'blocked':
      return _blocked(taskService);
    case 'dep_add':
      return _depAdd(taskService, args);
    case 'dep_tree':
      return _depTree(taskService, args);
    case 'stats':
      return _stats(taskService);
    // ── Decisions ──
    case 'record_decision':
      result = await _recordDecision(taskService, args);
      break;
    case 'revise_decision':
      result = await _reviseDecision(taskService, args);
      break;
    case 'unpin_decision':
      result = await _unpinDecision(taskService, args);
      break;
    case 'list_decisions':
      return _listDecisions(taskService);
    default:
      return envelope({
        success: false,
        message: `Unknown operation: ${args.operation}. Valid: prime, ready, create, claim, close, fail, defer, progress, decompose, dep_add, dep_tree, stats, list, record_decision, revise_decision, unpin_decision, list_decisions.`,
        meta: { tool: 'autosnippet_task' },
      });
  }

  // ── 飞书任务进度通知（异步非阻塞）──
  _notifyTaskProgress(args.operation, args, result).catch((err) => {
    process.stderr.write(`[MCP/Task] Notify error: ${err?.message}\n`);
  });

  return result;
}

// ── create ──

async function _create(svc: TaskGraphServiceLike, args: TaskArgs) {
  if (!args.title) {
    return envelope({
      success: false,
      message: 'title is required',
      meta: { tool: 'autosnippet_task' },
    });
  }
  const { task, isDuplicate } = await svc.create({
    title: args.title,
    description: args.description || '',
    design: args.design || '',
    acceptance: args.acceptance || '',
    priority: args.priority ?? 2,
    taskType: args.taskType || 'task',
    parentId: args.parentId || null,
  });
  return envelope({
    success: true,
    data: task.toJSON(),
    message: isDuplicate
      ? `⚠ Duplicate detected: ${task.id} already exists`
      : `Created ${task.id}: ${task.title}`,
    meta: { tool: 'autosnippet_task' },
  });
}

// ── ready ──

async function _ready(svc: TaskGraphServiceLike, args: TaskArgs) {
  const tasks = await svc.ready({
    limit: args.limit || 10,
    withKnowledge: args.withKnowledge !== false,
    userQuery: args.userQuery,
    activeFile: args.activeFile,
    language: args.language,
  });
  return envelope({
    success: true,
    data: tasks.map((t: TaskLike) => (t.toJSON ? t.toJSON() : t)),
    message: `${tasks.length} task(s) ready`,
    meta: { tool: 'autosnippet_task' },
  });
}

// ── claim ──

async function _claim(svc: TaskGraphServiceLike, args: TaskArgs) {
  if (!args.id) {
    return envelope({
      success: false,
      message: 'id is required',
      meta: { tool: 'autosnippet_task' },
    });
  }
  const knowledgeOptions =
    args.userQuery || args.activeFile || args.language
      ? { userQuery: args.userQuery, activeFile: args.activeFile, language: args.language }
      : undefined;
  const task = await svc.claim(args.id, 'agent', knowledgeOptions);
  return envelope({
    success: true,
    data: task.toJSON(),
    message: `Claimed ${args.id}`,
    meta: { tool: 'autosnippet_task' },
  });
}

// ── close ──

async function _close(ctx: McpContext, svc: TaskGraphServiceLike, args: TaskArgs) {
  if (!args.id) {
    return envelope({
      success: false,
      message: 'id is required',
      meta: { tool: 'autosnippet_task' },
    });
  }

  const { task, newlyReady } = await svc.close(args.id, args.reason || 'Completed');

  const lines = [`✅ Closed: ${args.id} — ${task.title}`];
  if (args.reason && args.reason !== 'Completed') {
    lines.push(`Reason: ${args.reason}`);
  }
  if (newlyReady.length > 0) {
    lines.push(`→ ${newlyReady.length} task(s) newly ready`);
  }

  lines.push('');
  lines.push(
    '⚠️ REQUIRED: You MUST call autosnippet_guard (no args) NOW to review changed files for compliance violations. Do NOT proceed to the next task until guard review passes.'
  );

  return envelope({
    success: true,
    data: {
      closed: task.toJSON(),
      newlyReady,
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

// ── fail ──

async function _fail(svc: TaskGraphServiceLike, args: TaskArgs) {
  if (!args.id) {
    return envelope({
      success: false,
      message: 'id is required',
      meta: { tool: 'autosnippet_task' },
    });
  }
  const task = await svc.fail(args.id, args.reason || 'Agent execution failed');
  return envelope({
    success: true,
    data: task.toJSON(),
    message: `Failed ${args.id} (attempt #${task.failCount}): ${task.lastFailReason}`,
    meta: { tool: 'autosnippet_task' },
  });
}

// ── defer ──

async function _defer(svc: TaskGraphServiceLike, args: TaskArgs) {
  if (!args.id) {
    return envelope({
      success: false,
      message: 'id is required',
      meta: { tool: 'autosnippet_task' },
    });
  }
  const task = await svc.defer(args.id, args.reason || '');
  return envelope({
    success: true,
    data: task.toJSON(),
    message: `Deferred ${args.id}`,
    meta: { tool: 'autosnippet_task' },
  });
}

// ── progress ──

async function _progress(svc: TaskGraphServiceLike, args: TaskArgs) {
  if (!args.id) {
    return envelope({
      success: false,
      message: 'id is required',
      meta: { tool: 'autosnippet_task' },
    });
  }
  const note = args.reason || args.description || '';
  const task = await svc.progress(args.id, note);
  return envelope({
    success: true,
    data: task.toJSON(),
    message: `Progress updated for ${args.id}`,
    meta: { tool: 'autosnippet_task' },
  });
}

// ── decompose ──

async function _decompose(svc: TaskGraphServiceLike, args: TaskArgs) {
  if (!args.id) {
    return envelope({
      success: false,
      message: 'Epic id is required',
      meta: { tool: 'autosnippet_task' },
    });
  }
  if (!args.subtasks || !Array.isArray(args.subtasks) || args.subtasks.length === 0) {
    return envelope({
      success: false,
      message: 'subtasks array is required',
      meta: { tool: 'autosnippet_task' },
    });
  }
  const tasks = await svc.decompose(args.id, args.subtasks);
  return envelope({
    success: true,
    data: tasks.map((t: TaskLike) => (t.toJSON ? t.toJSON() : t)),
    message: `Decomposed ${args.id} into ${tasks.length} subtasks`,
    meta: { tool: 'autosnippet_task' },
  });
}

// ── show ──

async function _show(svc: TaskGraphServiceLike, args: TaskArgs) {
  if (!args.id) {
    return envelope({
      success: false,
      message: 'id is required',
      meta: { tool: 'autosnippet_task' },
    });
  }
  const task = await svc.show(args.id);
  if (!task) {
    return envelope({
      success: false,
      message: `Task not found: ${args.id}`,
      meta: { tool: 'autosnippet_task' },
    });
  }
  return envelope({
    success: true,
    data: task.toJSON(),
    meta: { tool: 'autosnippet_task' },
  });
}

// ── list ──

async function _list(svc: TaskGraphServiceLike, args: TaskArgs) {
  const filters: { status?: string; taskType?: string } = {};
  if (args.status) {
    filters.status = args.status;
  }
  if (args.taskType) {
    filters.taskType = args.taskType;
  }

  const tasks = await svc.list(filters, { limit: args.limit || 20 });
  return envelope({
    success: true,
    data: tasks.map((t: TaskLike) => t.toJSON()),
    message: `${tasks.length} task(s)`,
    meta: { tool: 'autosnippet_task' },
  });
}

// ── blocked ──

async function _blocked(svc: TaskGraphServiceLike) {
  const tasks = await svc.blocked();
  return envelope({
    success: true,
    data: tasks,
    message: `${tasks.length} blocked task(s)`,
    meta: { tool: 'autosnippet_task' },
  });
}

// ── dep_add ──

async function _depAdd(svc: TaskGraphServiceLike, args: TaskArgs) {
  if (!args.id || !args.dependsOn) {
    return envelope({
      success: false,
      message: 'id and dependsOn are required',
      meta: { tool: 'autosnippet_task' },
    });
  }
  await svc.addDependency(args.id, args.dependsOn, args.depType || 'blocks');
  return envelope({
    success: true,
    message: `${args.id} ${args.depType || 'blocks'} ${args.dependsOn}`,
    meta: { tool: 'autosnippet_task' },
  });
}

// ── dep_tree ──

async function _depTree(svc: TaskGraphServiceLike, args: TaskArgs) {
  if (!args.id) {
    return envelope({
      success: false,
      message: 'id is required',
      meta: { tool: 'autosnippet_task' },
    });
  }
  const tree = await svc.depTree(args.id);
  return envelope({
    success: true,
    data: tree,
    message: `${tree.length} node(s) in dependency tree`,
    meta: { tool: 'autosnippet_task' },
  });
}

// ── stats ──

async function _stats(svc: TaskGraphServiceLike) {
  const stats = await svc.stats();
  return envelope({
    success: true,
    data: stats,
    meta: { tool: 'autosnippet_task' },
  });
}

// ═══ Session (prime) ═══════════════════════════════════

async function _prime(svc: TaskGraphServiceLike, args: TaskArgs) {
  const result = await svc.prime({
    limit: args.limit || 10,
    withKnowledge: args.withKnowledge !== false,
    userQuery: args.userQuery,
    activeFile: args.activeFile,
    language: args.language,
  });

  const decisionCount = (result.decisions || []).length;
  const staleCount = (result.staleDecisions || []).length;
  const decisionTitles = (result.decisions || []).map((d: { title: string }) => d.title).join('; ');
  const statsLine = `${result.inProgress.length} in-progress, ${result.ready.length} ready, ${result.stats.total} total`;

  // ── Behavioral Rules Reminder (survives compaction) ──
  result._taskRules = {
    reminder: [
      '📋 TASK RULES (MANDATORY):',
      '🔑 YOU are the task operator — user speaks naturally, you translate to task operations. NEVER tell user to run task commands.',
      '• MUST prime on EVERY message BEFORE anything else',
      '• MUST create task for non-trivial work (≥2 files OR ≥10 lines)',
      '• MUST claim before coding, close when done with meaningful reason',
      '• MUST handle unfinished tasks before starting new work (ask user: Continue/Defer/Abandon)',
      '• NEVER skip prime, NEVER start new work with open in_progress tasks',
      '• NEVER leave tasks in in_progress when session ends — close or defer ALL',
      '• When in doubt → create a task. When idle → ready()',
      '• Session end → close all tasks, defer incomplete, verify zero in_progress',
    ].join('\n'),
    translationHint: [
      'User Says → You Run:',
      '"fix bug"/"implement" → create→claim→code→close',
      '"continue" → resume in-progress→close',
      '"pause" → defer | "abandon" → fail | "break down" → decompose',
      '"what\'s next" → ready() | "agreed" → record_decision',
      'Quick question → No task. Just answer.',
    ].join('\n'),
  };

  let message: string;
  if (decisionCount > 0) {
    const stalePart = staleCount > 0 ? ` ${staleCount} stale.` : '';
    message = `⚠️ ${decisionCount} ACTIVE DECISION(S): [${decisionTitles}].${stalePart} ${statsLine}.`;
  } else {
    message = `${statsLine}.`;
  }

  // ── Resume Prompt: 有 inProgress 任务时，提示 Agent 让用户选择 ──
  if (result.inProgress.length > 0) {
    const taskList = result.inProgress
      .map((t: { id: string; title: string; updatedAt?: number }) => {
        const age = t.updatedAt
          ? `${Math.floor((Date.now() / 1000 - t.updatedAt) / 86400)}d ago`
          : '';
        return `• **${t.id}** — ${t.title}${age ? ` (${age})` : ''}`;
      })
      .join('\n');

    result._resumePrompt = {
      instruction: [
        'There are unfinished tasks. You MUST present these options to the user BEFORE doing anything else:',
        '',
        '**Unfinished tasks:**',
        taskList,
        '',
        'Ask the user to choose:',
        '1. **Continue** — resume the unfinished task(s)',
        '2. **Defer** — pause it and work on something else',
        '3. **Abandon** — close/fail it and start fresh',
        '',
        "Wait for the user's answer. Do NOT auto-resume.",
      ].join('\n'),
      taskIds: result.inProgress.map((t: { id: string }) => t.id),
    };

    message += ` ⏸️ ${result.inProgress.length} unfinished task(s) — ask user before resuming.`;
  }

  return envelope({
    success: true,
    data: result,
    message,
    meta: { tool: 'autosnippet_task' },
  });
}

// ═══ Decisions ═══════════════════════════════════════

async function _recordDecision(svc: TaskGraphServiceLike, args: TaskArgs) {
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
  const { task, isDuplicate } = await svc.recordDecision({
    title: args.title,
    description: args.description,
    rationale: args.rationale || '',
    tags: args.tags || [],
    relatedTaskId: args.relatedTaskId || null,
  });
  return envelope({
    success: true,
    data: task.toJSON(),
    message: isDuplicate
      ? `⚠ Decision already recorded: ${task.id}`
      : `✅ Decision pinned: ${task.id} — "${args.title}"`,
    meta: { tool: 'autosnippet_task' },
  });
}

async function _reviseDecision(svc: TaskGraphServiceLike, args: TaskArgs) {
  if (!args.id) {
    return envelope({
      success: false,
      message: 'id of old decision is required',
      meta: { tool: 'autosnippet_task' },
    });
  }
  if (!args.title) {
    return envelope({
      success: false,
      message: 'title of new decision is required',
      meta: { tool: 'autosnippet_task' },
    });
  }
  if (!args.description) {
    return envelope({
      success: false,
      message: 'description of new decision is required',
      meta: { tool: 'autosnippet_task' },
    });
  }
  const result = await svc.reviseDecision({
    oldDecisionId: args.id,
    title: args.title,
    description: args.description,
    rationale: args.rationale || '',
    reason: args.reason || '',
  });
  return envelope({
    success: true,
    data: {
      newDecision: result.newDecision.toJSON(),
      superseded: result.oldDecisionId,
    },
    message: `✅ Decision revised: ${result.oldDecisionId} → ${result.newDecision.id}`,
    meta: { tool: 'autosnippet_task' },
  });
}

async function _unpinDecision(svc: TaskGraphServiceLike, args: TaskArgs) {
  if (!args.id) {
    return envelope({
      success: false,
      message: 'id is required',
      meta: { tool: 'autosnippet_task' },
    });
  }
  const task = await svc.unpinDecision(args.id, args.reason || '');
  return envelope({
    success: true,
    data: task.toJSON(),
    message: `Decision ${args.id} unpinned and closed`,
    meta: { tool: 'autosnippet_task' },
  });
}

async function _listDecisions(svc: TaskGraphServiceLike) {
  const decisions = await svc.list({ status: 'pinned', taskType: 'decision' }, { limit: 50 });
  return envelope({
    success: true,
    data: decisions.map((d: TaskLike) => d.toJSON()),
    message: `${decisions.length} active decision(s)`,
    meta: { tool: 'autosnippet_task' },
  });
}

// ═══ 飞书任务进度通知（通过 API Server 中转）═══════════════
//
// MCP Server 与 API Server 是独立进程。
// 飞书 WSClient 连接在 API Server 中，因此通知需 HTTP 中转。
// ═══════════════════════════════════════════════════════════

const PRIORITY_LABELS = ['P0 紧急', 'P1 高', 'P2 中', 'P3 低', 'P4 微'];

/** 通过 API Server 的 /api/v1/remote/notify 发送飞书通知 */
async function _sendLarkViaApi(text: string): Promise<boolean> {
  try {
    const port = process.env.PORT || 3000;
    const resp = await fetch(`http://localhost:${port}/api/v1/remote/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      process.stderr.write(`[MCP/Task] Lark notify HTTP ${resp.status}\n`);
      return false;
    }
    const body = (await resp.json()) as Record<string, unknown>;
    return body.success === true;
  } catch (err: unknown) {
    process.stderr.write(
      `[MCP/Task] Lark notify failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return false;
  }
}

/**
 * 通过 API Server 截取 IDE 窗口截图并发送到飞书
 * @param [caption] 可选文字说明
 */
async function _sendScreenshotViaApi(caption = '') {
  try {
    const port = process.env.PORT || 3000;
    const resp = await fetch(`http://localhost:${port}/api/v1/remote/screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caption }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      process.stderr.write(`[MCP/Task] Screenshot HTTP ${resp.status}\n`);
      return false;
    }
    const body = (await resp.json()) as Record<string, unknown>;
    return body.success === true;
  } catch (err: unknown) {
    process.stderr.write(
      `[MCP/Task] Screenshot failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return false;
  }
}

/**
 * 根据任务操作向飞书发送进度通知（异步非阻塞）
 * result 是 envelope() 返回的 { success, data, message, meta }
 */
async function _notifyTaskProgress(operation: string, args: TaskArgs, result: EnvelopeResult) {
  if (!result || result.success === false) {
    return;
  }

  const data = result.data as Record<string, unknown> | undefined;
  let text = '';

  switch (operation) {
    case 'create': {
      const title = data?.title || args.title || '';
      const id = data?.id || '';
      const type = data?.taskType || args.taskType || 'task';
      const pri = PRIORITY_LABELS[(data?.priority ?? args.priority ?? 2) as number] || 'P2';
      const dup =
        result.message?.includes('Duplicate') || result.message?.startsWith('⚠') ? ' (重复)' : '';
      text = `📋 新任务${dup}: ${id}\n${title}\n类型: ${type} | ${pri}`;
      break;
    }
    case 'claim': {
      const id = data?.id || args.id;
      const title = data?.title || '';
      text = `🔨 开始执行: ${id}\n${title}`;
      break;
    }
    case 'close': {
      const closed = (data?.closed || data) as Record<string, unknown> | undefined;
      const title = closed?.title || '';
      const id = closed?.id || args.id;
      const reason = closed?.closeReason || args.reason || '';
      const readyCount = Array.isArray(data?.newlyReady) ? data.newlyReady.length : 0;
      const readyInfo = readyCount > 0 ? `\n→ ${readyCount} 个任务新就绪` : '';
      text = `✅ 完成: ${id}\n${title}\n原因: ${reason}${readyInfo}`;
      break;
    }
    case 'fail': {
      const title = data?.title || '';
      const id = data?.id || args.id;
      const reason = data?.lastFailReason || args.reason || '未知';
      const count = Number(data?.failCount || 0);
      text = `❌ 失败: ${id}\n${title}\n原因: ${reason}${count > 1 ? ` (第${count}次)` : ''}`;
      break;
    }
    case 'defer': {
      const id = data?.id || args.id;
      const title = data?.title || '';
      text = `⏸️ 暂缓: ${id} — ${title}`;
      break;
    }
    case 'progress': {
      const id = data?.id || args.id;
      const note = args.reason || args.description || '';
      text = note ? `📝 进度: ${id}\n${note.slice(0, 200)}` : `📝 进度: ${id}`;
      break;
    }
    case 'decompose': {
      const epicId = args.id;
      const count = Array.isArray(data) ? data.length : 0;
      const subTitles = Array.isArray(data)
        ? data
            .slice(0, 5)
            .map((t, i) => `  ${i + 1}. ${t.title || t.id}`)
            .join('\n')
        : '';
      text = `📂 拆解: ${epicId} → ${count} 个子任务${subTitles ? `\n${subTitles}` : ''}`;
      break;
    }
    case 'record_decision': {
      const title = data?.title || args.title || '';
      text = `📌 决策: ${title}`;
      break;
    }
    case 'revise_decision': {
      const oldId = data?.superseded || args.id;
      const newTitle =
        (data?.newDecision as Record<string, unknown> | undefined)?.title || args.title;
      text = `🔄 决策更新: ${oldId} → ${newTitle}`;
      break;
    }
    case 'unpin_decision': {
      const id = data?.id || args.id;
      text = `🔓 决策取消: ${id}`;
      break;
    }
    default:
      return;
  }

  if (text) {
    await _sendLarkViaApi(text);
    // 发送文字通知后，附带 IDE 窗口截图
    await _sendScreenshotViaApi();
  }
}
