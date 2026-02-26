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

import express from 'express';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

/**
 * POST /api/v1/task
 *
 * 请求体:
 *   { operation: string, ...params }
 *
 * 响应:
 *   { success: boolean, data?: any, message?: string }
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const container = getServiceContainer();
    const taskService = container.get('taskGraphService');

    if (!taskService) {
      return res.status(503).json({
        success: false,
        message: 'TaskGraphService not available',
      });
    }

    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'JSON body is required',
      });
    }

    const { operation, ...params } = body;

    if (!operation) {
      return res.status(400).json({
        success: false,
        message: 'operation is required',
      });
    }

    try {
      const result = await _dispatch(taskService, operation, params);
      if (result.success === false) {
        return res.status(400).json(result);
      }
      return res.json(result);
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: err.message,
        operation,
      });
    }
  })
);

/**
 * 操作路由 — 与 MCP handler/task.js 保持一致
 */
async function _dispatch(svc, operation, params) {
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
    default:
      return { success: false, message: `Unknown operation: ${operation}` };
  }
}

// ── create ──

async function _create(svc, args) {
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

async function _ready(svc, args) {
  const tasks = await svc.ready({
    limit: args.limit || 5,
    withKnowledge: args.withKnowledge !== false,
  });
  return {
    success: true,
    data: tasks.map((t) => (t.toJSON ? t.toJSON() : t)),
    count: tasks.length,
  };
}

// ── claim ──

async function _claim(svc, args) {
  if (!args.id) return { success: false, message: 'id is required' };
  const task = await svc.claim(args.id, args.assignee || 'agent');
  return { success: true, data: task.toJSON() };
}

// ── close ──

async function _close(svc, args) {
  if (!args.id) return { success: false, message: 'id is required' };
  const { task, newlyReady } = await svc.close(args.id, args.reason || 'Completed');
  return {
    success: true,
    data: task.toJSON(),
    newlyReady,
    message: `Closed ${task.id}. ${newlyReady.length} tasks newly ready.`,
  };
}

// ── fail ──

async function _fail(svc, args) {
  if (!args.id) return { success: false, message: 'id is required' };
  const task = await svc.fail(args.id, args.reason || '');
  return { success: true, data: task.toJSON() };
}

// ── defer ──

async function _defer(svc, args) {
  if (!args.id) return { success: false, message: 'id is required' };
  const task = await svc.defer(args.id, args.reason || '');
  return { success: true, data: task.toJSON() };
}

// ── progress ──

async function _progress(svc, args) {
  if (!args.id) return { success: false, message: 'id is required' };
  const task = await svc.progress(args.id, args.note || args.description || '');
  return { success: true, data: task.toJSON() };
}

// ── prime ──

async function _prime(svc) {
  const result = await svc.prime({ withKnowledge: true });
  return { success: true, data: result };
}

// ── decompose ──

async function _decompose(svc, args) {
  const epicId = args.parentId || args.id;
  const subtasks = args.children || args.subtasks;
  if (!epicId) return { success: false, message: 'parentId (or id) is required' };
  if (!subtasks || !Array.isArray(subtasks)) {
    return { success: false, message: 'children (or subtasks) array is required' };
  }
  const tasks = await svc.decompose(epicId, subtasks);
  return {
    success: true,
    data: tasks.map((t) => t.toJSON()),
    count: tasks.length,
  };
}

// ── show ──

async function _show(svc, args) {
  if (!args.id) return { success: false, message: 'id is required' };
  const task = await svc.show(args.id);
  if (!task) return { success: false, message: `Task ${args.id} not found` };
  return { success: true, data: task.toJSON() };
}

// ── list ──

async function _list(svc, args) {
  const tasks = await svc.list(
    { status: args.status, taskType: args.taskType, parentId: args.parentId },
    { limit: args.limit || 50 }
  );
  return {
    success: true,
    data: tasks.map((t) => t.toJSON()),
    count: tasks.length,
  };
}

// ── blocked ──

async function _blocked(svc) {
  const tasks = await svc.blocked();
  return {
    success: true,
    data: tasks.map((t) => (t.toJSON ? t.toJSON() : t)),
    count: tasks.length,
  };
}

// ── dep_add ──

async function _depAdd(svc, args) {
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

async function _depTree(svc, args) {
  if (!args.id) return { success: false, message: 'id is required' };
  const tree = await svc.depTree(args.id);
  return { success: true, data: tree };
}

// ── stats ──

async function _stats(svc) {
  const stats = await svc.stats();
  return { success: true, data: stats };
}

export default router;
