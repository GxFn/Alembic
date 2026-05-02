/**
 * @module tools/v2/handlers/meta
 *
 * Agent 元工具 — 自省（查询工具 schema）、规划、自检。
 * Actions: tools, plan, review
 */

import { estimateTokens, fail, ok, type ToolContext, type ToolResult } from '../types.js';

export async function handle(
  action: string,
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  switch (action) {
    case 'tools':
      return handleTools(params, ctx);
    case 'plan':
      return handlePlan(params, ctx);
    case 'review':
      return handleReview(params, ctx);
    default:
      return fail(`Unknown meta action: ${action}`);
  }
}

/**
 * meta.tools — 按需返回工具的完整 action 参数 schema。
 * 无参数时返回所有工具的一行摘要。
 */
async function handleTools(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const registry = ctx.toolRegistry;
  if (!registry) {
    return fail('Tool registry not available');
  }

  const name = params.name as string | undefined;

  if (!name) {
    const summary = Object.values(registry).map((spec) => ({
      tool: spec.name,
      description: spec.description,
      actions: Object.entries(spec.actions).map(([k, v]) => `${k}: ${v.summary}`),
    }));
    return ok(summary);
  }

  const spec = registry[name];
  if (!spec) {
    return fail(`Unknown tool: ${name}. Available: ${Object.keys(registry).join(', ')}`);
  }

  const detail = {
    tool: spec.name,
    description: spec.description,
    actions: Object.fromEntries(
      Object.entries(spec.actions).map(([k, v]) => [
        k,
        {
          summary: v.summary,
          description: v.description,
          params: v.params,
          risk: v.risk ?? 'read-only',
        },
      ])
    ),
  };

  const text = JSON.stringify(detail, null, 2);
  return ok(detail, { tokensEstimate: estimateTokens(text) });
}

/**
 * meta.plan — 记录 Agent 的执行计划。
 * 不执行任何操作，纯粹让 Agent 结构化思考。
 */
async function handlePlan(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const steps = params.steps as Array<{ id: number; action: string; tool?: string }> | undefined;
  const strategy = params.strategy as string | undefined;

  if (!steps || !strategy) {
    return fail('meta.plan requires steps and strategy');
  }

  if (ctx.sessionStore) {
    ctx.sessionStore.save('_plan', JSON.stringify({ steps, strategy }), { tags: ['plan'] });
  }

  return ok({ recorded: true, steps: steps.length, strategy });
}

/**
 * meta.review — 自检已提交的候选质量。
 * 从 sessionStore 获取提交历史，汇总统计。
 */
async function handleReview(
  _params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  if (!ctx.sessionStore) {
    return ok({ message: 'No session store — cannot review submissions' });
  }

  const submissions = ctx.sessionStore.recall(undefined, { tags: ['submission'], limit: 50 });

  if (submissions.length === 0) {
    return ok({ message: 'No submissions found in this session', count: 0 });
  }

  return ok({
    count: submissions.length,
    submissions: submissions.map((s) => ({ key: s.key, preview: s.content.slice(0, 100) })),
    suggestion:
      submissions.length < 3
        ? 'Consider submitting more knowledge candidates'
        : 'Review the submissions above for completeness and accuracy',
  });
}
