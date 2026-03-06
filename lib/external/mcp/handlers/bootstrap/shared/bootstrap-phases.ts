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
 *   Phase 2   → 依赖关系 → knowledge_edges
 *   Phase 2.1 → Module 实体写入 Entity Graph
 *   Phase 3   → Guard 规则审计
 *   Phase 4   → 维度条件化过滤 + Enhancement Pack + 语言画像
 *
 * @module bootstrap/shared/bootstrap-phases
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  analyzeProject,
  isAvailable as astIsAvailable,
  generateContextForAgent,
} from '../../../../../core/AstAnalyzer.js';
import { DimensionCopy } from '../../../../../shared/DimensionCopyRegistry.js';
import { LanguageService } from '../../../../../shared/LanguageService.js';
import pathGuard from '../../../../../shared/PathGuard.js';
import { baseDimensions, resolveActiveDimensions } from '../base-dimensions.js';
import { buildLanguageExtension, detectPrimaryLanguage, inferLang } from '../../LanguageExtensions.js';
import { inferFilePriority, inferTargetRole } from '../../TargetClassifier.js';

// ── 类型定义 ────────────────────────────────────────────────

/**
 * @typedef {object} PhaseOptions
 * @property {number}  [maxFiles=500]         最大扫描文件数
 * @property {number}  [contentMaxLines=120]  每文件读取最大行数
 * @property {boolean} [skipGuard=false]      是否跳过 Guard 审计
 * @property {object}  [sourceTag='bootstrap'] 依赖图 edge 的 source 标签后缀
 * @property {boolean} [generateAstContext=false] 是否生成 astContext 文本（内部 Agent 专用）
 */

/**
 * @typedef {object} PhaseResults
 * @property {Array}   allFiles             扫描到的所有文件 { name, path, relativePath, content, targetName }
 * @property {object}  langStats            语言统计 { ext: count }
 * @property {string}  primaryLang          主语言
 * @property {object}  discoverer           - Discoverer 实例
 * @property {Array}   allTargets           所有 Targets
 * @property {object|null} astProjectSummary - AST 分析结果
 * @property {string}  astContext           - AST 上下文文本（仅 generateAstContext=true 时非空）
 * @property {object|null} codeEntityResult  - Entity Graph 结果
 * @property {object|null} depGraphData      依赖图数据
 * @property {object|null} guardAudit        - Guard 审计结果
 * @property {object|null} guardEngine       - Guard 引擎实例（供 Enhancement Pack 注入后二次审计）
 * @property {Array}   activeDimensions      最终激活的维度列表（含 Enhancement Pack 追加、语言画像）
 * @property {Array}   enhancementPackInfo   匹配的 Enhancement Pack 信息
 * @property {Array}   enhancementPatterns   - Enhancement Pack 检测到的 AST 模式
 * @property {object}  langProfile           语言画像
 * @property {Array}   targetsSummary        - Targets 摘要
 * @property {string[]} warnings             非致命警告
 * @property {object}  report                - Phase 级报告（供内部 Agent 使用）
 * @property {string[]} detectedFrameworks   检测到的框架
 */

// ── R13: AutoSnippet 生成物黑名单 ─────────────────────────

const ASD_GENERATED_BASENAMES = new Set([
  'AGENTS.md', 'CLAUDE.md', 'copilot-instructions.md',
]);
const ASD_GENERATED_PATH_SEGMENTS = [
  `${path.sep}.cursor${path.sep}`,     // .cursor/rules/*.mdc
  `${path.sep}.github${path.sep}copilot-instructions.md`,
];

/**
 * 判断文件是否为 AutoSnippet 生成物（用于排除自引用循环知识）
 * @param {string} filePath
 * @returns {boolean}
 */
export function isAutoSnippetGenerated(filePath) {
  const base = path.basename(filePath);
  if (ASD_GENERATED_BASENAMES.has(base)) return true;
  for (const seg of ASD_GENERATED_PATH_SEGMENTS) {
    if (filePath.includes(seg)) return true;
  }
  if (base.endsWith('.mdc')) return true;
  return false;
}

// ── Phase 1: 文件收集 ──────────────────────────────────────

/**
 * Phase 1: 通过 DiscovererRegistry 检测项目类型并收集源文件
 *
 * @param {string} projectRoot 项目根目录
 * @param {object} logger
 * @param {PhaseOptions} options
 * @returns {Promise<{ allFiles: Array, allTargets: Array, discoverer: object, langStats: object }>}
 */
