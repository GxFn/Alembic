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
 *   Phase 3.5 → Skill 加载 + 维度画像注入
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
import {
  enhanceDimensions,
  extractSkillDimensionGuides,
  loadBootstrapSkills,
} from '../skills.js';
import { buildLanguageExtension, detectPrimaryLanguage, inferLang } from '../../LanguageExtensions.js';
import { inferFilePriority, inferTargetRole } from '../../TargetClassifier.js';

// ── 类型定义 ────────────────────────────────────────────────

/**
 * @typedef {object} PhaseOptions
 * @property {number}  [maxFiles=500]         — 最大扫描文件数
 * @property {number}  [contentMaxLines=120]  — 每文件读取最大行数
 * @property {boolean} [skipGuard=false]      — 是否跳过 Guard 审计
 * @property {object}  [skillContext]          — 预加载的 Skill 上下文（避免重复读取）
 * @property {string}  [sourceTag='bootstrap'] — 依赖图 edge 的 source 标签后缀
 * @property {boolean} [generateAstContext=false] — 是否生成 astContext 文本（内部 Agent 专用）
 */

/**
 * @typedef {object} PhaseResults
 * @property {Array}   allFiles             — 扫描到的所有文件 { name, path, relativePath, content, targetName }
 * @property {object}  langStats            — 语言统计 { ext: count }
 * @property {string}  primaryLang          — 主语言
 * @property {object}  discoverer           — Discoverer 实例
 * @property {Array}   allTargets           — 所有 Targets
 * @property {object|null} astProjectSummary — AST 分析结果
 * @property {string}  astContext           — AST 上下文文本（仅 generateAstContext=true 时非空）
 * @property {object|null} codeEntityResult  — Entity Graph 结果
 * @property {object|null} depGraphData      — 依赖图数据
 * @property {object|null} guardAudit        — Guard 审计结果
 * @property {object|null} guardEngine       — Guard 引擎实例（供 Enhancement Pack 注入后二次审计）
 * @property {object}  skillContext          — Skill 上下文
 * @property {object}  skillGuides           — 维度增强 guides
 * @property {object}  skillSections         — 维度增强 sections
 * @property {Array}   activeDimensions      — 最终激活的维度列表（含 Enhancement Pack 追加、语言画像、Skill 增强）
 * @property {Array}   enhancementPackInfo   — 匹配的 Enhancement Pack 信息
 * @property {Array}   enhancementPatterns   — Enhancement Pack 检测到的 AST 模式
 * @property {object}  langProfile           — 语言画像
 * @property {Array}   targetsSummary        — Targets 摘要
 * @property {string[]} warnings             — 非致命警告
 * @property {object}  report                — Phase 级报告（供内部 Agent 使用）
 * @property {string[]} detectedFrameworks   — 检测到的框架
 */

// ── Phase 1: 文件收集 ──────────────────────────────────────

/**
 * Phase 1: 通过 DiscovererRegistry 检测项目类型并收集源文件
 *
 * @param {string} projectRoot — 项目根目录
 * @param {object} logger
 * @param {PhaseOptions} options
 * @returns {Promise<{ allFiles: Array, allTargets: Array, discoverer: object, langStats: object }>}
 */
export async function runPhase1_FileCollection(projectRoot, logger, options = {}) {
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
 * @param {Array} allFiles — Phase 1 收集的文件
 * @param {object} langStats — 语言统计
 * @param {object} logger
 * @param {object} [options]
 * @param {boolean} [options.generateAstContext=false] — 是否生成 astContext 文本
 * @returns {Promise<{ astProjectSummary: object|null, astContext: string, warnings: string[] }>}
 */
export async function runPhase1_5_AstAnalysis(allFiles, langStats, logger, options = {}) {
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
  } catch (e) {
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
    } catch (e) {
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
 * @param {object|null} astProjectSummary — AST 分析结果
 * @param {string} projectRoot
 * @param {object} container — ServiceContainer
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
    } catch (e) {
      logger.warn(`[Bootstrap] Entity Graph failed (degraded): ${e.message}`);
      warnings.push(`Entity Graph failed: ${e.message}`);
    }
  }

  return { codeEntityResult, warnings };
}

