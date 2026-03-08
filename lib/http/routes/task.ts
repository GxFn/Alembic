/**
 * TaskGraph HTTP API 路由
 *
 * 为 VS Code Extension `taskTool.ts` 提供 HTTP 转发端点。
 * Extension 通过 lm.registerTool 拦截 tokenBudget 后，
 * 将业务逻辑转发到此端点，由 TaskGraphService 执行。
 *
 * 端点:
 *   POST /api/v1/task  — 统一入口（operation 路由）
 */

import express, { type Request, type Response } from 'express';
import { TaskDispatchBody } from '#shared/schemas/http-requests.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { validate } from '../middleware/validate.js';

/** Task record shape from TaskGraphService */
interface TaskRecord {
  id: string;
  title: string;
  updatedAt?: number;
  toJSON(): Record<string, unknown>;
}

/** Prime result from TaskGraphService */
interface PrimeResult {
  inProgress: TaskRecord[];
  ready: TaskRecord[];
  decisions: TaskRecord[];
  staleDecisions?: TaskRecord[];
  stats: { total: number };
  _taskRules?: Record<string, unknown>;
  _resumePrompt?: { instruction: string; taskIds: string[] };
}

/** Dispatch interface for TaskGraphService */
interface TaskGraphSvc {
  create(p: Record<string, unknown>): Promise<{ task: TaskRecord; isDuplicate: boolean }>;
  ready(p: Record<string, unknown>): Promise<TaskRecord[]>;
  claim(id: unknown, assignee: unknown): Promise<TaskRecord>;
  close(id: unknown, reason: unknown): Promise<{ task: TaskRecord; newlyReady: TaskRecord[] }>;
  fail(id: unknown, reason: unknown): Promise<TaskRecord>;
  defer(id: unknown, reason: unknown): Promise<TaskRecord>;
  progress(id: unknown, note: unknown): Promise<TaskRecord>;
  prime(opts: Record<string, unknown>): Promise<PrimeResult>;
  decompose(epicId: unknown, subtasks: unknown[]): Promise<TaskRecord[]>;
  show(id: unknown): Promise<TaskRecord | null>;
  list(filter: Record<string, unknown>, opts: Record<string, unknown>): Promise<TaskRecord[]>;
  blocked(): Promise<TaskRecord[]>;
  addDependency(taskId: unknown, dependsOn: unknown, depType: unknown): Promise<void>;
  depTree(id: unknown): Promise<unknown>;
  stats(): Promise<unknown>;
  recordDecision(p: Record<string, unknown>): Promise<{ task: TaskRecord; isDuplicate: boolean }>;
  reviseDecision(
    p: Record<string, unknown>
  ): Promise<{ newDecision: TaskRecord; oldDecisionId: string }>;
  unpinDecision(id: unknown, reason: unknown): Promise<TaskRecord>;
}

const router = express.Router();

/**
 * POST /api/v1/task
 *
 * 请求体:
 *   { operation: string, ...params }
 *
 * 响应:
 *   { success: boolean, data?: unknown, message?: string }
 */
router.post('/', validate(TaskDispatchBody), async (req: Request, res: Response): Promise<void> => {
  const container = getServiceContainer();
  const taskService = container.get('taskGraphService') as TaskGraphSvc;

  if (!taskService) {
    return void res.status(503).json({
      success: false,
      message: 'TaskGraphService not available',
    });
  }

  const { operation, ...params } = req.body;

  try {
    const result = await _dispatch(taskService, operation, params);
    if (result.success === false) {
      return void res.status(400).json(result);
    }

    return void res.json(result);
  } catch (err: unknown) {
    return void res.status(400).json({
      success: false,
      message: (err as Error).message,
      operation,
    });
  }
});

/**
 * 操作路由 — 与 MCP handler/task.js 保持一致
 */
