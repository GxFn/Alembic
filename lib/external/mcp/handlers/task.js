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
// guard is independent — no guardState dependency in task lifecycle

/**
 * 统一入口
 * @param {object} ctx — { container }
 * @param {object} args — { operation, ...params }
 */
export async function taskHandler(ctx, args) {
  const taskService = ctx.container.get('taskGraphService');

  switch (args.operation) {
    // ── Session ──
    case 'prime':
      return _prime(taskService, args);
    // ── Task CRUD ──
    case 'create':
      return _create(taskService, args);
    case 'ready':
      return _ready(taskService, args);
    case 'claim':
      return _claim(taskService, args);
    case 'close':
      return _close(ctx, taskService, args);
    case 'fail':
      return _fail(taskService, args);
    case 'defer':
      return _defer(taskService, args);
    case 'progress':
      return _progress(taskService, args);
    case 'decompose':
      return _decompose(taskService, args);
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
      return _recordDecision(taskService, args);
    case 'revise_decision':
      return _reviseDecision(taskService, args);
    case 'unpin_decision':
      return _unpinDecision(taskService, args);
    case 'list_decisions':
      return _listDecisions(taskService);
    default:
      return envelope({
        success: false,
        message: `Unknown operation: ${args.operation}. Valid: prime, ready, create, claim, close, fail, defer, progress, decompose, dep_add, dep_tree, stats, list, record_decision, revise_decision, unpin_decision, list_decisions.`,
        meta: { tool: 'autosnippet_task' },
      });
  }
}

// ── create ──

