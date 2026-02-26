/**
 * MCP Handler — TaskGraph 任务管理
 *
 * 操作路由：
 *   create / decompose / claim / close / fail / defer / progress
 *   ready / prime / show / list / blocked / dep_add / dep_tree / stats
 */

import { envelope } from '../envelope.js';

/**
 * 统一入口
 * @param {object} ctx — { container }
 * @param {object} args — { operation, ...params }
 */
export async function taskHandler(ctx, args) {
  const taskService = ctx.container.get('taskGraphService');

  switch (args.operation) {
    case 'create':
      return _create(taskService, args);
    case 'ready':
      return _ready(taskService, args);
    case 'claim':
      return _claim(taskService, args);
    case 'close':
      return _close(taskService, args);
    case 'fail':
      return _fail(taskService, args);
    case 'defer':
      return _defer(taskService, args);
    case 'progress':
      return _progress(taskService, args);
    case 'prime':
      return _prime(taskService);
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
    default:
      return envelope({
        success: false,
        message: `Unknown operation: ${args.operation}`,
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

async function _close(svc, args) {
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

// ── prime — 会话恢复 ──

async function _prime(svc) {
  const result = await svc.prime({ withKnowledge: true });
  return envelope({
    success: true,
    data: result,
    message: `${result.inProgress.length} in-progress, ${result.ready.length} ready, ${result.stats.total} total`,
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