// ── Phase 2: 依赖关系 ──────────────────────────────────────

/**
 * Phase 2: 获取依赖图并写入 knowledge_edges
 *
 * @param {object} discoverer — DiscovererRegistry 检测到的 discoverer
 * @param {object} container — ServiceContainer
 * @param {object} logger
 * @param {string} [sourceTag='bootstrap'] — edge 的 source 标签后缀
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
  } catch (e) {
    logger.warn(`[Bootstrap] DepGraph failed: ${e.message}`);
    warnings.push(`Dependency graph failed: ${e.message}`);
  }

  return { depGraphData, depEdgesWritten, warnings };
}

// ── Phase 2.1: Module 实体写入 ─────────────────────────────

/**
 * Phase 2.1: 将依赖图的 module 节点写入 Code Entity Graph
 *
 * @param {object|null} depGraphData — 依赖图数据
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
  } catch (e) {
    logger.warn(`[Bootstrap] Entity Graph modules failed: ${e.message}`);
  }
}

// ── Phase 3: Guard 审计 ────────────────────────────────────

/**
 * Phase 3: Guard 规则审计
 *
 * @param {Array} allFiles — Phase 1 收集的文件
 * @param {object} container
 * @param {object} logger
 * @param {object} [options]
 * @param {boolean} [options.skipGuard=false]
 * @param {string}  [options.summaryPrefix='Bootstrap scan'] — ViolationsStore 摘要前缀
 * @returns {Promise<{ guardAudit: object|null, guardEngine: object|null, warnings: string[] }>}
 */
export async function runPhase3_GuardAudit(allFiles, container, logger, options = {}) {
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
  } catch (e) {
    logger.warn(`[Bootstrap] Guard audit failed: ${e.message}`);
    warnings.push(`Guard audit failed: ${e.message}`);
  }

  return { guardAudit, guardEngine, warnings };
}

// ── Phase 3.5: Skill 加载 ─────────────────────────────────

/**
 * Phase 3.5: 加载 Bootstrap Skills 并提取维度增强指引
 *
 * @param {string} primaryLang — 主语言
 * @param {object} logger
 * @param {object} [preloadedSkillContext] — 预加载的 Skill 上下文
 * @returns {{ skillContext: object, skillGuides: object, skillSections: object }}
 */
export function runPhase3_5_SkillLoading(primaryLang, logger, preloadedSkillContext = null) {
  const skillContext = preloadedSkillContext || loadBootstrapSkills(primaryLang, logger);

  if (!preloadedSkillContext) {
    logger.info(`[Bootstrap] Skills loaded: ${skillContext.loaded?.join(', ') || 'none'}`);
  }

  const { guides: skillGuides, sectionMap: skillSections } = skillContext
    ? extractSkillDimensionGuides(skillContext)
    : { guides: {}, sectionMap: {} };

  return { skillContext, skillGuides, skillSections };
}

// ── Phase 4: 维度解析 + Enhancement Pack ───────────────────

/**
 * Phase 4: 维度条件化过滤 + Enhancement Pack 动态追加 + 语言画像 + Skill 增强
 *
 * @param {object} params
 * @param {string} params.primaryLang
 * @param {object} params.langStats
 * @param {Array}  params.allTargets
 * @param {object|null} params.astProjectSummary — AST 结果（供 Enhancement Pack 模式检测）
 * @param {object|null} params.guardEngine — Guard 引擎（供 Enhancement Pack 规则注入）
 * @param {Array}  params.allFiles — 文件列表（供 Guard 二次审计）
 * @param {object} params.skillGuides
 * @param {object} params.skillSections
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
    skillGuides, skillSections, logger,
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
  } catch (enhErr) {
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
    } catch (e) {
      logger.warn(`[Bootstrap] Enhancement Pack guard re-audit failed: ${e.message}`);
    }
  }

  // 语言画像 + 差异化文案
  const langProfile = LanguageService.detectProfile(langStats);
  DimensionCopy.applyMulti(activeDimensions, langProfile.primary, langProfile.secondary);

  // Skill 增强维度 guide
  const dimensions = enhanceDimensions(activeDimensions, skillGuides, skillSections);

  return {
    activeDimensions: dimensions,
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
 * @param {string} projectRoot — 项目根目录
 * @param {object} ctx — { container, logger }
 * @param {PhaseOptions} [options]
 * @returns {Promise<PhaseResults>}
 */
