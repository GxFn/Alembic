/**
 * PanoramaTypes — 全景服务共享类型定义
 *
 * @module PanoramaTypes
 */

/* ═══ DB Abstraction ══════════════════════════════════════ */

export interface CeDbLike {
  getDb?: () => CeDbLike;
  transaction(fn: () => void): () => void;
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
}

/* ═══ Graph Primitives ════════════════════════════════════ */

export interface Edge {
  from: string;
  to: string;
  weight: number;
  relation: string;
}

/* ═══ Panorama Result Types ═══════════════════════════════ */

export interface PanoramaModule {
  name: string;
  inferredRole: string;
  refinedRole: string;
  roleConfidence: number;
  layer: number;
  fanIn: number;
  fanOut: number;
  files: string[];
  fileCount: number;
  recipeCount: number;
  coverageRatio: number;
}

export interface LayerLevel {
  level: number;
  name: string;
  modules: string[];
}

export interface LayerViolation {
  from: string;
  to: string;
  fromLayer: number;
  toLayer: number;
  relation: string;
}

export interface LayerHierarchy {
  levels: LayerLevel[];
  violations: LayerViolation[];
}

export interface CyclicDependency {
  cycle: string[];
  severity: 'error' | 'warning';
}

export interface KnowledgeGap {
  module: string;
  files: number;
  recipes: number;
  priority: 'high' | 'medium' | 'low';
  suggestedFocus: string[];
}

export interface CallFlowSummary {
  topCalledMethods: Array<{ id: string; callCount: number }>;
  entryPoints: string[];
  dataProducers: string[];
  dataConsumers: string[];
}

export interface PanoramaResult {
  modules: Map<string, PanoramaModule>;
  layers: LayerHierarchy;
  cycles: CyclicDependency[];
  gaps: KnowledgeGap[];
  callFlowSummary: CallFlowSummary;
  computedAt: number;
}