export async function runPhase1_FileCollection(projectRoot, logger, options: any = {}) {
  const maxFiles = options.maxFiles || 500;

  const { getDiscovererRegistry } = await import('../../../../../core/discovery/index.js');
  const registry = getDiscovererRegistry();
  const discoverer = await registry.detect(projectRoot);
  logger.info(`[Bootstrap] Project type: ${discoverer.displayName} (${discoverer.id})`);

  await discoverer.load(projectRoot);
  const allTargets = await discoverer.listTargets();

  const seenPaths = new Set();
  const allFiles = [];
  for (const t of allTargets) {
    try {
      const fileList = await discoverer.getTargetFiles(t);
      for (const f of fileList) {
        const fp = typeof f === 'string' ? f : f.path;
        if (seenPaths.has(fp)) continue;
        if (isAutoSnippetGenerated(fp)) continue; // R13: skip generated files
        seenPaths.add(fp);
        try {
          const content = fs.readFileSync(fp, 'utf8');
          allFiles.push({
            name: f.name || path.basename(fp),
            path: fp,
            relativePath: f.relativePath || path.basename(fp),
            content,
            targetName: typeof t === 'string' ? t : t.name,
          });
        } catch { /* skip unreadable */ }
        if (allFiles.length >= maxFiles) break;
      }
    } catch { /* skip target */ }
    if (allFiles.length >= maxFiles) break;
  }

  // 语言统计
  const langStats = {};
  for (const f of allFiles) {
    const ext = path.extname(f.name).replace('.', '') || 'unknown';
    langStats[ext] = (langStats[ext] || 0) + 1;
  }

  return { allFiles, allTargets, discoverer, langStats };
}

// ── Phase 1.5: AST 代码结构分析 ────────────────────────────

/**
 * Phase 1.5: tree-sitter AST 分析
 *   - 1.5a: 按需安装缺失的语法包
 *   - 1.5b: 执行 AST 分析 + SFC 预处理
 *
 * @param {Array} allFiles - Phase 1 收集的文件
 * @param {object} langStats 语言统计
 * @param {object} logger
 * @param {object} [options]
 * @param {boolean} [options.generateAstContext=false] 是否生成 astContext 文本
 * @returns {Promise<{ astProjectSummary: object|null, astContext: string, warnings: string[] }>}
 */
export async function runPhase1_5_AstAnalysis(allFiles, langStats, logger, options: any = {}) {
  const warnings = [];
  let astProjectSummary = null;
  let astContext = '';

  // Phase 1.5a: 按需安装缺失的 tree-sitter 语法包
  try {
    const { ensureGrammars, inferLanguagesFromStats, reloadPlugins } = await import(
      '../../../../../core/ast/ensure-grammars.js'
    );
    const neededLangs = inferLanguagesFromStats(langStats);
    if (neededLangs.length > 0) {
      const result = await ensureGrammars(neededLangs, { logger });
      if (result.installed.length > 0) {
        logger.info(`[Bootstrap] Installed grammars: ${result.installed.join(', ')}`);
        await reloadPlugins();
      }
    }
    await import('../../../../../core/ast/index.js');
  } catch (e: any) {
    logger.warn(`[Bootstrap] Grammar auto-install skipped: ${e.message}`);
  }

  // Phase 1.5b: AST 分析
  const primaryLangEarly = detectPrimaryLanguage(langStats);
  if (astIsAvailable() && primaryLangEarly) {
    try {
      const astFiles = allFiles.map((f) => ({
        name: f.name,
        relativePath: f.relativePath,
        content: f.content,
      }));

      // SFC 预处理 (.vue / .svelte)
      let sfcPreprocessor = null;
      try {
        const { initEnhancementRegistry } = await import('../../../../../core/enhancement/index.js');
        const enhReg = await initEnhancementRegistry();
        const preprocessPack = enhReg.all().find((p) => typeof p.preprocessFile === 'function');
        if (preprocessPack) {
          sfcPreprocessor = preprocessPack.preprocessFile.bind(preprocessPack);
        }
      } catch { /* Enhancement 未加载 */ }

      astProjectSummary = analyzeProject(astFiles, primaryLangEarly, {
        preprocessFile: sfcPreprocessor,
      });

      // 内部 Agent 专用: 生成 astContext 文本
      if (options.generateAstContext) {
        astContext = generateContextForAgent(astProjectSummary);
      }

      logger.info(
        `[Bootstrap] AST: ${astProjectSummary.classes.length} classes, ` +
        `${astProjectSummary.protocols.length} protocols` +
        (astProjectSummary.categories ? `, ${astProjectSummary.categories.length} categories` : '') +
        (astProjectSummary.patternStats ? `, ${Object.keys(astProjectSummary.patternStats).length} patterns` : '')
      );
    } catch (e: any) {
      logger.warn(`[Bootstrap] AST analysis failed (degraded): ${e.message}`);
      warnings.push(`AST analysis partially failed: ${e.message}`);
    }
  } else {
    logger.info(
      `[Bootstrap] AST skipped: tree-sitter ${astIsAvailable() ? 'available' : 'not available'}, lang=${primaryLangEarly}`
    );
  }

  return { astProjectSummary, astContext, warnings };
}

