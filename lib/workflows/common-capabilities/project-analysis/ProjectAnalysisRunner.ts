/**
 * bootstrap-phases.js — 共享的 Phase 1-4 数据收集管线
 *
 * 内部 Agent (bootstrap-internal.js) 和外部 Agent (bootstrap-external.js)
 * 共享完全相同的项目分析逻辑。本模块将这些逻辑提取为可复用函数，
 * 消除约 300 行重复代码。
 *
 * Phase 概览:
 *   Phase 1   → 文件收集（DiscovererRegistry → 多语言项目类型检测）
 *   Phase 1.5 → AST 代码结构分析（tree-sitter + SFC 预处理）
 *   Phase 1.6 → Code Entity Graph（代码实体关系图谱）
 *   Phase 2.2 → Panorama 全景汇总（RoleRefiner + CouplingAnalyzer + LayerInferrer）
 *   Phase 2   → 依赖关系 → knowledge_edges
 *   Phase 2.1 → Module 实体写入 Entity Graph
 *   Phase 3   → Guard 规则审计
 *   Phase 4   → 维度条件化过滤 + Enhancement Pack + 语言画像
 *
 * @module bootstrap/shared/bootstrap-phases
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ProjectAnalysisResult } from '#core/AstAnalyzer.js';
import {
  analyzeProject,
  isAvailable as astIsAvailable,
  generateContextForAgent,
} from '#core/AstAnalyzer.js';
import type { CallGraphResult as CallGraphAnalysisResult } from '#core/analysis/CallGraphAnalyzer.js';
import { DimensionCopy } from '#domain/dimension/DimensionCopy.js';
import { LanguageService } from '#shared/LanguageService.js';
import type { GuardAudit } from '#types/project-snapshot.js';
import type { IncrementalPlan } from '#types/workflows.js';
import {
  type BaseDimension,
  baseDimensions,
  resolveActiveDimensions,
} from '#workflows/common-capabilities/dimension-planning/BaseDimensions.js';
import { detectPrimaryLanguage } from '#workflows/common-capabilities/presentation/LanguageExtensionBuilder.js';
import { evaluateProjectAnalysisIncrementalPlan } from '#workflows/common-capabilities/project-analysis/ProjectAnalysisIncrementalPlanner.js';
import {
  buildProjectAnalysisLocalPackageModules,
  buildProjectAnalysisTargetsSummary,
} from '#workflows/common-capabilities/project-analysis/ProjectAnalysisResultProjection.js';

// ── TypeScript Interfaces ────────────────────────────────────

/** Logger with required info/warn (compatible with Logger singleton) */
interface PhaseLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error?(...args: unknown[]): void;
  debug?(...args: unknown[]): void;
}

/** Minimal DI container shape (extends McpServiceContainer pattern) */
interface PhaseContainer {
  // biome-ignore lint/suspicious/noExplicitAny: DI container services are resolved by string token.
  get(name: string): any;
  // biome-ignore lint/suspicious/noExplicitAny: legacy MCP contexts attach dynamic services.
  [key: string]: any;
}

/** Single file entry collected during Phase 1 */
interface BootstrapFileEntry {
  name: string;
  path: string;
  relativePath: string;
  content: string;
  targetName: string;
  /** Whether this file belongs to a test target or matches test file naming patterns */
  isTest: boolean;
}

/** Target item — either a plain string or an object with metadata */
type TargetItem =
  | string
  | {
      name: string;
      framework?: string;
      type?: string;
      packageName?: string;
      [key: string]: unknown;
    };

