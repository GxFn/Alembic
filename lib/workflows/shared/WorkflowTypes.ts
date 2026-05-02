/**
 * WorkflowTypes — 冷启动 & 增量扫描管线共享类型和工具函数
 *
 * 消除 ColdStartIntent / KnowledgeRescanIntent / InternalColdStartWorkflow /
 * InternalKnowledgeRescanWorkflow 等文件中的重复定义。
 *
 * @module workflows/shared/WorkflowTypes
 */

// ── Logger / Context 共享接口 ──

export interface WorkflowLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error?(...args: unknown[]): void;
  debug?(...args: unknown[]): void;
}

export interface WorkflowMcpContext {
  container: {
    get(name: string): unknown;
  };
  logger: WorkflowLogger;
}

// ── Intent 参数规范化 ──

export function normalizeDimensionIds(dimensions: unknown): string[] | undefined {
  const values = normalizeStringArray(dimensions);
  return values && values.length > 0 ? values : undefined;
}

export function normalizeStringArray(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  return values.filter((value): value is string => typeof value === 'string');
}

// ── Workflow 执行模式 ──

export type WorkflowExecutor = 'internal-agent' | 'external-agent';
export type WorkflowAnalysisMode = 'full' | 'incremental';