async function _create(svc, args) {
  if (!args.title) {
    return envelope({ success: false, message: 'title is required', meta: { tool: 'autosnippet_task' } });
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

async function _ready(svc, args) {
  const tasks = await svc.ready({
    limit: args.limit || 10,
    withKnowledge: args.withKnowledge !== false,
  });
  return envelope({
    success: true,
    data: tasks.map((t) => (t.toJSON ? t.toJSON() : t)),
    message: `${tasks.length} task(s) ready`,
    meta: { tool: 'autosnippet_task' },
  });
}

// ── claim ──

async function _claim(svc, args) {
  if (!args.id) {
    return envelope({ success: false, message: 'id is required', meta: { tool: 'autosnippet_task' } });
  }
  const task = await svc.claim(args.id);
  return envelope({
    success: true,
    data: task.toJSON(),
    message: `Claimed ${args.id}`,
    meta: { tool: 'autosnippet_task' },
  });
}

// ── close ──

async function _close(ctx, svc, args) {
  if (!args.id) {
    return envelope({ success: false, message: 'id is required', meta: { tool: 'autosnippet_task' } });
  }

  const { task, newlyReady } = await svc.close(args.id, args.reason || 'Completed');
  return envelope({
    success: true,
    data: {
      closed: task.toJSON(),
      newlyReady,
    },
    message: `Closed ${args.id}. ${newlyReady.length} task(s) newly ready.`,
    meta: { tool: 'autosnippet_task' },
  });
}

// ── fail ──

async function _fail(svc, args) {
  if (!args.id) {
    return envelope({ success: false, message: 'id is required', meta: { tool: 'autosnippet_task' } });
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

async function _defer(svc, args) {
  if (!args.id) {
    return envelope({ success: false, message: 'id is required', meta: { tool: 'autosnippet_task' } });
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

async function _progress(svc, args) {
  if (!args.id) {
    return envelope({ success: false, message: 'id is required', meta: { tool: 'autosnippet_task' } });
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

async function _decompose(svc, args) {
  if (!args.id) {
    return envelope({ success: false, message: 'Epic id is required', meta: { tool: 'autosnippet_task' } });
  }
  if (!args.subtasks || !Array.isArray(args.subtasks) || args.subtasks.length === 0) {
    return envelope({ success: false, message: 'subtasks array is required', meta: { tool: 'autosnippet_task' } });
  }
  const tasks = await svc.decompose(args.id, args.subtasks);
  return envelope({
    success: true,
    data: tasks.map((t) => (t.toJSON ? t.toJSON() : t)),
    message: `Decomposed ${args.id} into ${tasks.length} subtasks`,
    meta: { tool: 'autosnippet_task' },
  });
}

// ── show ──

async function _show(svc, args) {
  if (!args.id) {
    return envelope({ success: false, message: 'id is required', meta: { tool: 'autosnippet_task' } });
  }
  const task = await svc.show(args.id);
  if (!task) {
    return envelope({ success: false, message: `Task not found: ${args.id}`, meta: { tool: 'autosnippet_task' } });
  }
  return envelope({
    success: true,
    data: task.toJSON(),
    meta: { tool: 'autosnippet_task' },
  });
}

// ── list ──

async function _list(svc, args) {
  const filters = {};
  if (args.status) filters.status = args.status;
  if (args.taskType) filters.taskType = args.taskType;

  const tasks = await svc.list(filters, { limit: args.limit || 20 });
  return envelope({
    success: true,
    data: tasks.map((t) => t.toJSON()),
    message: `${tasks.length} task(s)`,
    meta: { tool: 'autosnippet_task' },
  });
}

// ── blocked ──

async function _blocked(svc) {
  const tasks = await svc.blocked();
  return envelope({
    success: true,
    data: tasks,
    message: `${tasks.length} blocked task(s)`,
    meta: { tool: 'autosnippet_task' },
  });
}

// ── dep_add ──

async function _depAdd(svc, args) {
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

async function _depTree(svc, args) {
  if (!args.id) {
    return envelope({ success: false, message: 'id is required', meta: { tool: 'autosnippet_task' } });
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

async function _stats(svc) {
  const stats = await svc.stats();
  return envelope({
    success: true,
    data: stats,
    meta: { tool: 'autosnippet_task' },
  });
}

// ═══ Session (prime) ═══════════════════════════════════

async function _prime(svc, args) {
  const result = await svc.prime({
    limit: args.limit || 10,
    withKnowledge: args.withKnowledge !== false,
  });

  const decisionCount = (result.decisions || []).length;
  const staleCount = (result.staleDecisions || []).length;
  const decisionTitles = (result.decisions || []).map((d) => d.title).join('; ');
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

  let message;
  if (decisionCount > 0) {
    const stalePart = staleCount > 0 ? ` ${staleCount} stale.` : '';
    message = `⚠️ ${decisionCount} ACTIVE DECISION(S): [${decisionTitles}].${stalePart} ${statsLine}.`;
  } else {
    message = `${statsLine}.`;
  }

  // ── Resume Prompt: 有 inProgress 任务时，提示 Agent 让用户选择 ──
  if (result.inProgress.length > 0) {
    const taskList = result.inProgress.map((t) => {
      const age = t.updatedAt
        ? `${Math.floor((Date.now() / 1000 - t.updatedAt) / 86400)}d ago`
        : '';
      return `• **${t.id}** — ${t.title}${age ? ` (${age})` : ''}`;
    }).join('\n');

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
        'Wait for the user\'s answer. Do NOT auto-resume.',
      ].join('\n'),
      taskIds: result.inProgress.map((t) => t.id),
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

async function _recordDecision(svc, args) {
  if (!args.title) {
    return envelope({ success: false, message: 'title is required', meta: { tool: 'autosnippet_task' } });
  }
  if (!args.description) {
    return envelope({ success: false, message: 'description is required', meta: { tool: 'autosnippet_task' } });
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

async function _reviseDecision(svc, args) {
  if (!args.id) {
    return envelope({ success: false, message: 'id of old decision is required', meta: { tool: 'autosnippet_task' } });
  }
  if (!args.title) {
    return envelope({ success: false, message: 'title of new decision is required', meta: { tool: 'autosnippet_task' } });
  }
  if (!args.description) {
    return envelope({ success: false, message: 'description of new decision is required', meta: { tool: 'autosnippet_task' } });
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

async function _unpinDecision(svc, args) {
  if (!args.id) {
    return envelope({ success: false, message: 'id is required', meta: { tool: 'autosnippet_task' } });
  }
  const task = await svc.unpinDecision(args.id, args.reason || '');
  return envelope({
    success: true,
    data: task.toJSON(),
    message: `Decision ${args.id} unpinned and closed`,
    meta: { tool: 'autosnippet_task' },
  });
}

async function _listDecisions(svc) {
  const decisions = await svc.list({ status: 'pinned', taskType: 'decision' }, { limit: 50 });
  return envelope({
    success: true,
    data: decisions.map((d) => d.toJSON()),
    message: `${decisions.length} active decision(s)`,
    meta: { tool: 'autosnippet_task' },
  });
}
