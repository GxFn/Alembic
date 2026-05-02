/**
 * @module tools/v2/handlers/memory
 *
 * Agent 工作记忆 — 跨轮次的发现记录和召回。
 * Actions: save, recall
 */

import { estimateTokens, fail, ok, type ToolContext, type ToolResult } from '../types.js';

export async function handle(
  action: string,
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  switch (action) {
    case 'save':
      return handleSave(params, ctx);
    case 'recall':
      return handleRecall(params, ctx);
    default:
      return fail(`Unknown memory action: ${action}`);
  }
}

async function handleSave(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const key = params.key as string | undefined;
  const content = params.content as string | undefined;

  if (!key || !content) {
    return fail('memory.save requires key and content');
  }

  const tags = params.tags as string[] | undefined;
  const category = params.category as string | undefined;

  if (!ctx.sessionStore) {
    return fail('Session store not available');
  }

  const meta: Record<string, unknown> = {};
  if (tags) {
    meta.tags = tags;
  }
  if (category) {
    meta.category = category;
  }

  ctx.sessionStore.save(key, content, meta);

  return ok({ saved: key, size: content.length });
}

async function handleRecall(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  if (!ctx.sessionStore) {
    return fail('Session store not available');
  }

  const query = params.query as string | undefined;
  const tags = params.tags as string[] | undefined;
  const limit = (params.limit as number) || 10;

  const results = ctx.sessionStore.recall(query, { tags, limit });

  if (results.length === 0) {
    return ok({ count: 0, items: [], message: 'No memories found' });
  }

  const formatted = results.map((r) => `[${r.key}] ${r.content}`).join('\n\n');
  return ok(
    { count: results.length, items: results },
    { tokensEstimate: estimateTokens(formatted) }
  );
}