async function _dispatch(svc: TaskGraphSvc, operation: string, params: Record<string, unknown>) {
  switch (operation) {
    case 'create':
      return _create(svc, params);
    case 'ready':
      return _ready(svc, params);
    case 'claim':
      return _claim(svc, params);
    case 'close':
      return _close(svc, params);
    case 'fail':
      return _fail(svc, params);
    case 'defer':
      return _defer(svc, params);
    case 'progress':
      return _progress(svc, params);
    case 'prime':
      return _prime(svc);
    case 'decompose':
      return _decompose(svc, params);
    case 'show':
      return _show(svc, params);
    case 'list':
      return _list(svc, params);
    case 'blocked':
      return _blocked(svc);
    case 'dep_add':
      return _depAdd(svc, params);
    case 'dep_tree':
      return _depTree(svc, params);
    case 'stats':
      return _stats(svc);
    case 'record_decision':
      return _recordDecision(svc, params);
    case 'revise_decision':
      return _reviseDecision(svc, params);
    case 'unpin_decision':
      return _unpinDecision(svc, params);
    case 'list_decisions':
      return _list(svc, { ...params, taskType: 'decision', status: params.status || 'pinned' });
    default:
      return { success: false, message: `Unknown operation: ${operation}` };
  }
}

// ── create ──

