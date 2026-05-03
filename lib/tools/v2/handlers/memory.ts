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
    case 'note_finding':
      return handleNoteFinding(params, ctx);
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

/**
 * memory.note_finding — 记录结构化关键发现到 ActiveContext.#scratchpad。
 * 桥接 MemoryCoordinator.noteFinding()，使 QualityGate 能通过
 * distill().keyFindings 评估 evidenceScore。
 */
async function handleNoteFinding(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const finding = params.finding as string | undefined;
  if (!finding) {
    return fail('memory.note_finding requires "finding" param');
  }

  const evidence = (params.evidence as string) || '';
  const importance = Math.min(10, Math.max(1, (params.importance as number) || 5));
  const round = (params.round as number) || 0;

  if (!ctx.memoryCoordinator) {
    if (ctx.sessionStore) {
      ctx.sessionStore.save(`finding:${Date.now()}`, finding, {
        tags: ['finding'],
        evidence,
        importance,
      });
      return ok({
        recorded: true,
        target: 'sessionStore',
        importance,
        message: `📌 Finding recorded (sessionStore fallback): "${finding.substring(0, 80)}"`,
      });
    }
    return fail('Neither memoryCoordinator nor sessionStore available');
  }

  const message = ctx.memoryCoordinator.noteFinding(finding, evidence, importance, round);
  return ok({ recorded: true, target: 'activeContext', importance, message });
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
