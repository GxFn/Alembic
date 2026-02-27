/**
 * MCP Handler — autosnippet_ready
 *
 * Agent 的首要入口：加载项目上下文 + 就绪任务 + 团队决策。
 * 等同于 Beads 的 `bd ready`，但含知识桥接和决策持久化。
 *
 * 无参数即可调用。Agent 看到工具名就知道"先看看有什么可做的"。
 */

import { envelope } from '../envelope.js';

/**
 * @param {object} ctx — { container }
 * @param {object} args — { limit?, withKnowledge? }
 */
export async function readyHandler(ctx, args = {}) {
  const taskService = ctx.container.get('taskGraphService');
  const result = await taskService.prime({
    limit: args.limit || 10,
    withKnowledge: args.withKnowledge !== false,
  });

  const decisionCount = (result.decisions || []).length;
  const staleCount = (result.staleDecisions || []).length;
  const decisionTitles = (result.decisions || []).map((d) => d.title).join('; ');
  const statsLine = `${result.inProgress.length} in-progress, ${result.ready.length} ready, ${result.stats.total} total`;

  let message;
  if (decisionCount > 0) {
    const stalePart = staleCount > 0 ? ` ${staleCount} stale.` : '';
    message = `⚠️ ${decisionCount} ACTIVE DECISION(S): [${decisionTitles}].${stalePart} ${statsLine}.`;
  } else {
    message = `${statsLine}.`;
  }

  return envelope({
    success: true,
    data: result,
    message,
    meta: { tool: 'autosnippet_ready' },
  });
}
