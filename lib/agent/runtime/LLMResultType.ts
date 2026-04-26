/**
 * LLMResultType — LLM 调用结果类型枚举
 *
 * 替代 `{ __continue: true }` 魔术值，提供显式的类型安全控制流。
 *
 * 使用场景:
 *   - #callLLM() 返回值标记
 *   - #handleAiError() 返回值标记
 *   - ReAct 循环中的分支判断
 *
 * @module LLMResultType
 */

export const LLMResultType = Object.freeze({
  /** 继续循环 — 空响应重试、错误恢复后重试 */
  CONTINUE: 'continue',
  /** 文本响应 */
  TEXT: 'text',
  /** 工具调用 */
  TOOL_CALLS: 'tool_calls',
  /** 可恢复错误 (已处理，可继续) */
  ERROR: 'error',
  /** 不可恢复错误 (应退出循环) */
  FATAL: 'fatal',
});

/**
 * 创建 CONTINUE 类型的结果
 * @returns }
 */
export function continueResult() {
  return { type: LLMResultType.CONTINUE };
}
