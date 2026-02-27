/**
 * MCP Handler — autosnippet_decide
 *
 * 决策管理独立入口。Agent 与用户达成共识时调用。
 * 操作：record / revise / unpin / list
 */

import { envelope } from '../envelope.js';

/**
 * @param {object} ctx — { container }
 * @param {object} args — { operation, title, description, rationale, tags, relatedTaskId, id, reason }
 */
export async function decideHandler(ctx, args) {
  const taskService = ctx.container.get('taskGraphService');
  const op = args.operation || 'list';

  switch (op) {
    case 'record':
      return _record(taskService, args);
    case 'revise':
      return _revise(taskService, args);
    case 'unpin':
      return _unpin(taskService, args);
    case 'list':
      return _list(taskService);
    default:
      return envelope({
        success: false,
        message: `Unknown decide operation: ${op}. Use: record, revise, unpin, list`,
        meta: { tool: 'autosnippet_decide' },
      });
  }
}

async function _record(svc, args) {
  if (!args.title) {
    return envelope({ success: false, message: 'title is required', meta: { tool: 'autosnippet_decide' } });
  }
  if (!args.description) {
    return envelope({ success: false, message: 'description is required', meta: { tool: 'autosnippet_decide' } });
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
    meta: { tool: 'autosnippet_decide' },
  });
}

async function _revise(svc, args) {
  if (!args.id) {
    return envelope({ success: false, message: 'id of old decision is required', meta: { tool: 'autosnippet_decide' } });
  }
  if (!args.title) {
    return envelope({ success: false, message: 'title of new decision is required', meta: { tool: 'autosnippet_decide' } });
  }
  if (!args.description) {
    return envelope({ success: false, message: 'description of new decision is required', meta: { tool: 'autosnippet_decide' } });
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
    meta: { tool: 'autosnippet_decide' },
  });
}

async function _unpin(svc, args) {
  if (!args.id) {
    return envelope({ success: false, message: 'id is required', meta: { tool: 'autosnippet_decide' } });
  }
  const task = await svc.unpinDecision(args.id, args.reason || '');
  return envelope({
    success: true,
    data: task.toJSON(),
    message: `Decision ${args.id} unpinned and closed`,
    meta: { tool: 'autosnippet_decide' },
  });
}

async function _list(svc) {
  const decisions = await svc.list({ status: 'pinned', taskType: 'decision' }, { limit: 50 });
  return envelope({
    success: true,
    data: decisions.map(d => d.toJSON()),
    message: `${decisions.length} active decision(s)`,
    meta: { tool: 'autosnippet_decide' },
  });
}
