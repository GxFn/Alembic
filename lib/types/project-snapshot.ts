/**
 * ProjectSnapshot — 统一项目快照类型定义
 *
 * 这是所有 Phase 1-4 数据的唯一类型来源（Single Source of Truth）。
 * 消除了之前在 bootstrap-phases.ts、MissionBriefingBuilder.ts、
 * handler-types.ts、rescan-internal.ts 等文件中重复定义的类型。
 *
 * 设计原则：
 *   1. **不可变** — 创建后通过 Object.freeze 冻结
 *   2. **完整** — 包含 Phase 1-4 全部产出
 *   3. **类型化** — 每个字段有明确接口，不使用 `any`
 *   4. **单一定义** — 项目分析数据的唯一类型来源
 *
 * @module types/project-snapshot
 * @see docs/copilot/unified-project-snapshot-design.md
 */

// ── Phase 1: 文件发现 ────────────────────────────────────────

/** 项目级别的文件信息，来自 Phase 1 扫描 */
export interface SnapshotFile {
  name: string;
  path: string;
  relativePath: string;
  content: string;
  targetName: string;
  language?: string;
  totalLines?: number;
  priority?: string;
  truncated?: boolean;
}

/** 构建目标 (Target)，来自 Phase 1 Discoverer */
export interface SnapshotTarget {
  name: string;
  type?: string;
  framework?: string;
  packageName?: string;
  inferredRole?: string;
  fileCount?: number;
  /** 标记来自子包的 target */
  isLocalPackage?: boolean;
}

/** 本地子包模块信息 */
export interface LocalPackageModule {
  name: string;
  packageName: string;
  fileCount: number;
  inferredRole?: string;
  keyFiles?: string[];
}

// ── Phase 1.5: 语言 & AST 分析 ──────────────────────────────

/** 语言统计 */
export interface LanguageProfile {
  primaryLang: string;
  stats: Record<string, number>;
  secondary?: string[];
  isMultiLang?: boolean;
}

/** AST 分析摘要，来自 Phase 1.5 */
export interface AstSummary {
  classes?: AstClassInfo[];
  protocols?: AstProtocolInfo[];
  categories?: AstCategoryInfo[];
  fileSummaries?: AstFileSummary[];
  patternStats?: Record<string, unknown>;
  projectMetrics?: ProjectMetrics;
  fileCount?: number;
}

export interface AstClassInfo {
  name: string;
  superclass?: string;
  methodCount?: number;
  methods?: unknown[];
  protocols?: string[];
  conformedProtocols?: string[];
  file?: string;
  relativePath?: string;
  targetName?: string;
}

export interface AstProtocolInfo {
  name: string;
  file?: string;
  relativePath?: string;
  methodCount?: number;
  methods?: unknown[];
  conformers?: string[];
  targetName?: string;
}

export interface AstCategoryInfo {
  baseClass?: string;
  extendedClass?: string;
  name?: string;
  file?: string;
  relativePath?: string;
  methods?: Array<string | { name: string }>;
}

export interface AstMethodInfo {
  name: string;
  className?: string;
  isAsync?: boolean;
  complexity?: number;
  file?: string;
  line?: number;
  lines?: number;
  bodyLines?: number;
  [key: string]: unknown;
}

export interface AstFileSummary {
  exports?: unknown[];
  methods?: AstMethodInfo[];
}

export interface ProjectMetrics {
  totalMethods?: number;
  complexMethods?: AstMethodInfo[];
  longMethods?: AstMethodInfo[];
  avgMethodsPerClass?: number;
  maxNestingDepth?: number;
}

/** AST 上下文文本（用于 prompt），来自 Phase 1.5 */
export type AstContext = string | null;

// ── Phase 1.6: 代码实体图 & 调用图 ──────────────────────────

/** 代码实体图结果，来自 Phase 1.6 */
export interface CodeEntityGraphResult {
  entitiesUpserted?: number;
  edgesCreated?: number;
  entityCount?: number;
  edgeCount?: number;
}

/** 调用图结果，来自 Phase 1.7 */
export interface CallGraphResult {
  entitiesUpserted?: number;
  edgesCreated?: number;
  durationMs?: number;
}

// ── Phase 1.8: 全景分析 ─────────────────────────────────────

