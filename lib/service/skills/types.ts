/**
 * SkillHooks — 统一类型定义
 *
 * 覆盖: SkillHooks
 */

// ═══════════════════════════════════════════════════════
//  Hook 系统类型
// ═══════════════════════════════════════════════════════

/** Hook 执行模式 — 受 Webpack Tapable 启发，简化为 4 种核心语义 */
export type HookMode =
  /** 串行执行，所有 handler 按优先级顺序执行，忽略返回值 */
  | 'series'
  /** 并行执行，所有 handler Promise.allSettled (fire-and-forget) */
  | 'parallel'
  /** 串行传值，前一个 handler 的返回值作为下一个的第一个参数 */
  | 'waterfall'
  /** 串行短路，首个返回 truthy 值（含 {block:true}）的 handler 终止链 */
  | 'bail';

/** Hook 定义 */
export interface HookDefinition {
  name: string;
  mode: HookMode;
  description: string;
}

/** Handler 注册选项 */
export interface HookHandlerOptions {
  /** handler 名称 (用于日志和调试) */
  name: string;
  /** 执行优先级 (越小越先，默认 100) */
  priority?: number;
  /** 超时 (ms)，超时自动跳过，默认 10000 */
  timeout?: number;
}

/** 已注册的 Handler 内部表示 */
export interface RegisteredHandler {
  fn: (...args: unknown[]) => Promise<unknown> | unknown;
  name: string;
  priority: number;
  timeout: number;
}