/** Dependency graph data shape */
interface DepGraphData {
  nodes?: Array<Record<string, unknown>>;
  edges?: Array<{ from: string; to: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

type AstProjectSummaryLike = ProjectAnalysisResult;
type GuardAuditLike = GuardAudit;

/** Minimal guard engine shape */
interface GuardEngineLike {
  auditFiles(
    files: Array<{ path: string; content: string }>,
    opts?: Record<string, unknown>
  ): GuardAuditLike;
  injectExternalRules(rules: unknown[]): void;
  getExternalRuleCount(): number;
  [key: string]: unknown;
}

/** Minimal discoverer shape */
interface DiscovererLike {
  id: string;
  displayName: string;
  load(root: string): Promise<void>;
  listTargets(): Promise<TargetItem[]>;
  getTargetFiles(
    target: unknown
  ): Promise<Array<string | { path: string; name?: string; relativePath?: string }>>;
  getDependencyGraph(): Promise<DepGraphData>;
  [key: string]: unknown;
}

/** Phase 4 dimension resolve params */
interface Phase4Params {
  primaryLang: string;
  langStats: Record<string, number>;
  allTargets: TargetItem[];
  astProjectSummary: AstProjectSummaryLike | null;
  guardEngine: GuardEngineLike | null;
  allFiles: BootstrapFileEntry[];
  logger: PhaseLogger;
}

/** Phase 1 options */
interface Phase1Options {
  maxFiles?: number;
  [key: string]: unknown;
}

/** Phase 1.5 AST analysis options */
interface AstAnalysisOptions {
  generateAstContext?: boolean;
  [key: string]: unknown;
}

/** Phase 1.7 incremental call graph options */
interface IncrementalCallGraphOpts {
  changedFiles?: string[];
  materialize?: boolean;
  [key: string]: unknown;
}

interface CallGraphAnalysisOptions {
  changedFiles?: string[];
  [key: string]: unknown;
}

interface CallGraphMaterializationResult {
  entitiesUpserted: number;
  edgesCreated: number;
  durationMs: number;
}

interface CodeEntityGraphCallGraphLike {
  clearCallGraphForFiles(filePaths: string[] | null): Promise<unknown>;
  populateCallGraph(
    callEdges: CallGraphAnalysisResult['callEdges'],
    dataFlowEdges: CallGraphAnalysisResult['dataFlowEdges']
  ): Promise<CallGraphMaterializationResult>;
}

type CodeEntityGraphCallGraphConstructor = new (
  entityRepo: unknown,
  edgeRepo: unknown,
  options: { projectRoot: string }
) => CodeEntityGraphCallGraphLike;

/** Phase 3 Guard audit options */
interface GuardAuditOptions {
  skipGuard?: boolean;
  summaryPrefix?: string;
  writeViolations?: boolean;
  [key: string]: unknown;
}

/** runAllPhases context — callers pass McpContext variants with different shapes */
interface AllPhasesContext {
  container: PhaseContainer;
  logger: PhaseLogger;
  // biome-ignore lint/suspicious/noExplicitAny: workflow callers pass dynamic MCP context shapes.
  [key: string]: any;
}

/** runAllPhases options */
interface AllPhasesOptions {
  incremental?: boolean;
  generateReport?: boolean;
  clearOldData?: boolean;
  generateAstContext?: boolean;
  materialize?: ProjectAnalysisMaterializationInput;
  maxFiles?: number;
  skipGuard?: boolean;
  sourceTag?: string;
  summaryPrefix?: string;
  dataRoot?: string;
  [key: string]: unknown;
}

/** Phase report structure */
export interface PhaseReport {
  phases: Record<string, Record<string, unknown>>;
  startTime: number;
  totalMs?: number;
  [key: string]: unknown;
}

export interface ProjectAnalysisMaterializationOptions {
  codeEntityGraph: boolean;
  callGraph: boolean;
  dependencyEdges: boolean;
  moduleEntities: boolean;
  guardViolations: boolean;
  panorama: boolean;
}

export type ProjectAnalysisMaterializationInput =
  | boolean
  | Partial<ProjectAnalysisMaterializationOptions>;

export const DEFAULT_PROJECT_ANALYSIS_MATERIALIZATION: ProjectAnalysisMaterializationOptions = {
  codeEntityGraph: true,
  callGraph: true,
  dependencyEdges: true,
  moduleEntities: true,
  guardViolations: true,
  panorama: true,
};

export function resolveProjectAnalysisMaterialization(
  input: ProjectAnalysisMaterializationInput | undefined
): ProjectAnalysisMaterializationOptions {
  if (input === false) {
    return {
      codeEntityGraph: false,
      callGraph: false,
      dependencyEdges: false,
      moduleEntities: false,
      guardViolations: false,
      panorama: false,
    };
  }

  if (input === true || input === undefined) {
    return { ...DEFAULT_PROJECT_ANALYSIS_MATERIALIZATION };
  }

  return { ...DEFAULT_PROJECT_ANALYSIS_MATERIALIZATION, ...input };
}

// ── 类型定义 ────────────────────────────────────────────────

// ── R13: Alembic 生成物黑名单 ─────────────────────────

const ALEMBIC_GENERATED_BASENAMES = new Set(['AGENTS.md', 'CLAUDE.md', 'copilot-instructions.md']);
const ALEMBIC_GENERATED_PATH_SEGMENTS = [
  `${path.sep}.cursor${path.sep}`, // .cursor/rules/*.mdc
  `${path.sep}.github${path.sep}copilot-instructions.md`,
];

/** 判断文件是否为 Alembic 生成物（用于排除自引用循环知识） */
export function isAlembicGenerated(filePath: string) {
  const base = path.basename(filePath);
  if (ALEMBIC_GENERATED_BASENAMES.has(base)) {
    return true;
  }
  for (const seg of ALEMBIC_GENERATED_PATH_SEGMENTS) {
    if (filePath.includes(seg)) {
      return true;
    }
  }
  if (base.endsWith('.mdc')) {
    return true;
  }
  return false;
}

// ── Phase 1: 文件收集 ──────────────────────────────────────

/**
 * Phase 1: 通过 DiscovererRegistry 检测项目类型并收集源文件
 *
 * @param projectRoot 项目根目录
 * @returns >}
 */
export async function runPhase1_FileCollection(
  projectRoot: string,
  logger: PhaseLogger,
  options: Phase1Options = {}
) {
  const maxFiles = options.maxFiles || 500;

  const { getDiscovererRegistry } = await import('#core/discovery/index.js');
  const registry = getDiscovererRegistry();
  const discoverer = await registry.detect(projectRoot);
  logger.info(`[Bootstrap] Project type: ${discoverer.displayName} (${discoverer.id})`);

  await discoverer.load(projectRoot);
  const allTargets = await discoverer.listTargets();

  const seenPaths = new Set<string>();
  const allFiles: BootstrapFileEntry[] = [];
  for (const t of allTargets) {
    const isTestTarget = typeof t === 'object' && /^test/i.test(t.type || '');
    try {
      const fileList = await discoverer.getTargetFiles(t);
      for (const f of fileList) {
        const fp = typeof f === 'string' ? f : f.path;
        if (seenPaths.has(fp)) {
          continue;
        }
        if (isAlembicGenerated(fp)) {
          continue; // R13: skip generated files
        }
        seenPaths.add(fp);
        try {
          const content = fs.readFileSync(fp, 'utf8');
          allFiles.push({
            name: f.name || path.basename(fp),
            path: fp,
            relativePath: f.relativePath || path.basename(fp),
            content,
            targetName: typeof t === 'string' ? t : t.name,
            isTest: isTestTarget || LanguageService.isTestFile(fp),
          });
        } catch {
          /* skip unreadable */
        }
        if (allFiles.length >= maxFiles) {
          break;
        }
      }
    } catch {
      /* skip target */
    }
    if (allFiles.length >= maxFiles) {
      break;
    }
  }

  // 文件截断警告：当达到 maxFiles 上限时，通知调用方分析可能不完整
  const truncated = seenPaths.size > allFiles.length || allFiles.length >= maxFiles;
  if (truncated) {
    logger.warn(
      `[Bootstrap] File collection truncated at ${maxFiles} files (total discovered: ${seenPaths.size}). ` +
        `Analysis may be incomplete — consider increasing maxFiles or narrowing target scope.`
    );
  }

  // 语言统计
  const langStats: Record<string, number> = {};
  for (const f of allFiles) {
    const ext = path.extname(f.name).replace('.', '') || 'unknown';
    langStats[ext] = (langStats[ext] || 0) + 1;
  }

  return {
    allFiles,
    allTargets: allTargets as unknown as TargetItem[],
    discoverer: discoverer as unknown as DiscovererLike,
    langStats,
    truncated,
  };
}

// ── Phase 1.5: AST 代码结构分析 ────────────────────────────

/**
 * Phase 1.5: tree-sitter AST 分析
 *   - 1.5a: 按需安装缺失的语法包
 *   - 1.5b: 执行 AST 分析 + SFC 预处理
 *
 * @param allFiles Phase 1 收集的文件
 * @param langStats 语言统计
 * @param [options.generateAstContext=false] 是否生成 astContext 文本
 * @returns >}
 */
export async function runPhase1_5_AstAnalysis(
  allFiles: BootstrapFileEntry[],
  langStats: Record<string, number>,
  logger: PhaseLogger,
  options: AstAnalysisOptions = {}
) {
  const warnings: string[] = [];
  let astProjectSummary: AstProjectSummaryLike | null = null;
  let astContext = '';

  // Phase 1.5a: 按需安装缺失的 tree-sitter 语法包
  try {
    const { ensureGrammars, inferLanguagesFromStats, reloadPlugins } = await import(
      '#core/ast/ensure-grammars.js'
    );
    const neededLangs = inferLanguagesFromStats(langStats);
    if (neededLangs.length > 0) {
      const result = await ensureGrammars(neededLangs, { logger });
      if (result.installed.length > 0) {
        logger.info(`[Bootstrap] Installed grammars: ${result.installed.join(', ')}`);
        await reloadPlugins();
      }
    }
    await import('#core/ast/index.js');
  } catch (e: unknown) {
    logger.warn(
      `[Bootstrap] Grammar auto-install skipped: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // Phase 1.5b: AST 分析
  const primaryLangEarly = detectPrimaryLanguage(langStats);
  if (astIsAvailable() && primaryLangEarly) {
    try {
      const astFiles = allFiles.map((f: BootstrapFileEntry) => ({
        name: f.name,
        relativePath: f.relativePath,
        content: f.content,
      }));

      // SFC 预处理 (.vue / .svelte)
      type AstPreprocessFn = (
        content: string,
        ext: string
      ) => { content: string; lang?: string } | null;
      let sfcPreprocessor: AstPreprocessFn | undefined;
      try {
        const { initEnhancementRegistry } = await import('#core/enhancement/index.js');
        const enhReg = await initEnhancementRegistry();
        const preprocessPack = enhReg
          .all()
          .find(
            (p) => typeof (p as unknown as Record<string, unknown>).preprocessFile === 'function'
          );
        if (preprocessPack) {
          sfcPreprocessor = (
            preprocessPack as unknown as { preprocessFile: (...args: unknown[]) => unknown }
          ).preprocessFile.bind(preprocessPack) as AstPreprocessFn;
        }
      } catch {
        /* Enhancement 未加载 */
      }

      astProjectSummary = analyzeProject(astFiles, primaryLangEarly, {
        preprocessFile: sfcPreprocessor,
      });

      // 内部 Agent 专用: 生成 astContext 文本
      if (options.generateAstContext) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- astProjectSummary flows from analyzeProject return
        astContext = generateContextForAgent(
          astProjectSummary as Parameters<typeof generateContextForAgent>[0]
        );
      }

      logger.info(
        `[Bootstrap] AST: ${astProjectSummary.classes.length} classes, ` +
          `${astProjectSummary.protocols.length} protocols` +
          (astProjectSummary.categories
            ? `, ${astProjectSummary.categories.length} categories`
            : '') +
          (astProjectSummary.patternStats
            ? `, ${Object.keys(astProjectSummary.patternStats).length} patterns`
            : '')
      );
    } catch (e: unknown) {
      logger.warn(
        `[Bootstrap] AST analysis failed (degraded): ${e instanceof Error ? e.message : String(e)}`
      );
      warnings.push(`AST analysis partially failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    logger.info(
      `[Bootstrap] AST skipped: tree-sitter ${astIsAvailable() ? 'available' : 'not available'}, lang=${primaryLangEarly}`
    );
  }

  return { astProjectSummary, astContext, warnings };
}

// ── Phase 1.6: Code Entity Graph ───────────────────────────

export interface ProjectEntityGraphInput {
  astProjectSummary: AstProjectSummaryLike;
  projectRoot: string;
}

export interface EntityGraphMaterializationOptions {
  materialize?: boolean;
}

export function buildEntityGraphInput(
  astProjectSummary: AstProjectSummaryLike | null,
  projectRoot: string
): ProjectEntityGraphInput | null {
  if (!astProjectSummary) {
    return null;
  }

  return { astProjectSummary, projectRoot };
}

export async function materializeEntityGraph(
  input: ProjectEntityGraphInput,
  container: PhaseContainer,
  logger: PhaseLogger
) {
  const warnings: string[] = [];
  let codeEntityResult: {
    entitiesUpserted: number;
    edgesCreated: number;
    durationMs: number;
  } | null = null;

  try {
    const { CodeEntityGraph } = await import('#service/knowledge/CodeEntityGraph.js');
    const entityRepo = container.get('codeEntityRepository');
    const edgeRepo = container.get('knowledgeEdgeRepository');
    if (entityRepo && edgeRepo) {
      const ceg = new CodeEntityGraph(entityRepo, edgeRepo, { projectRoot: input.projectRoot });
      await ceg.clearProject();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- ProjectAnalysisResult structurally compatible at runtime
      const result = await ceg.populateFromAst(
        input.astProjectSummary as Parameters<typeof ceg.populateFromAst>[0]
      );
      codeEntityResult = result;
      logger.info(
        `[Bootstrap] Entity Graph: ${result.entitiesUpserted} entities, ${result.edgesCreated} edges`
      );
    }
  } catch (e: unknown) {
    logger.warn(
      `[Bootstrap] Entity Graph failed (degraded): ${e instanceof Error ? e.message : String(e)}`
    );
    warnings.push(`Entity Graph failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { codeEntityResult, warnings };
}

/**
 * Phase 1.6: 从 AST 结果构建代码实体关系图谱
 *
 * @param astProjectSummary AST 分析结果
 * @param container ServiceContainer
 * @returns >}
 */
export async function runPhase1_6_EntityGraph(
  astProjectSummary: AstProjectSummaryLike | null,
  projectRoot: string,
  container: PhaseContainer,
  logger: PhaseLogger,
  options: EntityGraphMaterializationOptions = {}
) {
  const warnings: string[] = [];
  const codeEntityResult: {
    entitiesUpserted: number;
    edgesCreated: number;
    durationMs: number;
  } | null = null;

  const input = buildEntityGraphInput(astProjectSummary, projectRoot);
  if (!input || options.materialize === false) {
    return { codeEntityResult, warnings };
  }

  return materializeEntityGraph(input, container, logger);
}

// ── Phase 2: 依赖关系 ──────────────────────────────────────

/**
 * Phase 1.7: 跨文件调用图分析 (Phase 5)
 *
 * 从 AST 的 callSites 构建全局调用图并写入 CodeEntityGraph。
 *
 * @param astProjectSummary AST 分析结果 (含 fileSummaries[].callSites)
 * @param container ServiceContainer
 * @param [incrementalOpts] 增量分析选项
 * @param [incrementalOpts.changedFiles] 变更文件的相对路径
 * @returns >}
 */
export async function runPhase1_7_CallGraph(
  astProjectSummary: AstProjectSummaryLike | null,
  projectRoot: string,
  container: PhaseContainer,
  logger: PhaseLogger,
  incrementalOpts: IncrementalCallGraphOpts | null = null
) {
  const warnings: string[] = [];
  let callGraphResult: CallGraphMaterializationResult | null = null;

  const analysis = await analyzeProjectCallGraph(astProjectSummary, projectRoot, logger, {
    changedFiles: incrementalOpts?.changedFiles,
  });
  warnings.push(...analysis.warnings);

  if (!analysis.callGraphAnalysis || incrementalOpts?.materialize === false) {
    if (analysis.callGraphAnalysis && incrementalOpts?.materialize === false) {
      logger.info('[Bootstrap] Call Graph materialization skipped by workflow plan');
    }
    return { callGraphResult, callGraphAnalysis: analysis.callGraphAnalysis, warnings };
  }

  const materialized = await materializeCallGraph({
    callGraphAnalysis: analysis.callGraphAnalysis,
    projectRoot,
    container,
    logger,
    changedFiles: incrementalOpts?.changedFiles,
  });
  callGraphResult = materialized.callGraphResult;
  warnings.push(...materialized.warnings);

  return { callGraphResult, callGraphAnalysis: analysis.callGraphAnalysis, warnings };
}

export async function analyzeProjectCallGraph(
  astProjectSummary: AstProjectSummaryLike | null,
  projectRoot: string,
  logger: PhaseLogger,
  options: CallGraphAnalysisOptions = {}
) {
  const warnings: string[] = [];
  let callGraphAnalysis: CallGraphAnalysisResult | null = null;

  if (!astProjectSummary?.fileSummaries?.length) {
    return { callGraphAnalysis, warnings };
  }

  // 检查是否有 callSites 数据 (Phase 5 提取)
  const hasCallSites = astProjectSummary.fileSummaries.some(
    (f) => f.callSites && f.callSites.length > 0
  );
  if (!hasCallSites) {
    logger.info('[Bootstrap] Call Graph skipped: no call sites extracted');
    return { callGraphAnalysis, warnings };
  }

  try {
    const { CallGraphAnalyzer } = await import('#core/analysis/CallGraphAnalyzer.js');

    const analyzer = new CallGraphAnalyzer(projectRoot);
    const changedFiles = options.changedFiles;
    const isIncremental =
      changedFiles !== undefined && changedFiles.length > 0 && changedFiles.length <= 10;

    // Phase 5 分析 (带超时保护 + 渐进式 partial result)
    const result = isIncremental
      ? // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- ProjectAnalysisResult structurally compatible with AstProjectSummary
        await analyzer.analyzeIncremental(
          astProjectSummary as unknown as Parameters<typeof analyzer.analyzeIncremental>[0],
          changedFiles,
          {
            timeout: 15_000,
            maxCallSitesPerFile: 500,
            minConfidence: 0.5,
          }
        )
      : // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- ProjectAnalysisResult structurally compatible with AstProjectSummary
        await analyzer.analyze(
          astProjectSummary as unknown as Parameters<typeof analyzer.analyze>[0],
          {
            timeout: 15_000,
            maxCallSitesPerFile: 500,
            minConfidence: 0.5,
          }
        );

    callGraphAnalysis = result;

    const partialTag = result.stats.partial ? ' [partial]' : '';
    const incrTag = isIncremental ? ' [incremental]' : '';
    logger.info(
      `[Bootstrap] Call Graph analysis${incrTag}${partialTag}: ${result.callEdges.length} call edges, ` +
        `${result.dataFlowEdges.length} data flow edges, ` +
        `resolution rate: ${(result.stats.resolvedRate * 100).toFixed(1)}%`
    );
  } catch (e: unknown) {
    logger.warn(
      `[Bootstrap] Call Graph failed (degraded): ${e instanceof Error ? e.message : String(e)}`
    );
    warnings.push(`Call Graph failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { callGraphAnalysis, warnings };
}

export async function materializeCallGraph({
  callGraphAnalysis,
  projectRoot,
  container,
  logger,
  changedFiles,
  getCodeEntityGraphClass = defaultGetCodeEntityGraphClass,
}: {
  callGraphAnalysis: CallGraphAnalysisResult | null;
  projectRoot: string;
  container: PhaseContainer;
  logger: PhaseLogger;
  changedFiles?: string[];
  getCodeEntityGraphClass?: () => Promise<CodeEntityGraphCallGraphConstructor>;
}) {
  const warnings: string[] = [];
  let callGraphResult: CallGraphMaterializationResult | null = null;

  if (!callGraphAnalysis) {
    return { callGraphResult, warnings };
  }

  if (callGraphAnalysis.callEdges.length === 0 && callGraphAnalysis.dataFlowEdges.length === 0) {
    logger.info(
      `[Bootstrap] Call Graph: ${callGraphAnalysis.stats.totalCallSites} call sites, 0 resolved edges`
    );
    return { callGraphResult, warnings };
  }

  try {
    const CodeEntityGraph = await getCodeEntityGraphClass();
    const entityRepo = container.get('codeEntityRepository');
    const edgeRepo = container.get('knowledgeEdgeRepository');
    if (entityRepo && edgeRepo) {
      const ceg = new CodeEntityGraph(entityRepo, edgeRepo, { projectRoot });

      // 增量模式: 先删除变更文件的旧边
      if (callGraphAnalysis.stats.incremental === true) {
        await ceg.clearCallGraphForFiles(changedFiles ?? null);
      }

      callGraphResult = await ceg.populateCallGraph(
        callGraphAnalysis.callEdges,
        callGraphAnalysis.dataFlowEdges
      );

      logger.info(
        `[Bootstrap] Call Graph materialized: ${callGraphResult.entitiesUpserted} method entities, ${callGraphResult.edgesCreated} graph edges`
      );
    }
  } catch (e: unknown) {
    logger.warn(
      `[Bootstrap] Call Graph materialization failed (degraded): ${e instanceof Error ? e.message : String(e)}`
    );
    warnings.push(
      `Call Graph materialization failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  return { callGraphResult, warnings };
}

async function defaultGetCodeEntityGraphClass() {
  const { CodeEntityGraph } = await import('#service/knowledge/CodeEntityGraph.js');
  return CodeEntityGraph as unknown as CodeEntityGraphCallGraphConstructor;
}

// ── Phase 2: 依赖关系 ──────────────────────────────────────

export interface DependencyEdgeMaterializationOptions {
  materializeEdges?: boolean;
}

export async function collectDependencyGraph(discoverer: DiscovererLike, logger: PhaseLogger) {
  const warnings: string[] = [];
  let depGraphData: DepGraphData | null = null;

  try {
    depGraphData = await discoverer.getDependencyGraph();
  } catch (e: unknown) {
    logger.warn(`[Bootstrap] DepGraph failed: ${e instanceof Error ? e.message : String(e)}`);
    warnings.push(`Dependency graph failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { depGraphData, warnings };
}

export async function writeDependencyEdges({
  depGraphData,
  discoverer,
  container,
  logger,
  sourceTag,
}: {
  depGraphData: DepGraphData | null;
  discoverer: DiscovererLike;
  container: PhaseContainer;
  logger: PhaseLogger;
  sourceTag: string;
}) {
  const warnings: string[] = [];
  let depEdgesWritten = 0;

  if (!depGraphData) {
    return { depEdgesWritten, warnings };
  }

  try {
    const knowledgeGraphService = container.get('knowledgeGraphService');
    if (knowledgeGraphService) {
      for (const edge of depGraphData.edges || []) {
        const result = await knowledgeGraphService.addEdge(
          edge.from,
          'module',
          edge.to,
          'module',
          'depends_on',
          { weight: 1.0, source: `${discoverer.id}-${sourceTag}` }
        );
        if (result?.success) {
          depEdgesWritten++;
        }
      }
    }
  } catch (e: unknown) {
    logger.warn(
      `[Bootstrap] DepGraph edge write failed: ${e instanceof Error ? e.message : String(e)}`
    );
    warnings.push(`Dependency edge write failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { depEdgesWritten, warnings };
}

/**
 * Phase 2: 获取依赖图并写入 knowledge_edges
 *
 * @param discoverer DiscovererRegistry 检测到的 discoverer
 * @param container ServiceContainer
 * @param [sourceTag='bootstrap'] edge 的 source 标签后缀
 * @returns >}
 */
export async function runPhase2_DependencyGraph(
  discoverer: DiscovererLike,
  container: PhaseContainer,
  logger: PhaseLogger,
  sourceTag = 'bootstrap',
  options: DependencyEdgeMaterializationOptions = {}
) {
  const warnings: string[] = [];
  let depEdgesWritten = 0;

  const collected = await collectDependencyGraph(discoverer, logger);
  warnings.push(...collected.warnings);

  if (options.materializeEdges !== false) {
    const written = await writeDependencyEdges({
      depGraphData: collected.depGraphData,
      discoverer,
      container,
      logger,
      sourceTag,
    });
    depEdgesWritten = written.depEdgesWritten;
    warnings.push(...written.warnings);
  }

  return { depGraphData: collected.depGraphData, depEdgesWritten, warnings };
}

// ── Phase 2.1: Module 实体写入 ─────────────────────────────

export interface ModuleEntityMaterializationOptions {
  materialize?: boolean;
}

/**
 * Phase 2.1: 将依赖图的 module 节点写入 Code Entity Graph
 *
 * @param depGraphData 依赖图数据
 */
export async function materializeModuleEntities(
  depGraphData: DepGraphData | null,
  projectRoot: string,
  container: PhaseContainer,
  logger: PhaseLogger
) {
  if (!depGraphData?.nodes?.length) {
    return;
  }

  try {
    const { CodeEntityGraph } = await import('#service/knowledge/CodeEntityGraph.js');
    const entityRepo = container.get('codeEntityRepository');
    const edgeRepo = container.get('knowledgeEdgeRepository');
    if (entityRepo && edgeRepo) {
      const ceg = new CodeEntityGraph(entityRepo, edgeRepo, { projectRoot });
      const result = await ceg.populateFromSpm(depGraphData);
      logger.info(`[Bootstrap] Entity Graph modules: ${result.entitiesUpserted} entities`);
    }
  } catch (e: unknown) {
    logger.warn(
      `[Bootstrap] Entity Graph modules failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

export async function runPhase2_1_ModuleEntities(
  depGraphData: DepGraphData | null,
  projectRoot: string,
  container: PhaseContainer,
  logger: PhaseLogger,
  options: ModuleEntityMaterializationOptions = {}
) {
  if (options.materialize === false) {
    return;
  }

  await materializeModuleEntities(depGraphData, projectRoot, container, logger);
}

// ── Phase 3: Guard 审计 ────────────────────────────────────

/**
 * Phase 3: Guard 规则审计
 *
 * @param allFiles Phase 1 收集的文件
 * @param [options.summaryPrefix='Bootstrap scan'] - ViolationsStore 摘要前缀
 * @returns >}
 */
export async function runGuardAudit(
  allFiles: BootstrapFileEntry[],
  container: PhaseContainer,
  logger: PhaseLogger
) {
  const warnings: string[] = [];
  let guardAudit: GuardAuditLike | null = null;
  let guardEngine: GuardEngineLike | null = null;

  try {
    const { GuardCheckEngine } = await import('#service/guard/GuardCheckEngine.js');
    const db = container.get('database');
    const engine = new GuardCheckEngine(db) as unknown as GuardEngineLike;
    guardEngine = engine;
    const guardFiles = allFiles.map((f: BootstrapFileEntry) => ({
      path: f.path,
      content: f.content,
      isTest: f.isTest,
    }));
    guardAudit = engine.auditFiles(guardFiles, { scope: 'project' });
  } catch (e: unknown) {
    logger.warn(`[Bootstrap] Guard audit failed: ${e instanceof Error ? e.message : String(e)}`);
    warnings.push(`Guard audit failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { guardAudit, guardEngine, warnings };
}

export function writeGuardViolations({
  guardAudit,
  container,
  summaryPrefix,
}: {
  guardAudit: GuardAuditLike | null;
  container: PhaseContainer;
  summaryPrefix?: string;
}) {
  if (!guardAudit) {
    return;
  }

  try {
    const violationsStore = container.get('violationsStore');
    const prefix = summaryPrefix || 'Bootstrap scan';
    for (const fileResult of guardAudit.files || []) {
      if (fileResult.violations.length > 0) {
        const fileSummary = (fileResult as unknown as Record<string, unknown>).summary as
          | { errors: number; warnings: number }
          | undefined;
        violationsStore.appendRun({
          filePath: fileResult.filePath,
          violations: fileResult.violations,
          summary: `${prefix}: ${fileSummary?.errors ?? 0}E ${fileSummary?.warnings ?? 0}W`,
        });
      }
    }
  } catch {
    /* ViolationsStore not available */
  }
}

export async function runPhase3_GuardAudit(
  allFiles: BootstrapFileEntry[],
  container: PhaseContainer,
  logger: PhaseLogger,
  options: GuardAuditOptions = {}
) {
  if (options.skipGuard) {
    return { guardAudit: null, guardEngine: null, warnings: [] };
  }

  const audit = await runGuardAudit(allFiles, container, logger);
  if (options.writeViolations !== false) {
    writeGuardViolations({
      guardAudit: audit.guardAudit,
      container,
      summaryPrefix: options.summaryPrefix,
    });
  }

  return audit;
}

// ── Phase 4: 维度解析 + Enhancement Pack ───────────────────

/**
 * Phase 4: 维度条件化过滤 + Enhancement Pack 动态追加 + 语言画像 + Skill 增强
 *
 * @param params.astProjectSummary AST 结果（供 Enhancement Pack 模式检测）
 * @param params.guardEngine Guard 引擎（供 Enhancement Pack 规则注入）
 * @param params.allFiles 文件列表（供 Guard 二次审计）
 * @returns {Promise<{
 *   activeDimensions: Array,
 *   enhancementPackInfo: Array,
 *   enhancementPatterns: Array,
 *   enhancementGuardRules: Array,
 *   langProfile: object,
 *   detectedFrameworks: string[],
 *   guardAudit: object|null
 * }>}
 */
export async function runPhase4_DimensionResolve(params: Phase4Params) {
  const { primaryLang, langStats, allTargets, astProjectSummary, guardEngine, allFiles, logger } =
    params;

  // 框架检测
  const detectedFrameworks = allTargets
    .map((t: TargetItem) => (typeof t === 'object' ? t.framework : null))
    .filter(Boolean) as string[];

  // 条件维度过滤
  const activeDimensions = resolveActiveDimensions(baseDimensions, primaryLang, detectedFrameworks);

  // Enhancement Pack 动态追加
  const enhancementPackInfo: { id: string; displayName: string }[] = [];
  const enhancementGuardRules: unknown[] = [];
  const enhancementPatterns: Array<Record<string, unknown>> = [];
  let guardAudit: GuardAuditLike | null = null;

  try {
    const { initEnhancementRegistry } = await import('#core/enhancement/index.js');
    const enhReg = await initEnhancementRegistry();
    const matchedPacks = enhReg.resolve(primaryLang, detectedFrameworks);

    for (const pack of matchedPacks) {
      enhancementPackInfo.push({ id: pack.id, displayName: pack.displayName });

      // 追加额外维度
      for (const dim of pack.getExtraDimensions()) {
        if (!activeDimensions.some((d: BaseDimension) => d.id === dim.id)) {
          activeDimensions.push(dim);
        }
      }

      // 收集 Guard 规则
      const guardRules = pack.getGuardRules();
      if (guardRules.length > 0) {
        enhancementGuardRules.push(...guardRules);
      }

      // AST 模式检测
      if (astProjectSummary) {
        try {
          const patterns = pack.detectPatterns(astProjectSummary);
          if (patterns.length > 0) {
            enhancementPatterns.push(
              ...patterns.map((p: Record<string, unknown>) => ({ ...p, source: pack.id }))
            );
          }
        } catch {
          /* graceful degradation */
        }
      }
    }

    if (matchedPacks.length > 0) {
      logger.info(
        `[Bootstrap] Enhancement packs: ${matchedPacks.map((p) => p.id).join(', ')} → ` +
          `+${activeDimensions.length - baseDimensions.length} dims, ${enhancementGuardRules.length} guard rules, ${enhancementPatterns.length} patterns`
      );
    }
  } catch (enhErr: unknown) {
    logger.warn(
      `[Bootstrap] Enhancement packs skipped: ${enhErr instanceof Error ? enhErr.message : String(enhErr)}`
    );
  }

  // Enhancement Pack Guard 规则注入 + 补充审计
  if (enhancementGuardRules.length > 0 && guardEngine) {
    try {
      guardEngine.injectExternalRules(enhancementGuardRules);
      const guardFiles = allFiles.map((f: BootstrapFileEntry) => ({
        path: f.path,
        content: f.content,
        isTest: f.isTest,
      }));
      const reAudit = guardEngine.auditFiles(guardFiles, { scope: 'project' });
      guardAudit = reAudit;
      logger.info(
        `[Bootstrap] Guard re-audit with ${guardEngine.getExternalRuleCount()} Enhancement Pack rules → ${reAudit.summary?.totalViolations ?? 0} total violations`
      );
    } catch (e: unknown) {
      logger.warn(
        `[Bootstrap] Enhancement Pack guard re-audit failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  // 语言画像 + 差异化文案
  const langProfile = LanguageService.detectProfile(langStats);
  DimensionCopy.applyMulti(activeDimensions, langProfile.primary, langProfile.secondary);

  return {
    activeDimensions,
    enhancementPackInfo,
    enhancementPatterns,
    enhancementGuardRules,
    langProfile,
    detectedFrameworks,
    guardAudit,
  };
}

export async function materializeProjectPanorama({
  container,
  logger,
  report,
}: {
  container: PhaseContainer;
  logger: PhaseLogger;
  report: PhaseReport | null;
}) {
  const warnings: string[] = [];
  let panoramaResult: Record<string, unknown> | null = null;

  try {
    const panoramaService = container.get('panoramaService');
    if (
      panoramaService &&
      typeof (panoramaService as { invalidate?: () => void }).invalidate === 'function'
    ) {
      const pPanoStart = Date.now();
      (panoramaService as { invalidate: () => void }).invalidate();
      const result = await (
        panoramaService as { getResult: () => Promise<Record<string, unknown>> }
      ).getResult();
      panoramaResult = result;
      logger.info(`[Bootstrap] Phase 2.2: Panorama computed in ${Date.now() - pPanoStart}ms`);
      if (report) {
        const overview = await (
          panoramaService as { getOverview: () => Promise<Record<string, unknown>> }
        ).getOverview();
        report.phases.panorama = {
          moduleCount: (overview as { moduleCount?: number }).moduleCount ?? 0,
          layerCount: (overview as { layerCount?: number }).layerCount ?? 0,
          ms: Date.now() - pPanoStart,
        };
      }
    }
  } catch (err: unknown) {
    warnings.push(
      `Phase 2.2 panorama failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return { panoramaResult, warnings };
}

// ── 一站式调用 ─────────────────────────────────────────────

/**
 * runAllPhases — 一站式执行 Phase 1~4 全部数据收集
 *
 * 内部 Agent 和外部 Agent 均可调用此函数获取统一的分析结果。
 *
 * @param projectRoot 项目根目录
 * @param ctx { container, logger }
 * @param [options.incremental=false] 启用增量评估 (Phase 1 后执行)
 * @param [options.generateReport=false] 生成 Phase 级详细报告
 * @param [options.clearOldData=false] 先清除旧 checkpoints/snapshots
 * @param [options.generateAstContext=false] 生成 astContext 文本
 * @param [options.summaryPrefix='Bootstrap scan']
 */
export async function runAllPhases(
  projectRoot: string,
  ctx: AllPhasesContext,
  options: AllPhasesOptions = {}
) {
  const warnings: string[] = [];
  const materialization = resolveProjectAnalysisMaterialization(options.materialize);
  const report: PhaseReport | null = options.generateReport
    ? { phases: {}, startTime: Date.now() }
    : null;

  // ── Phase 1: 文件收集 ──
  const p1Start = Date.now();
  const phase1 = await runPhase1_FileCollection(projectRoot, ctx.logger, options);
  const { allFiles, allTargets, discoverer, langStats, truncated } = phase1;

  if (truncated) {
    warnings.push(
      `File collection truncated at ${options.maxFiles || 500} files. Analysis may be incomplete.`
    );
  }

  if (report) {
    report.phases.fileCollection = {
      fileCount: allFiles.length,
      targetCount: allTargets.length,
      ms: Date.now() - p1Start,
    };
  }

  if (allFiles.length === 0) {
    return {
      allFiles,
      langStats,
      primaryLang: null,
      discoverer,
      allTargets,
      truncated,
      astProjectSummary: null,
      astContext: '',
      codeEntityResult: null,
      callGraphResult: null,
      depGraphData: null,
      depEdgesWritten: 0,
      guardAudit: null,
      guardEngine: null,
      activeDimensions: [],
      enhancementPackInfo: [],
      enhancementPatterns: [],
      enhancementGuardRules: [],
      langProfile: {},
      targetsSummary: [],
      localPackageModules: [],
      warnings,
      report: report || {},
      incrementalPlan: null,
      panoramaResult: null,
      detectedFrameworks: [],
      isEmpty: true,
    };
  }

  // ── Incremental evaluation (Phase 1 后执行，需要 allFiles) ──
  const incrementalEvaluation = await evaluateProjectAnalysisIncrementalPlan({
    enabled: options.incremental === true,
    projectRoot,
    ctx,
    allFiles,
    report,
  });
  warnings.push(...incrementalEvaluation.warnings);
  const incrementalPlan: IncrementalPlan | null = incrementalEvaluation.incrementalPlan;

  // ── Phase 1.5: AST 分析 ──
  const p15Start = Date.now();
  const phase1_5 = await runPhase1_5_AstAnalysis(allFiles, langStats, ctx.logger, {
    generateAstContext: options.generateAstContext || false,
  });
  warnings.push(...phase1_5.warnings);
  if (report) {
    report.phases.ast = {
      classCount: phase1_5.astProjectSummary?.classes?.length || 0,
      ms: Date.now() - p15Start,
    };
  }

  // ── Phase 1.6: Entity Graph ──
  const p16Start = Date.now();
  const phase1_6 = await runPhase1_6_EntityGraph(
    phase1_5.astProjectSummary,
    projectRoot,
    ctx.container,
    ctx.logger,
    { materialize: materialization.codeEntityGraph }
  );
  warnings.push(...phase1_6.warnings);
  if (report) {
    report.phases.entityGraph = {
      entityCount: phase1_6.codeEntityResult?.entitiesUpserted || 0,
      edgeCount: phase1_6.codeEntityResult?.edgesCreated || 0,
      ms: Date.now() - p16Start,
    };
  }

  // ── Phase 1.7: Call Graph (Phase 5) ──
  const p17Start = Date.now();
  const phase1_7 = await runPhase1_7_CallGraph(
    phase1_5.astProjectSummary,
    projectRoot,
    ctx.container,
    ctx.logger,
    { materialize: materialization.callGraph }
  );
  warnings.push(...phase1_7.warnings);
  if (report) {
    report.phases.callGraph = { result: phase1_7.callGraphResult, ms: Date.now() - p17Start };
  }

  // ── Phase 2: 依赖图 ──
  const p2Start = Date.now();
  const phase2 = await runPhase2_DependencyGraph(
    discoverer,
    ctx.container,
    ctx.logger,
    options.sourceTag || 'bootstrap',
    { materializeEdges: materialization.dependencyEdges }
  );
  warnings.push(...phase2.warnings);
  if (report) {
    report.phases.depGraph = {
      edgesWritten: phase2.depEdgesWritten || 0,
      ms: Date.now() - p2Start,
    };
  }

  // ── Phase 2.1: Module 实体 ──
  await runPhase2_1_ModuleEntities(phase2.depGraphData, projectRoot, ctx.container, ctx.logger, {
    materialize: materialization.moduleEntities,
  });

  // ── Phase 2.2: Panorama 全景汇总 ──
  // 必须在 Phase 2.1 之后：此时 code_entities 中已有 module 记录
  let panoramaResult: Record<string, unknown> | null = null;
  if (materialization.panorama) {
    const panorama = await materializeProjectPanorama({
      container: ctx.container,
      logger: ctx.logger,
      report,
    });
    panoramaResult = panorama.panoramaResult;
    warnings.push(...panorama.warnings);
  }

  // ── Phase 3: Guard 审计 ──
  const p3Start = Date.now();
  const phase3 = await runPhase3_GuardAudit(allFiles, ctx.container, ctx.logger, {
    skipGuard: options.skipGuard || false,
    summaryPrefix: options.summaryPrefix || 'Bootstrap scan',
    writeViolations: materialization.guardViolations,
  });
  warnings.push(...phase3.warnings);
  if (report) {
    report.phases.guard = {
      ruleCount: phase3.guardAudit?.rules?.length || 0,
      ms: Date.now() - p3Start,
    };
  }

  // ── Phase 4: 维度解析 + Enhancement Pack ──
  const p4Start = Date.now();
  const primaryLang = detectPrimaryLanguage(langStats);
  const phase4 = await runPhase4_DimensionResolve({
    primaryLang,
    langStats,
    allTargets,
    astProjectSummary: phase1_5.astProjectSummary,
    guardEngine: phase3.guardEngine,
    allFiles,
    logger: ctx.logger,
  });
  if (report) {
    report.phases.dimension = {
      activeDimCount: phase4.activeDimensions?.length || 0,
      detectedFrameworks: phase4.detectedFrameworks,
      ms: Date.now() - p4Start,
    };
  }

  // 如果 Enhancement Pack 产生了新的 guardAudit，覆盖 Phase 3 的结果
  const finalGuardAudit = phase4.guardAudit || phase3.guardAudit;

  const targetsSummary = buildProjectAnalysisTargetsSummary({ allTargets, allFiles, projectRoot });
  const localPackageModules = buildProjectAnalysisLocalPackageModules({ targetsSummary, allFiles });

  // 完成报告
  if (report) {
    report.totalMs = Date.now() - report.startTime;
  }

  return {
    allFiles,
    langStats,
    primaryLang,
    discoverer,
    allTargets,
    truncated,
    astProjectSummary: phase1_5.astProjectSummary,
    astContext: phase1_5.astContext,
    codeEntityResult: phase1_6.codeEntityResult,
    callGraphResult: phase1_7.callGraphResult,
    depGraphData: phase2.depGraphData,
    depEdgesWritten: phase2.depEdgesWritten,
    guardAudit: finalGuardAudit,
    guardEngine: phase3.guardEngine,
    activeDimensions: phase4.activeDimensions,
    enhancementPackInfo: phase4.enhancementPackInfo,
    enhancementPatterns: phase4.enhancementPatterns,
    enhancementGuardRules: phase4.enhancementGuardRules,
    langProfile: phase4.langProfile,
    detectedFrameworks: phase4.detectedFrameworks,
    targetsSummary,
    localPackageModules, // 本地子包汇总（语言无关）
    warnings,
    report, // NEW: Phase 级报告 (null if generateReport=false)
    incrementalPlan, // NEW: 增量评估结果 (null if incremental=false)
    panoramaResult, // Phase 2.2: 全景汇总 (null if panoramaService unavailable)
    isEmpty: false,
  };
}
