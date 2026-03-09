/**
 * token-utils — 统一 Token 估算工具
 *
 * 项目内所有 token 估算统一使用此模块，避免各处使用不同的字符/token 比率。
 *
 * 算法：CJK 字符按 ~2 chars/token，ASCII 字符按 ~4 chars/token。
 * 这与主流 tokenizer (tiktoken / SentencePiece) 的行为一致：
 *   - GPT-4 tokenizer: 英文 ~4 chars/token, 中文 ~1.5 chars/token
 *   - Gemini (SentencePiece): 类似比率
 *   - 本实现取保守值, 宁多不少
 *
 * @module shared/token-utils
 */

/**
 * 估算文本的 token 数量
 *
 * @param text 待估算的文本
 * @returns 估算 token 数（向上取整）
 */
export function estimateTokens(text: string) {
  if (!text) {
    return 0;
  }
  let tokens = 0;
  for (const ch of text) {
    // CJK Unified Ideographs + 扩展区 + 常见符号区
    if (ch.charCodeAt(0) > 0x2e80) {
      tokens += 0.5; // ~2 chars per token for CJK
    } else {
      tokens += 0.25; // ~4 chars per token for English/ASCII
    }
  }
  return Math.ceil(tokens);
}

/**
 * 快速估算 — 纯 ASCII 场景下的快速路径（不区分 CJK，统一按 3.5 chars/token）
 *
 * 适用于已知只含英文 / 混合语言但无需精确的场景（如 ContextWindow 内部压缩阈值）。
 */
export function estimateTokensFast(text: string) {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 3.5);
}