/** 全景分析结果，来自 Phase 1.8 */
export interface PanoramaResult {
  layers?: Array<{ level: number; name: string; modules: string[] }>;
  couplingHotspots?: Array<{ module: string; fanIn: number; fanOut: number }>;
  cyclicDependencies?: Array<{ cycle: string[]; severity: string }>;
  knowledgeGaps?: Array<{
    dimension: string;
    dimensionName: string;
    recipeCount: number;
    status: string;
    priority: string;
  }>;
  modules?: unknown;
  gaps?: unknown;
  [key: string]: unknown;
}

// ── Phase 2: 依赖关系图 ─────────────────────────────────────

/** 依赖关系图，来自 Phase 2 */
export interface DependencyGraph {
  nodes?: Array<DependencyNode | string>;
  edges?: Array<DependencyEdge>;
  [key: string]: unknown;
}

export interface DependencyNode {
  id?: string;
  label?: string;
  fileCount?: number;
}

export interface DependencyEdge {
  from: string;
  to: string;
  type?: string;
  [key: string]: unknown;
}

// ── Phase 3: Guard 审计 ──────────────────────────────────────

/** Guard 审计结果，来自 Phase 3 */
export interface GuardAudit {
  files?: GuardAuditFileEntry[];
  summary?: GuardAuditSummary;
  crossFileViolations?: GuardViolation[];
  rules?: unknown[];
  [key: string]: unknown;
}

export interface GuardAuditFileEntry {
  filePath: string;
  violations: GuardViolation[];
}

export interface GuardViolation {
  ruleId?: string;
  severity?: string;
  message?: string;
  line?: number;
  fixSuggestion?: string | null;
  locations?: Array<{ filePath: string; line?: number }>;
}

export interface GuardAuditSummary {
  totalErrors?: number;
  totalWarnings?: number;
  totalViolations?: number;
  errors?: number;
  warnings?: number;
}

// ── Phase 4: 维度 & Enhancement Pack ────────────────────────

/**
 * 维度定义 (来自统一维度注册表 DimensionRegistry)
 *
 * 兼容旧 BaseDimension 字段 + 新 UnifiedDimension 字段
 */
export interface DimensionDef {
  id: string;
  label?: string;
  guide?: string;
  knowledgeTypes?: string[];
  skillWorthy?: boolean;
  skillMeta?: { name: string; description: string } | Record<string, unknown> | null;
  dualOutput?: boolean;
  tierHint?: number;
  conditions?: { languages?: string[]; frameworks?: string[] };
  /** 层级 (统一维度注册表新增) */
  layer?: 'universal' | 'language' | 'framework';
  /** 输出模式 (统一维度注册表新增) */
  outputMode?: 'candidate-only';
}

/** Enhancement Pack 信息，来自 Phase 4 */
export interface EnhancementPackInfo {
  id: string;
  displayName: string;
  extraDimensions?: number;
  guardRules?: number;
  patterns?: Array<Record<string, unknown>>;
}

// ── 执行报告 ─────────────────────────────────────────────────

/** Phase 执行报告 */
export interface PhaseReport {
  phases: Record<string, Record<string, unknown>>;
  startTime: number;
  totalMs?: number;
  [key: string]: unknown;
}

// ── 增量扫描相关 ─────────────────────────────────────────────

/** 增量计划（rescan 场景） */
export interface IncrementalPlan {
  mode?: string;
  canIncremental?: boolean;
  affectedDimensions?: string[];
  skippedDimensions?: string[];
  reason?: string;
  diff?: {
    added: unknown[];
    modified: unknown[];
    deleted: unknown[];
    unchanged: unknown[];
    changeRatio?: number;
  };
  dimensions?: Array<{ id: string; status?: string }>;
  changedFiles?: string[];
  [key: string]: unknown;
}

/** 已有 Recipe 信息（rescan 去重 + lifecycle 感知） */
export interface ExistingRecipeInfo {
  id: string;
  title: string;
  trigger: string;
  knowledgeType: string;
  doClause?: string;
  relevanceScore?: number;
  verdict?: string;

  /** lifecycle 感知状态（Evolution Agent 填充） */
  status?: 'healthy' | 'decaying' | 'evolved' | 'deprecated';
  /** 衰退原因（仅 decaying 状态） */
  decayReason?: string;
  /** 审计分数 0-100（来自 RecipeRelevanceAuditor） */
  auditScore?: number;
}

// ── Discoverer ───────────────────────────────────────────────

/** Discoverer 摘要信息 */
export interface DiscovererInfo {
  id: string;
  displayName: string;
}

// ── Session ──────────────────────────────────────────────────

/** Minimal shape of BootstrapSession */
export interface BootstrapSessionShape {
  id: string;
  toJSON(): Record<string, unknown>;
}