async function _create(svc: TaskGraphSvc, args: Record<string, unknown>) {
  if (!args.title) {
    return { success: false, message: 'title is required' };
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
  return {
    success: true,
    data: task.toJSON(),
    message: isDuplicate
      ? `Duplicate detected: ${task.id} already exists`
      : `Created ${task.id}: ${task.title}`,
  };
}

// ── ready ──

async function _ready(svc: TaskGraphSvc, args: Record<string, unknown>) {
  const tasks = await svc.ready({
    limit: args.limit || 5,
    withKnowledge: args.withKnowledge !== false,
  });
  return {
    success: true,
    data: tasks.map((t: TaskRecord) => (t.toJSON ? t.toJSON() : t)),
    count: tasks.length,
  };
}

// ── claim ──

async function _claim(svc: TaskGraphSvc, args: Record<string, unknown>) {
  if (!args.id) {
    return { success: false, message: 'id is required' };
  }
  const task = await svc.claim(args.id, args.assignee || 'agent');
  return { success: true, data: task.toJSON() };
}

// ── close ──

async function _close(svc: TaskGraphSvc, args: Record<string, unknown>) {
  if (!args.id) {
    return { success: false, message: 'id is required' };
  }
  const { task, newlyReady } = await svc.close(args.id, args.reason || 'Completed');
  return {
    success: true,
    data: task.toJSON(),
    newlyReady,
    message: `Closed ${task.id}. ${newlyReady.length} tasks newly ready.`,
  };
}

// ── fail ──

async function _fail(svc: TaskGraphSvc, args: Record<string, unknown>) {
  if (!args.id) {
    return { success: false, message: 'id is required' };
  }
  const task = await svc.fail(args.id, args.reason || '');
  return { success: true, data: task.toJSON() };
}

// ── defer ──

async function _defer(svc: TaskGraphSvc, args: Record<string, unknown>) {
  if (!args.id) {
    return { success: false, message: 'id is required' };
  }
  const task = await svc.defer(args.id, args.reason || '');
  return { success: true, data: task.toJSON() };
}

// ── progress ──

async function _progress(svc: TaskGraphSvc, args: Record<string, unknown>) {
  if (!args.id) {
    return { success: false, message: 'id is required' };
  }
  const task = await svc.progress(args.id, args.note || args.description || '');
  return { success: true, data: task.toJSON() };
}

// ── prime ──

async function _prime(svc: TaskGraphSvc) {
  const result = await svc.prime({ withKnowledge: true });
  const decisionCount = (result.decisions || []).length;
  const staleCount = (result.staleDecisions || []).length;
  const decisionTitles = (result.decisions || []).map((d: TaskRecord) => d.title).join('; ');
  const statsLine = `${result.inProgress.length} in-progress, ${result.ready.length} ready, ${result.stats.total} total`;

  // ── Behavioral Rules Reminder (synced with MCP handler) ──
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

  // ── Resume Prompt: 有 inProgress 任务时，提示 Agent 让用户选择 ──
  if (result.inProgress.length > 0) {
    const taskList = result.inProgress
      .map((t: TaskRecord) => {
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
      taskIds: result.inProgress.map((t: TaskRecord) => t.id),
    };
  }

  let message: string;
  if (decisionCount > 0) {
    const stalePart = staleCount > 0 ? ` ${staleCount} stale.` : '';
    message = `⚠️ ${decisionCount} ACTIVE DECISION(S): [${decisionTitles}].${stalePart} ${statsLine}.`;
  } else {
    message = `${statsLine}.`;
  }

  if (result.inProgress.length > 0) {
    message += ` ⏸️ ${result.inProgress.length} unfinished task(s) — ask user before resuming.`;
  }

  return {
    success: true,
    data: result,
    message,
  };
}

// ── decompose ──

async function _decompose(svc: TaskGraphSvc, args: Record<string, unknown>) {
  const epicId = args.parentId || args.id;
  const subtasks = args.children || args.subtasks;
  if (!epicId) {
    return { success: false, message: 'parentId (or id) is required' };
  }
  if (!subtasks || !Array.isArray(subtasks)) {
    return { success: false, message: 'children (or subtasks) array is required' };
  }
  const tasks = await svc.decompose(epicId, subtasks);
  return {
    success: true,
    data: tasks.map((t: TaskRecord) => t.toJSON()),
    count: tasks.length,
  };
}

// ── show ──

async function _show(svc: TaskGraphSvc, args: Record<string, unknown>) {
  if (!args.id) {
    return { success: false, message: 'id is required' };
  }
  const task = await svc.show(args.id);
  if (!task) {
    return { success: false, message: `Task ${args.id} not found` };
  }
  return { success: true, data: task.toJSON() };
}

// ── list ──

async function _list(svc: TaskGraphSvc, args: Record<string, unknown>) {
  const tasks = await svc.list(
    { status: args.status, taskType: args.taskType, parentId: args.parentId },
    { limit: args.limit || 50 }
  );
  return {
    success: true,
    data: tasks.map((t: TaskRecord) => t.toJSON()),
    count: tasks.length,
  };
}

// ── blocked ──

async function _blocked(svc: TaskGraphSvc) {
  const tasks = await svc.blocked();
  return {
    success: true,
    data: tasks.map((t: TaskRecord) => (t.toJSON ? t.toJSON() : t)),
    count: tasks.length,
  };
}

// ── dep_add ──

async function _depAdd(svc: TaskGraphSvc, args: Record<string, unknown>) {
  if (!args.taskId || !args.dependsOn) {
    return { success: false, message: 'taskId and dependsOn are required' };
  }
  await svc.addDependency(args.taskId, args.dependsOn, args.depType || 'blocks');
  return {
    success: true,
    message: `Dependency added: ${args.taskId} ${args.depType || 'blocks'} ${args.dependsOn}`,
  };
}

// ── dep_tree ──

async function _depTree(svc: TaskGraphSvc, args: Record<string, unknown>) {
  if (!args.id) {
    return { success: false, message: 'id is required' };
  }
  const tree = await svc.depTree(args.id);
  return { success: true, data: tree };
}

// ── stats ──

async function _stats(svc: TaskGraphSvc) {
  const stats = await svc.stats();
  return { success: true, data: stats };
}

// ── record_decision ──

async function _recordDecision(svc: TaskGraphSvc, args: Record<string, unknown>) {
  if (!args.title) {
    return { success: false, message: 'title is required' };
  }
  if (!args.description) {
    return { success: false, message: 'description is required' };
  }
  const { task, isDuplicate } = await svc.recordDecision({
    title: args.title,
    description: args.description,
    rationale: args.rationale || '',
    tags: args.tags || [],
    relatedTaskId: args.relatedTaskId || null,
  });
  return {
    success: true,
    data: task.toJSON(),
    message: isDuplicate
      ? `Decision already recorded: ${task.id}`
      : `Decision pinned: ${task.id} — "${args.title}"`,
  };
}

// ── revise_decision ──

async function _reviseDecision(svc: TaskGraphSvc, args: Record<string, unknown>) {
  if (!args.id) {
    return { success: false, message: 'id of old decision is required' };
  }
  if (!args.title) {
    return { success: false, message: 'title of new decision is required' };
  }
  if (!args.description) {
    return { success: false, message: 'description of new decision is required' };
  }
  const result = await svc.reviseDecision({
    oldDecisionId: args.id,
    title: args.title,
    description: args.description,
    rationale: args.rationale || '',
    reason: args.reason || '',
  });
  return {
    success: true,
    data: {
      newDecision: result.newDecision.toJSON(),
      superseded: result.oldDecisionId,
    },
    message: `Decision revised: ${result.oldDecisionId} → ${result.newDecision.id}`,
  };
}

// ── unpin_decision ──

async function _unpinDecision(svc: TaskGraphSvc, args: Record<string, unknown>) {
  if (!args.id) {
    return { success: false, message: 'id is required' };
  }
  const task = await svc.unpinDecision(args.id, args.reason || '');
  return {
    success: true,
    data: task.toJSON(),
    message: `Decision ${args.id} unpinned and closed`,
  };
}

export default router;
