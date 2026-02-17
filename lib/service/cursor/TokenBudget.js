/**
 * TokenBudget — Token 预算控制
 *
 * 简易 token 估算器（1 token ≈ 4 chars for English, 2 chars for CJK），
 * 用于确保 .mdc 文件不超出 Cursor 上下文预算。
 */

/** 默认预算配置 */
export const BUDGET = {
  CHANNEL_A_MAX: 400,        // Always-On Rules 最大 token
  CHANNEL_B_MAX_PER_FILE: 750, // Smart Rules 每个主题文件最大 token
  CHANNEL_B_MAX_PATTERNS: 5, // Smart Rules 每个主题最多模式数
  CHANNEL_A_MAX_RULES: 8,    // Always-On Rules 最多规则数
};

/**
 * 估算文本 token 数
 * 简易算法：英文按 4 chars/token，CJK 按 2 chars/token
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) {
    // CJK Unified Ideographs + common CJK ranges
    if (ch.charCodeAt(0) > 0x2e80) {
      tokens += 0.5; // ~2 chars per token for CJK
    } else {
      tokens += 0.25; // ~4 chars per token for English
    }
  }
  return Math.ceil(tokens);
}

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