// ── Phase 1.6: Code Entity Graph ───────────────────────────

/**
 * Phase 1.6: 从 AST 结果构建代码实体关系图谱
 *
 * @param {object|null} astProjectSummary - AST 分析结果
 * @param {string} projectRoot
 * @param {object} container - ServiceContainer
 * @param {object} logger
 * @returns {Promise<{ codeEntityResult: object|null, warnings: string[] }>}
 */
export async function runPhase1_6_EntityGraph(astProjectSummary, projectRoot, container, logger) {
  const warnings = [];
  let codeEntityResult = null;

  if (astProjectSummary) {
    try {
      const { CodeEntityGraph } = await import('../../../../../service/knowledge/CodeEntityGraph.js');
      const db = container.get('database');
      if (db) {
        const ceg = new CodeEntityGraph(db, { projectRoot });
        ceg.clearProject();
        codeEntityResult = ceg.populateFromAst(astProjectSummary);
        logger.info(
          `[Bootstrap] Entity Graph: ${codeEntityResult.entitiesUpserted} entities, ${codeEntityResult.edgesCreated} edges`
        );
      }
    } catch (e: any) {
      logger.warn(`[Bootstrap] Entity Graph failed (degraded): ${e.message}`);
      warnings.push(`Entity Graph failed: ${e.message}`);
    }
  }

  return { codeEntityResult, warnings };
}

// ── Phase 2: 依赖关系 ──────────────────────────────────────

/**
 * Phase 1.7: 跨文件调用图分析 (Phase 5)
 *
 * 从 AST 的 callSites 构建全局调用图并写入 CodeEntityGraph。
 *
 * @param {object|null} astProjectSummary - AST 分析结果 (含 fileSummaries[].callSites)
 * @param {string} projectRoot
 * @param {object} container - ServiceContainer
 * @param {object} logger
 * @param {object} [incrementalOpts] 增量分析选项
 * @param {string[]} [incrementalOpts.changedFiles] 变更文件的相对路径
 * @returns {Promise<{ callGraphResult: object|null, warnings: string[] }>}
 */
