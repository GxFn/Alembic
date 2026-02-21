/**
 * TokenBudget — Token 预算控制
 *
 * token 估算统一使用 shared/token-utils（CJK 感知），
 * 用于确保 .mdc 文件不超出 Cursor 上下文预算。
 */

import { estimateTokens } from '../../shared/token-utils.js';
export { estimateTokens };

/** 默认预算配置 */
export const BUDGET = {
  CHANNEL_A_MAX: 400, // Always-On Rules 最大 token
  CHANNEL_B_MAX_PER_FILE: 750, // Smart Rules 每个主题文件最大 token
  CHANNEL_B_MAX_PATTERNS: 5, // Smart Rules 每个主题最多模式数
  CHANNEL_A_MAX_RULES: 8, // Always-On Rules 最多规则数
};

/**
 * 按 token 预算截断内容行
 * @param {string[]} lines - 内容行
 * @param {number} budget - token 上限
 * @returns {{ kept: string[], dropped: number, tokensUsed: number }}
 */
export function truncateToTokenBudget(lines, budget) {
  const kept = [];
  let tokensUsed = 0;
  let dropped = 0;

  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (tokensUsed + lineTokens <= budget) {
      kept.push(line);
      tokensUsed += lineTokens;
    } else {
      dropped++;
    }
  }

  return { kept, dropped, tokensUsed };
}
