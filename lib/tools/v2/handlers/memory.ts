/**
 * @module tools/v2/handlers/memory
 *
 * Agent 工作记忆 — 跨轮次的发现记录和召回。
 * Actions: save, recall, note_finding, get_previous_evidence
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
    case 'get_previous_evidence':
      return handleGetPreviousEvidence(params, ctx);
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
 * memory action note_finding — 记录结构化关键发现到 ActiveContext.#scratchpad。
 * 桥接 MemoryCoordinator.noteFinding()，使 QualityGate 能通过
 * distill().keyFindings 评估 evidenceScore。
 */
async function handleNoteFinding(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const finding = params.finding as string | undefined;
  if (!finding) {
    return fail('memory action note_finding requires "finding" param');
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

/**
 * memory.get_previous_evidence — 检索前序维度对特定文件/类/模式的分析证据。
 * 桥接 MemoryCoordinator.searchEvidence()，避免跨维度重复搜索。
 */
async function handleGetPreviousEvidence(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const query = params.query as string | undefined;
  if (!query) {
    return fail('memory.get_previous_evidence requires "query" param');
  }
  const dimId = params.dimId as string | undefined;

  if (!ctx.memoryCoordinator?.searchEvidence) {
    return ok({
      count: 0,
      items: [],
      message: `没有找到与 "${query}" 相关的前序证据。建议自行搜索。`,
    });
  }

  const results = ctx.memoryCoordinator.searchEvidence(query, dimId);

  if (results.length === 0) {
    return ok({
      count: 0,
      items: [],
      message: `没有找到与 "${query}" 相关的前序证据。建议自行搜索。`,
    });
  }

  const lines = [`📋 前序维度证据 (匹配 "${query}", ${results.length} 条):`];
  for (const r of results.slice(0, 8)) {
    lines.push(`  📄 ${r.filePath}`);
    lines.push(
      `     [${r.evidence.dimId || '?'}] [${r.evidence.importance || 5}/10] ${r.evidence.finding}`
    );
  }
  if (results.length > 8) {
    lines.push(`  …还有 ${results.length - 8} 条证据`);
  }

  const formatted = lines.join('\n');
  return ok(
    { count: results.length, summary: formatted },
    { tokensEstimate: estimateTokens(formatted) }
  );
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