// ── Mission Briefing ─────────────────────────────────────────

/** Shape of the mission briefing returned by buildMissionBriefing */
export interface MissionBriefingResult {
  meta?: {
    warnings?: string[];
    responseSizeKB?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────
//  ProjectSnapshot — 核心快照类型
// ─────────────────────────────────────────────────────────────

/**
 * ProjectSnapshot 是 runAllPhases() 的完整产出。
 *
 * 设计原则：
 * 1. **不可变** — 创建后不应被修改
 * 2. **完整** — 包含所有 Phase 1-4 的产出
 * 3. **类型化** — 每个字段有明确的接口，不使用 `any`
 * 4. **单一定义** — 这是项目分析数据的唯一类型来源
 *
 * 用法：
 * - `buildProjectSnapshot()` 从 runAllPhases() 返回值构建
 * - 4 个 handler 从 snapshot 读取数据，不再解构/重组
 * - `snapshot-views.ts` 提供面向消费者的衍生视图
 */
export interface ProjectSnapshot {
  // ─── 元数据 ───
  readonly version: string;
  readonly timestamp: number;
  readonly projectRoot: string;
  readonly sourceTag?: string;

  // ─── Phase 1: 文件发现 ───
  readonly allFiles: readonly SnapshotFile[];
  readonly allTargets: readonly SnapshotTarget[];
  readonly discoverer: DiscovererInfo;
  readonly truncated: boolean;

  // ─── Phase 1.5: 语言 & AST 分析 ───
  readonly language: LanguageProfile;
  readonly ast: AstSummary | null;
  readonly astContext: AstContext;

  // ─── Phase 1.6-1.7: 代码实体图 & 调用图 ───
  readonly codeEntityGraph: CodeEntityGraphResult | null;
  readonly callGraph: CallGraphResult | null;

  // ─── Phase 1.8: 全景分析 ───
  readonly panorama: PanoramaResult | null;

  // ─── Phase 2: 依赖关系图 ───
  readonly dependencyGraph: DependencyGraph | null;
  readonly depEdgesWritten: number;

  // ─── Phase 3: Guard 审计 ───
  readonly guardAudit: GuardAudit | null;

  // ─── Phase 4: Enhancement Pack & 维度 ───
  readonly activeDimensions: readonly DimensionDef[];
  readonly enhancementPackInfo: readonly EnhancementPackInfo[];
  readonly enhancementPatterns: readonly Record<string, unknown>[];
  readonly enhancementGuardRules: readonly unknown[];
  readonly detectedFrameworks: readonly string[];

  // ─── 语言画像 & Targets 摘要 ───
  readonly langProfile: LanguageProfile;
  readonly targetsSummary: readonly SnapshotTarget[];
  readonly localPackageModules: readonly LocalPackageModule[];

  // ─── 执行报告 ───
  readonly phaseReport: PhaseReport | null;
  readonly warnings: readonly string[];

  // ─── 增量扫描上下文 ───
  readonly incrementalPlan: IncrementalPlan | null;

  // ─── 空项目标记 ───
  readonly isEmpty: boolean;
}

/**
 * 构建快照的输入参数
 * 从 runAllPhases() 的松散返回值到类型化快照的桥梁
 */
export interface ProjectSnapshotInput {
  projectRoot: string;
  sourceTag?: string;
  // Phase 1
  allFiles: unknown[];
  allTargets: unknown[];
  discoverer: { id: string; displayName: string; [key: string]: unknown };
  langStats: Record<string, number>;
  truncated?: boolean;
  // Phase 1.5
  primaryLang: string | null;
  langProfile?: { secondary?: string[]; isMultiLang?: boolean; [key: string]: unknown };
  astProjectSummary: unknown;
  astContext: unknown;
  // Phase 1.6-1.7
  codeEntityResult: unknown;
  callGraphResult: unknown;
  // Phase 1.8
  panoramaResult: unknown;
  // Phase 2
  depGraphData: unknown;
  depEdgesWritten?: number;
  // Phase 3
  guardAudit: unknown;
  // Phase 4
  activeDimensions: unknown[];
  enhancementPackInfo?: unknown[];
  enhancementPatterns?: unknown[];
  enhancementGuardRules?: unknown[];
  detectedFrameworks?: string[];
  // Targets
  targetsSummary?: unknown[];
  localPackageModules?: unknown[];
  // Report
  report?: unknown;
  warnings?: string[];
  // Incremental
  incrementalPlan?: unknown;
  // Empty flag
  isEmpty?: boolean;
}