export async function runPhase1_7_CallGraph(astProjectSummary, projectRoot, container, logger, incrementalOpts = null) {
  const warnings = [];
  let callGraphResult = null;

  if (!astProjectSummary?.fileSummaries?.length) {
    return { callGraphResult, warnings };
  }

  // 检查是否有 callSites 数据 (Phase 5 提取)
  const hasCallSites = astProjectSummary.fileSummaries.some(
    (f) => f.callSites && f.callSites.length > 0
  );
  if (!hasCallSites) {
    logger.info('[Bootstrap] Call Graph skipped: no call sites extracted');
    return { callGraphResult, warnings };
  }

  try {
    const { CallGraphAnalyzer } = await import('../../../../../core/analysis/CallGraphAnalyzer.js');
    const { CodeEntityGraph } = await import('../../../../../service/knowledge/CodeEntityGraph.js');

    const analyzer = new CallGraphAnalyzer(projectRoot);
    const changedFiles = incrementalOpts?.changedFiles;
    const isIncremental = changedFiles?.length > 0 && changedFiles.length <= 10;

    // Phase 5 分析 (带超时保护 + 渐进式 partial result)
    const result = isIncremental
      ? await analyzer.analyzeIncremental(astProjectSummary, changedFiles, {
          timeout: 15_000,
          maxCallSitesPerFile: 500,
          minConfidence: 0.5,
        })
      : await analyzer.analyze(astProjectSummary, {
          timeout: 15_000,
          maxCallSitesPerFile: 500,
          minConfidence: 0.5,
        });

    // 写入 CodeEntityGraph
    const db = container.get('database');
    if (db && result && result.callEdges.length > 0) {
      const ceg = new CodeEntityGraph(db, { projectRoot });

      // 增量模式: 先删除变更文件的旧边
      if (isIncremental) {
        ceg.clearCallGraphForFiles(changedFiles);
      }

      callGraphResult = ceg.populateCallGraph(result.callEdges, result.dataFlowEdges);

      const partialTag = (result.stats as any).partial ? ' [partial]' : '';
      const incrTag = isIncremental ? ' [incremental]' : '';
      logger.info(
        `[Bootstrap] Call Graph${incrTag}${partialTag}: ${result.callEdges.length} call edges, ` +
        `${result.dataFlowEdges.length} data flow edges, ` +
        `resolution rate: ${(result.stats.resolvedRate * 100).toFixed(1)}%`
      );
    } else if (result) {
      logger.info(
        `[Bootstrap] Call Graph: ${result.stats.totalCallSites} call sites, 0 resolved edges`
      );
    }
  } catch (e: any) {
    logger.warn(`[Bootstrap] Call Graph failed (degraded): ${e.message}`);
    warnings.push(`Call Graph failed: ${e.message}`);
  }

  return { callGraphResult, warnings };
}

// ── Phase 2: 依赖关系 ──────────────────────────────────────

/**
 * Phase 2: 获取依赖图并写入 knowledge_edges
 *
 * @param {object} discoverer - DiscovererRegistry 检测到的 discoverer
 * @param {object} container - ServiceContainer
 * @param {object} logger
 * @param {string} [sourceTag='bootstrap'] - edge 的 source 标签后缀
 * @returns {Promise<{ depGraphData: object|null, depEdgesWritten: number, warnings: string[] }>}
 */
export async function runPhase2_DependencyGraph(discoverer, container, logger, sourceTag = 'bootstrap') {
  const warnings = [];
  let depGraphData = null;
  let depEdgesWritten = 0;

  try {
    const knowledgeGraphService = container.get('knowledgeGraphService');
    depGraphData = await discoverer.getDependencyGraph();
    if (knowledgeGraphService) {
      for (const edge of depGraphData.edges || []) {
        const result = knowledgeGraphService.addEdge(
          edge.from, 'module', edge.to, 'module', 'depends_on',
          { weight: 1.0, source: `${discoverer.id}-${sourceTag}` }
        );
        if (result?.success) depEdgesWritten++;
      }
    }
  } catch (e: any) {
    logger.warn(`[Bootstrap] DepGraph failed: ${e.message}`);
    warnings.push(`Dependency graph failed: ${e.message}`);
  }

  return { depGraphData, depEdgesWritten, warnings };
}

// ── Phase 2.1: Module 实体写入 ─────────────────────────────

/**
 * Phase 2.1: 将依赖图的 module 节点写入 Code Entity Graph
 *
 * @param {object|null} depGraphData 依赖图数据
 * @param {string} projectRoot
 * @param {object} container
 * @param {object} logger
 */
export async function runPhase2_1_ModuleEntities(depGraphData, projectRoot, container, logger) {
  if (!depGraphData?.nodes?.length) return;

  try {
    const { CodeEntityGraph } = await import('../../../../../service/knowledge/CodeEntityGraph.js');
    const db = container.get('database');
    if (db) {
      const ceg = new CodeEntityGraph(db, { projectRoot });
      const result = ceg.populateFromSpm(depGraphData);
      logger.info(`[Bootstrap] Entity Graph modules: ${result.entitiesUpserted} entities`);
    }
  } catch (e: any) {
    logger.warn(`[Bootstrap] Entity Graph modules failed: ${e.message}`);
  }
}

// ── Phase 3: Guard 审计 ────────────────────────────────────