export async function runAllPhases(projectRoot, ctx, options = {}) {
  const warnings = [];

  // 路径安全守卫
  if (!pathGuard.configured) {
    const { default: Bootstrap } = await import('../../../../../bootstrap.js');
    Bootstrap.configurePathGuard(projectRoot);
  }

  // ── Phase 1: 文件收集 ──
  const phase1 = await runPhase1_FileCollection(projectRoot, ctx.logger, options);
  const { allFiles, allTargets, discoverer, langStats } = phase1;

  if (allFiles.length === 0) {
    return {
      allFiles, langStats,
      primaryLang: null, discoverer, allTargets,
      astProjectSummary: null, astContext: '',
      codeEntityResult: null, depGraphData: null,
      guardAudit: null, guardEngine: null,
      skillContext: { loaded: [] }, skillGuides: {}, skillSections: {},
      activeDimensions: [], enhancementPackInfo: [],
      enhancementPatterns: [], langProfile: {},
      targetsSummary: [], warnings, report: {},
      detectedFrameworks: [],
      isEmpty: true,
    };
  }

  // ── Phase 1.5: AST 分析 ──
  const phase1_5 = await runPhase1_5_AstAnalysis(allFiles, langStats, ctx.logger, {
    generateAstContext: options.generateAstContext || false,
  });
  warnings.push(...phase1_5.warnings);

  // ── Phase 1.6: Entity Graph ──
  const phase1_6 = await runPhase1_6_EntityGraph(
    phase1_5.astProjectSummary, projectRoot, ctx.container, ctx.logger
  );
  warnings.push(...phase1_6.warnings);

  // ── Phase 2: 依赖图 ──
  const phase2 = await runPhase2_DependencyGraph(
    discoverer, ctx.container, ctx.logger, options.sourceTag || 'bootstrap'
  );
  warnings.push(...phase2.warnings);

  // ── Phase 2.1: Module 实体 ──
  await runPhase2_1_ModuleEntities(phase2.depGraphData, projectRoot, ctx.container, ctx.logger);

  // ── Phase 3: Guard 审计 ──
  const phase3 = await runPhase3_GuardAudit(allFiles, ctx.container, ctx.logger, {
    skipGuard: options.skipGuard || false,
    summaryPrefix: options.summaryPrefix || 'Bootstrap scan',
  });
  warnings.push(...phase3.warnings);

  // ── Phase 3.5: Skill 加载 ──
  const primaryLang = detectPrimaryLanguage(langStats);
  const phase3_5 = runPhase3_5_SkillLoading(primaryLang, ctx.logger, options.skillContext);

  // ── Phase 4: 维度解析 + Enhancement Pack ──
  const phase4 = await runPhase4_DimensionResolve({
    primaryLang, langStats, allTargets,
    astProjectSummary: phase1_5.astProjectSummary,
    guardEngine: phase3.guardEngine,
    allFiles,
    skillGuides: phase3_5.skillGuides,
    skillSections: phase3_5.skillSections,
    logger: ctx.logger,
  });

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

  return {
    allFiles,
    langStats,
    primaryLang,
    discoverer,
    allTargets,
    astProjectSummary: phase1_5.astProjectSummary,
    astContext: phase1_5.astContext,
    codeEntityResult: phase1_6.codeEntityResult,
    depGraphData: phase2.depGraphData,
    depEdgesWritten: phase2.depEdgesWritten,
    guardAudit: finalGuardAudit,
    guardEngine: phase3.guardEngine,
    skillContext: phase3_5.skillContext,
    skillGuides: phase3_5.skillGuides,
    skillSections: phase3_5.skillSections,
    activeDimensions: phase4.activeDimensions,
    enhancementPackInfo: phase4.enhancementPackInfo,
    enhancementPatterns: phase4.enhancementPatterns,
    enhancementGuardRules: phase4.enhancementGuardRules,
    langProfile: phase4.langProfile,
    detectedFrameworks: phase4.detectedFrameworks,
    targetsSummary,
    warnings,
    isEmpty: false,
  };
}

