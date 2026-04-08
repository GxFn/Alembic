/**
 * §11.3 H3: MemoryFlushContract — 层级数据流转规约
 *
 * 定义 completeDimension() 保存数据的显式检查表,
 * 确保 distill() 的结果在 ActiveContext.clear() 之前完整提取。
 */

import type { Finding } from './SessionStore.js';

// ──────────────────────────────────────────────────────────────────
// DistilledContext — distill() 的显式返回类型
// ──────────────────────────────────────────────────────────────────

/** ActiveContext.distill() 的结构化返回类型 */
export interface DistilledContext {
  keyFindings: Array<{ finding: string; evidence: string; importance: number }>;
  toolCallSummary: string[];
  stats: {
    totalRounds: number;
    thoughtCount: number;
    totalActions: number;
    totalObservations: number;
    reflectionCount: number;
    totalDurationMs: number;
  };
  plan: {
    text: string;
    steps: Array<{ description: string; status: string; keywords: string[] }>;
    createdAtIteration: number;
    lastUpdatedAtIteration: number;
  } | null;
  totalObservations: number;
  compressedCount: number;
}

// ──────────────────────────────────────────────────────────────────
// DimensionFlushManifest — completeDimension 的数据保全清单
// ──────────────────────────────────────────────────────────────────

/** completeDimension() 执行数据保存时使用的结构化清单 */
export interface DimensionFlushManifest {
  /** distill() 的结果 — 总是存入 SessionStore */
  distilled: DistilledContext;

  /** 原始 scratchpad findings — 重要性 >= threshold 的需要转发 */
  highPriorityFindings: Finding[];

  /** 工具调用统计 — 用于 SessionStore.toolCallLog */
  toolCallSummary: string[];

  /** 是否触发向 PersistentMemory 的异步 consolidation */
  shouldConsolidate: boolean;
}

/** 从 DistilledContext 提取高优先级 findings (importance >= threshold) */
export function extractHighPriorityFindings(distilled: DistilledContext, threshold = 7): Finding[] {
  return distilled.keyFindings
    .filter((f) => f.importance >= threshold)
    .map((f) => ({
      finding: f.finding,
      evidence: f.evidence,
      importance: f.importance,
    }));
}