/**
 * Phase 3: Guard 规则审计
 *
 * @param {Array} allFiles - Phase 1 收集的文件
 * @param {object} container
 * @param {object} logger
 * @param {object} [options]
 * @param {boolean} [options.skipGuard=false]
 * @param {string}  [options.summaryPrefix='Bootstrap scan'] - ViolationsStore 摘要前缀
 * @returns {Promise<{ guardAudit: object|null, guardEngine: object|null, warnings: string[] }>}
 */
export async function runPhase3_GuardAudit(allFiles, container, logger, options: any = {}) {
  const warnings = [];
  let guardAudit = null;
  let guardEngine = null;

  if (options.skipGuard) {
    return { guardAudit, guardEngine, warnings };
  }

  try {
    const { GuardCheckEngine } = await import('../../../../../service/guard/GuardCheckEngine.js');
    const db = container.get('database');
    guardEngine = new GuardCheckEngine(db);
    const guardFiles = allFiles.map((f) => ({ path: f.path, content: f.content }));
    guardAudit = guardEngine.auditFiles(guardFiles, { scope: 'project' });

    // 写入 ViolationsStore
    try {
      const violationsStore = container.get('violationsStore');
      const prefix = options.summaryPrefix || 'Bootstrap scan';
      for (const fileResult of guardAudit.files || []) {
        if (fileResult.violations.length > 0) {
          violationsStore.appendRun({
            filePath: fileResult.filePath,
            violations: fileResult.violations,
            summary: `${prefix}: ${fileResult.summary.errors}E ${fileResult.summary.warnings}W`,
          });
        }
      }
    } catch { /* ViolationsStore not available */ }
  } catch (e: any) {
    logger.warn(`[Bootstrap] Guard audit failed: ${e.message}`);
    warnings.push(`Guard audit failed: ${e.message}`);
  }

  return { guardAudit, guardEngine, warnings };
}

// ── Phase 4: 维度解析 + Enhancement Pack ───────────────────

