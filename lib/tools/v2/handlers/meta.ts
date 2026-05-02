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
    const lines = Object.values(registry).map((spec) => {
      const acts = Object.entries(spec.actions)
        .map(([k, v]) => `  ${k}: ${v.summary}`)
        .join('\n');
      return `[${spec.name}] ${spec.description}\n${acts}`;
    });
    const text = lines.join('\n\n');
    return ok(text, { tokensEstimate: estimateTokens(text) });
  }

  const spec = registry[name];
  if (!spec) {
    return fail(`Unknown tool: ${name}. Available: ${Object.keys(registry).join(', ')}`);
  }

  const sections: string[] = [`[${spec.name}] ${spec.description}\n`];
  for (const [k, v] of Object.entries(spec.actions)) {
    const paramDesc = v.params?.properties
      ? Object.entries(v.params.properties as Record<string, Record<string, unknown>>)
          .map(([pk, pv]) => {
            const required = ((v.params?.required as string[]) ?? []).includes(pk);
            const enumVals = pv.enum ? ` (${(pv.enum as string[]).join('|')})` : '';
            return `    ${pk}${required ? '*' : ''}: ${pv.type ?? 'any'}${enumVals} — ${pv.description ?? ''}`;
          })
          .join('\n')
      : '    (no params)';
    sections.push(`  ${k} [${v.risk ?? 'read-only'}]: ${v.summary}\n${paramDesc}`);
  }
  const text = sections.join('\n');
  return ok(text, { tokensEstimate: estimateTokens(text) });
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
