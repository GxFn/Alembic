/**
 * UnifiedDimension — 统一维度类型定义
 *
 * Bootstrap / Panorama / Rescan 共用的维度接口，
 * 消除三套维度体系之间的 ID 不一致和字段缺失问题。
 *
 * 设计文档: docs/copilot/unified-dimension-design.md §4
 *
 * @module domain/dimension/UnifiedDimension
 */

// ═══════════════════════════════════════════════════════════
// 统一维度接口
// ═══════════════════════════════════════════════════════════

/** 统一维度定义 — Bootstrap/Panorama/Rescan 共用 */
export interface UnifiedDimension {
  /** 维度唯一 ID，kebab-case */
  readonly id: string;
  /** 维度中文标签（Dashboard 分组标签） */
  readonly label: string;
  /** 层级: universal | language | framework */
  readonly layer: 'universal' | 'language' | 'framework';

  // ── 显示面 (Dashboard UI 使用) ──
  /** Lucide 图标名 */
  readonly icon: string;
  /** Tailwind 颜色族（如 'violet', 'fuchsia', 'sky'） */
  readonly colorFamily: string;

  // ── 提取面 (Bootstrap/Rescan 使用) ──
  /** 提取指南 — 告诉 Agent 从项目中挖掘什么 */
  readonly extractionGuide: string;
  /** 允许的 knowledgeType */
  readonly allowedKnowledgeTypes: readonly string[];
  /** 输出模式（当前阶段仅 candidate-only，Skill 后续规划） */
  readonly outputMode: 'candidate-only';

  // ── 评估面 (Panorama 使用) ──
  /** 健康评估描述 */
  readonly qualityDescription: string;
  /** 主匹配字段: topicHint */
  readonly matchTopics: readonly string[];
  /** 次匹配字段: category */
  readonly matchCategories: readonly string[];
  /** 维度权重 (0-1, Panorama 加权平均) */
  readonly weight: number;
  /** gap 时的建议主题 */
  readonly suggestedTopics: readonly string[];
  /** 关联模块角色 (gap 优先级推断) */
  readonly relatedRoles: readonly string[];

  // ── 条件面 (Layer 2/3 使用) ──
  readonly conditions?: {
    readonly languages?: readonly string[];
    readonly frameworks?: readonly string[];
  };

  // ── 执行面 (TierScheduler 使用) ──
  /** 1=最先 (Tier 1), 2=中间, 3=最后 */
  readonly tierHint?: number;

  // ── 展示面 (Agent 工具分组使用) ──
  /** Dashboard 展示分组 */
  readonly displayGroup: 'architecture' | 'best-practice' | 'data-event-flow' | 'deep-scan';
}

// ═══════════════════════════════════════════════════════════
// 维度 ID 常量
// ═══════════════════════════════════════════════════════════

/** Layer 1: 通用维度 ID */
export const UNIVERSAL_DIM_IDS = [
  'architecture',
  'coding-standards',
  'design-patterns',
  'error-resilience',
  'concurrency-async',
  'data-event-flow',
  'networking-api',
  'ui-interaction',
  'testing-quality',
  'security-auth',
  'performance-optimization',
  'observability-logging',
  'agent-guidelines',
] as const;

/** Layer 2: 语言维度 ID */
export const LANGUAGE_DIM_IDS = [
  'swift-objc-idiom',
  'ts-js-module',
  'python-structure',
  'jvm-annotation',
  'go-module',
  'rust-ownership',
  'csharp-dotnet',
] as const;

/** Layer 3: 框架维度 ID */
export const FRAMEWORK_DIM_IDS = [
  'react-patterns',
  'vue-patterns',
  'spring-patterns',
  'swiftui-patterns',
  'django-fastapi',
] as const;

export type UniversalDimId = (typeof UNIVERSAL_DIM_IDS)[number];
export type LanguageDimId = (typeof LANGUAGE_DIM_IDS)[number];
export type FrameworkDimId = (typeof FRAMEWORK_DIM_IDS)[number];
export type DimensionId = UniversalDimId | LanguageDimId | FrameworkDimId;

/** 所有维度 ID 数组 */
export const ALL_DIMENSION_IDS = [
  ...UNIVERSAL_DIM_IDS,
  ...LANGUAGE_DIM_IDS,
  ...FRAMEWORK_DIM_IDS,
] as const;