/**
 * Phase 4: 维度条件化过滤 + Enhancement Pack 动态追加 + 语言画像 + Skill 增强
 *
 * @param {object} params
 * @param {string} params.primaryLang
 * @param {object} params.langStats
 * @param {Array}  params.allTargets
 * @param {object|null} params.astProjectSummary - AST 结果（供 Enhancement Pack 模式检测）
 * @param {object|null} params.guardEngine - Guard 引擎（供 Enhancement Pack 规则注入）
 * @param {Array}  params.allFiles 文件列表（供 Guard 二次审计）
 * @param {object} params.logger
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
export async function runPhase4_DimensionResolve(params) {
  const {
    primaryLang, langStats, allTargets,
    astProjectSummary, guardEngine, allFiles,
    logger,
  } = params;

  // 框架检测
  const detectedFrameworks = allTargets
    .map((t) => (typeof t === 'object' ? t.framework : null))
    .filter(Boolean);

  // 条件维度过滤
  let activeDimensions = resolveActiveDimensions(baseDimensions, primaryLang, detectedFrameworks);

  // Enhancement Pack 动态追加
  const enhancementPackInfo = [];
  const enhancementGuardRules = [];
  const enhancementPatterns = [];
  let guardAudit = null;

  try {
    const { initEnhancementRegistry } = await import('../../../../../core/enhancement/index.js');
    const enhReg = await initEnhancementRegistry();
    const matchedPacks = enhReg.resolve(primaryLang, detectedFrameworks);

    for (const pack of matchedPacks) {
      enhancementPackInfo.push({ id: pack.id, displayName: pack.displayName });

      // 追加额外维度
      for (const dim of pack.getExtraDimensions()) {
        if (!activeDimensions.some((d) => d.id === dim.id)) {
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
            enhancementPatterns.push(...patterns.map((p) => ({ ...p, source: pack.id })));
          }
        } catch { /* graceful degradation */ }
      }
    }

    if (matchedPacks.length > 0) {
      logger.info(
        `[Bootstrap] Enhancement packs: ${matchedPacks.map((p) => p.id).join(', ')} → ` +
        `+${activeDimensions.length - baseDimensions.length} dims, ${enhancementGuardRules.length} guard rules, ${enhancementPatterns.length} patterns`
      );
    }
  } catch (enhErr: any) {
    logger.warn(`[Bootstrap] Enhancement packs skipped: ${enhErr.message}`);
  }

  // Enhancement Pack Guard 规则注入 + 补充审计
  if (enhancementGuardRules.length > 0 && guardEngine) {
    try {
      guardEngine.injectExternalRules(enhancementGuardRules);
      const guardFiles = allFiles.map((f) => ({ path: f.path, content: f.content }));
      guardAudit = guardEngine.auditFiles(guardFiles, { scope: 'project' });
      logger.info(
        `[Bootstrap] Guard re-audit with ${guardEngine.getExternalRuleCount()} Enhancement Pack rules → ${guardAudit.summary.totalViolations} total violations`
      );
    } catch (e: any) {
      logger.warn(`[Bootstrap] Enhancement Pack guard re-audit failed: ${e.message}`);
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

// ── 一站式调用 ─────────────────────────────────────────────

/**
 * runAllPhases — 一站式执行 Phase 1~4 全部数据收集
 *
 * 内部 Agent 和外部 Agent 均可调用此函数获取统一的分析结果。
 *
 * @param {string} projectRoot 项目根目录
 * @param {object} ctx - { container, logger }
 * @param {object} [options]
 * @param {boolean} [options.incremental=false]       启用增量评估 (Phase 1 后执行)
 * @param {boolean} [options.generateReport=false]    生成 Phase 级详细报告
 * @param {boolean} [options.clearOldData=false]      先清除旧 checkpoints/snapshots
 * @param {boolean} [options.generateAstContext=false] 生成 astContext 文本
 * @param {number}  [options.maxFiles=500]
 * @param {boolean} [options.skipGuard=false]
 * @param {string}  [options.sourceTag='bootstrap']
 * @param {string}  [options.summaryPrefix='Bootstrap scan']
 * @returns {Promise<PhaseResults>}
 */
export async function runAllPhases(projectRoot, ctx, options: any = {}) {
  const warnings = [];
  const report: any = options.generateReport ? { phases: {}, startTime: Date.now() } : null;

  // 路径安全守卫
  if (!pathGuard.configured) {
    const { default: Bootstrap } = await import('../../../../../bootstrap.js');
    (Bootstrap as any).configurePathGuard(projectRoot);
  }

  // ── 清除旧数据 (if requested) ──
  if (options.clearOldData) {
    try {
      const { clearCheckpoints, clearSnapshots } = await import('../pipeline/orchestrator.js');
      await clearCheckpoints(projectRoot);
      await clearSnapshots(projectRoot, ctx);
      ctx.logger.info('[Bootstrap] Cleared old checkpoints and snapshots');
    } catch (err: any) {
      warnings.push(`clearOldData failed (non-blocking): ${err.message}`);
    }
  }

  // ── Phase 1: 文件收集 ──
  const p1Start = Date.now();
  const phase1 = await runPhase1_FileCollection(projectRoot, ctx.logger, options);
  let { allFiles, allTargets, discoverer, langStats } = phase1;

  if (report) report.phases.fileCollection = { fileCount: allFiles.length, targetCount: allTargets.length, ms: Date.now() - p1Start };

  if (allFiles.length === 0) {
    return {
      allFiles, langStats,
      primaryLang: null, discoverer, allTargets,
      astProjectSummary: null, astContext: '',
      codeEntityResult: null, callGraphResult: null,
      depGraphData: null, depEdgesWritten: 0,
      guardAudit: null, guardEngine: null,
      activeDimensions: [], enhancementPackInfo: [],
      enhancementPatterns: [], enhancementGuardRules: [],
      langProfile: {},
      targetsSummary: [], warnings,
      report: report || {},
      incrementalPlan: null,
      detectedFrameworks: [],
      isEmpty: true,
    };
  }

  // ── Incremental evaluation (Phase 1 后执行，需要 allFiles) ──
  let incrementalPlan = null;
  if (options.incremental) {
    try {
      const { IncrementalBootstrap } = await import('../pipeline/IncrementalBootstrap.js');
      const db = ctx.container?.resolve?.('db') ?? ctx.db;
      if (db) {
        const ib = new IncrementalBootstrap(db, projectRoot, { logger: ctx.logger });
        const dimIds = baseDimensions.map(d => d.id);
        incrementalPlan = await ib.evaluate(allFiles, dimIds);
        if (report) report.phases.incremental = { plan: incrementalPlan };
        ctx.logger.info(`[Bootstrap] Incremental mode: ${incrementalPlan.mode}, affected: ${incrementalPlan.affectedDimensions?.length || 0}`);
      } else {
        warnings.push('incremental: db not available, falling back to full');
      }
    } catch (err: any) {
      warnings.push(`incremental evaluation failed (non-blocking): ${err.message}`);
    }
  }

  // ── Phase 1.5: AST 分析 ──
  const p15Start = Date.now();
  const phase1_5 = await runPhase1_5_AstAnalysis(allFiles, langStats, ctx.logger, {
    generateAstContext: options.generateAstContext || false,
  });
  warnings.push(...phase1_5.warnings);
  if (report) report.phases.ast = { classCount: phase1_5.astProjectSummary?.classes?.length || 0, ms: Date.now() - p15Start };

  // ── Phase 1.6: Entity Graph ──
  const p16Start = Date.now();
  const phase1_6 = await runPhase1_6_EntityGraph(
    phase1_5.astProjectSummary, projectRoot, ctx.container, ctx.logger
  );
  warnings.push(...phase1_6.warnings);
  if (report) report.phases.entityGraph = { entityCount: phase1_6.codeEntityResult?.entitiesUpserted || 0, edgeCount: phase1_6.codeEntityResult?.edgesCreated || 0, ms: Date.now() - p16Start };

  // ── Phase 1.7: Call Graph (Phase 5) ──
  const p17Start = Date.now();
  const phase1_7 = await runPhase1_7_CallGraph(
    phase1_5.astProjectSummary, projectRoot, ctx.container, ctx.logger
  );
  warnings.push(...phase1_7.warnings);
  if (report) report.phases.callGraph = { result: phase1_7.callGraphResult, ms: Date.now() - p17Start };

  // ── Phase 2: 依赖图 ──
  const p2Start = Date.now();
  const phase2 = await runPhase2_DependencyGraph(
    discoverer, ctx.container, ctx.logger, options.sourceTag || 'bootstrap'
  );
  warnings.push(...phase2.warnings);
  if (report) report.phases.depGraph = { edgesWritten: phase2.depEdgesWritten || 0, ms: Date.now() - p2Start };

  // ── Phase 2.1: Module 实体 ──
  await runPhase2_1_ModuleEntities(phase2.depGraphData, projectRoot, ctx.container, ctx.logger);

  // ── Phase 3: Guard 审计 ──
  const p3Start = Date.now();
  const phase3 = await runPhase3_GuardAudit(allFiles, ctx.container, ctx.logger, {
    skipGuard: options.skipGuard || false,
    summaryPrefix: options.summaryPrefix || 'Bootstrap scan',
  });
  warnings.push(...phase3.warnings);
  if (report) report.phases.guard = { ruleCount: phase3.guardAudit?.rules?.length || 0, ms: Date.now() - p3Start };

  // ── Phase 4: 维度解析 + Enhancement Pack ──
  const p4Start = Date.now();
  const primaryLang = detectPrimaryLanguage(langStats);
  const phase4 = await runPhase4_DimensionResolve({
    primaryLang, langStats, allTargets,
    astProjectSummary: phase1_5.astProjectSummary,
    guardEngine: phase3.guardEngine,
    allFiles,
    logger: ctx.logger,
  });
  if (report) report.phases.dimension = { activeDimCount: phase4.activeDimensions?.length || 0, detectedFrameworks: phase4.detectedFrameworks, ms: Date.now() - p4Start };

  // 如果 Enhancement Pack 产生了新的 guardAudit，覆盖 Phase 3 的结果
  const finalGuardAudit = phase4.guardAudit || phase3.guardAudit;

  // Targets 摘要
  const targetsSummary = allTargets.map((t) => {
    const name = typeof t === 'string' ? t : t.name;
    return {
      name,
      type: t.type || 'target',
      packageName: t.packageName || undefined,
      inferredRole: inferTargetRole(name),
      fileCount: allFiles.filter((f) => f.targetName === name).length,
    };
  });

  // 完成报告
  if (report) report.totalMs = Date.now() - report.startTime;

  return {
    allFiles,
    langStats,
    primaryLang,
    discoverer,
    allTargets,
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
    warnings,
    report,                // NEW: Phase 级报告 (null if generateReport=false)
    incrementalPlan,       // NEW: 增量评估结果 (null if incremental=false)
    isEmpty: false,
  };
}

