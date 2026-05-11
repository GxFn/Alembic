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
  /** 模块类型: local(有源码) / external(第三方) / host(宿主应用) */
  kind?: 'local' | 'external' | 'host';
}

/* ═══ External Dependency Profile ═════════════════════════ */

export interface ExternalDepProfile {
  name: string;
  /** 被多少本地模块依赖 */
  fanIn: number;
  /** 依赖此外部库的本地模块列表 */
  dependedBy: string[];
  /** 所属层级 */
  layer?: string;
  /** 声明版本 */
  version?: string;
  /** 技术栈分类标签 */
  category?: string;
}

export interface TechStackProfile {
  /** 按类别分组的外部依赖 */
  categories: Array<{
    name: string;
    deps: Array<{ name: string; fanIn: number; version?: string }>;
  }>;
  /** 关键外部依赖（fan-in ≥ 3 的热点） */
  hotspots: Array<{ name: string; fanIn: number; dependedBy: string[] }>;
  /** 外部依赖总数 */
  totalExternalDeps: number;
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
  /** 是否基于配置文件（如 Boxfile）声明的层级推断（而非纯拓扑） */
  configBased?: boolean;
}

export interface CyclicDependency {
  cycle: string[];
  severity: 'error' | 'warning';
}

/* ═══ Health Radar — 多维度知识健康模型 ════════════════════ */

/**
 * 知识维度定义 (灵感来源: ISO/IEC 25010 质量模型 + ThoughtWorks Tech Radar)
 *
 * 每个维度代表项目应具备知识规范的一个方向，
 * score 反映该方向上 Recipe 的丰厚程度。
 */
export interface HealthDimension {
  /** 维度 ID */
  id: string;
  /** 人类可读名称 */
  name: string;
  /** 维度说明 */
  description: string;
  /** 该维度匹配到的 recipe 数 */
  recipeCount: number;
  /** 得分 0-100 */
  score: number;
  /** 状态: strong(≥5) / adequate(2-4) / weak(1) / missing(0) */
  status: 'strong' | 'adequate' | 'weak' | 'missing';
  /** 雷达环级: adopt / trial / assess / hold */
  level: 'adopt' | 'trial' | 'assess' | 'hold';
  /** 该维度下 recipe 标题示例 (最多 3 个) */
  topRecipes: string[];
}

/**
 * 项目知识健康雷达图
 */
export interface HealthRadar {
  /** 各维度得分 */
  dimensions: HealthDimension[];
  /** 综合健康分 0-100 (加权平均) */
  overallScore: number;
  /** 活跃 recipe 总数 */
  totalRecipes: number;
  /** 已覆盖维度数 (recipeCount > 0) */
  coveredDimensions: number;
  /** 总维度数 */
  totalDimensions: number;
  /** 维度覆盖率 */
  dimensionCoverage: number;
}

/* ═══ Knowledge Gap — 基于维度的知识空白检测 ══════════════ */

export interface KnowledgeGap {
  /** 空白维度 ID */
  dimension: string;
  /** 空白维度名称 */
  dimensionName: string;
  /** 该维度已有 recipe 数 */
  recipeCount: number;
  /** 空白状态 */
  status: 'weak' | 'missing';
  /** 优先级 */
  priority: 'high' | 'medium' | 'low';
  /** 建议补充的主题方向 */
  suggestedTopics: string[];
  /** 受影响的模块角色 */
  affectedRoles: string[];
}

export interface CallFlowSummary {
  topCalledMethods: Array<{ id: string; callCount: number }>;
  entryPoints: string[];
  dataProducers: string[];
  dataConsumers: string[];
}

/* ═══ Module Role ═════════════════════════════════════════ */

// Canonical definition lives in LanguageProfiles; re-exported here for panorama consumers.
export type { ModuleRole } from '#shared/LanguageProfiles.js';

export interface PanoramaResult {
  modules: Map<string, PanoramaModule>;
  layers: LayerHierarchy;
  cycles: CyclicDependency[];
  gaps: KnowledgeGap[];
  /** 多维度知识健康雷达 */
  healthRadar: HealthRadar;
  callFlowSummary: CallFlowSummary;
  /** 项目级活跃 recipe 总数（不限模块匹配） */
  projectRecipeCount: number;
  /** 外部依赖概况 */
  externalDeps: ExternalDepProfile[];
  /** 技术栈画像 */
  techStack: TechStackProfile | null;
  computedAt: number;
}
