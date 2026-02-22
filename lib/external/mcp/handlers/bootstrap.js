/**
 * MCP Handlers — Bootstrap 冷启动知识库初始化 (v5 + Async Fill)
 *
 * 统一底层逻辑：ChatAgent 和外部 Agent (MCP) 共享同一套 Skill 增强的 Bootstrap。
 *
 * v5 架构变更：快速骨架 + 异步逐维度填充（前端 loading 卡片 → 完成通知）
 *
 * 同步阶段（快速返回，~1-3s）:
 *   Phase 1   → 文件收集（SPM Target 源文件扫描）
 *   Phase 1.5 → AST 代码结构分析（Tree-sitter）
 *   Phase 2   → SPM 依赖关系 → knowledge_edges（模块级图谱）
 *   Phase 3   → Guard 规则审计
 *   Phase 3.5 → [Skill-aware] 加载 coldstart + language-reference Skills → 增强维度定义
 *   Phase 4   → 构建响应骨架（filesByTarget + analysisFramework + 任务清单）
 *
 * 异步阶段（后台逐一填充，通过 Socket.io 推送进度）:
 *   Phase 5   → 微观维度 × 子主题提取代码特征 → 创建 N 条 Candidate（PENDING 状态）
 *              skillWorthy 维度仅提取内容，不创建 Candidate（避免与 Skill 重复）
 *              anti-pattern 已移除 — 代码问题由 Guard 独立处理
 *   Phase 5.5 → 宏观维度（architecture/code-standard/project-profile/agent-guidelines）
 *              自动聚合为 Project Skill → 写入 AutoSnippet/skills/（不产生 Candidate）
 *
 * 进度推送事件（Socket.io + EventBus）:
 *   bootstrap:started        — 骨架创建完成，携带任务清单
 *   bootstrap:task-started   — 单个维度开始填充
 *   bootstrap:task-completed — 单个维度填充完成
 *   bootstrap:task-failed    — 单个维度失败
 *   bootstrap:all-completed  — 全部维度完成（前端弹出通知）
 *
 * 模块结构:
 *   bootstrap.js              ← 主入口 (本文件)
 *   bootstrap/skills.js       ← Skill 加载与维度增强
 *   bootstrap/patterns.js     ← 多语言代码模式匹配
 *   bootstrap/dimensions.js   ← 7 维度知识提取器
 *   bootstrap/projectSkills.js ← Phase 5.5 Project Skill 生成
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  analyzeProject,
  isAvailable as astIsAvailable,
  generateContextForAgent,
} from '../../../core/AstAnalyzer.js';
import { DimensionCopy } from '../../../shared/DimensionCopyRegistry.js';
import { LanguageService } from '../../../shared/LanguageService.js';
import pathGuard from '../../../shared/PathGuard.js';
import { envelope } from '../envelope.js';
import {
  clearCheckpoints,
  clearSnapshots,
  fillDimensionsV3,
} from './bootstrap/pipeline/orchestrator.js';
// ── Sub-modules ──
import {
  enhanceDimensions,
  extractSkillDimensionGuides,
  loadBootstrapSkills,
} from './bootstrap/skills.js';
import { buildLanguageExtension, detectPrimaryLanguage, inferLang } from './LanguageExtensions.js';
import { inferFilePriority, inferTargetRole } from './TargetClassifier.js';
import { baseDimensions, resolveActiveDimensions } from './bootstrap/base-dimensions.js';
import { bootstrapRefine } from './bootstrap/refine.js';

// Re-export for external consumers
export { loadBootstrapSkills };
export { bootstrapRefine };

/**
 * bootstrapKnowledge — 一键初始化知识库 (Skill-aware)
 *
 * 覆盖 7 大知识维度: 项目规范、使用习惯、架构模式、代码模式、最佳实践、项目库特征、Agent开发注意事项
 * （注意：反模式/代码问题由 Guard 独立处理，不在 Bootstrap 覆盖范围）
 * 为每个维度自动创建 Candidate（PENDING），外部 Agent 可按文件粒度补充更多候选。
 *
 * @param {object} ctx  { container, logger }
 * @param {object} args
 * @param {number} [args.maxFiles=500] 最大扫描文件数
 * @param {boolean} [args.skipGuard=false] 是否跳过 Guard 审计
 * @param {number} [args.contentMaxLines=120] 每文件读取最大行数
 * @param {boolean} [args.loadSkills=false] 是否加载 Skills 增强维度定义（共享层，ChatAgent + MCP 均可使用）
 * @param {object} [args.skillContext] 预加载的 Skill 上下文（由 ChatAgent 传入，避免重复读取）
 * @param {boolean} [args.incremental=true] 是否启用增量 Bootstrap (自动检测变更, 仅重跑受影响维度)
 */
export async function bootstrapKnowledge(ctx, args) {
  const t0 = Date.now();
  const projectRoot = process.env.ASD_PROJECT_DIR || process.cwd();

  // v5.0: 增量 Bootstrap 开关 (默认启用, 自动检测是否可增量)
  const enableIncremental = args.incremental !== false;

  // ── 清除旧 checkpoint + 增量快照: 每次手动触发冷启动时强制全量重建 ──
  await clearCheckpoints(projectRoot);
  await clearSnapshots(projectRoot, ctx);
  ctx.logger.info('[Bootstrap] Cleared old checkpoints + snapshots — starting fresh');

  // 路径安全守卫 — 确保所有写操作限制在项目目录内
  if (!pathGuard.configured) {
    const { default: Bootstrap } = await import('../../../bootstrap.js');
    Bootstrap.configurePathGuard(projectRoot);
  }

  const maxFiles = args.maxFiles || 500;
  const skipGuard = args.skipGuard || false;
  const contentMaxLines = args.contentMaxLines || 120;
  const shouldLoadSkills = args.loadSkills ?? true;

  const report = {
    phases: {},
    totals: { files: 0, graphEdges: 0, guardViolations: 0 },
  };

  // ═══════════════════════════════════════════════════════════
  // Phase 1: 文件收集（通过 DiscovererRegistry 自动选择项目类型）
  // ═══════════════════════════════════════════════════════════
  const { getDiscovererRegistry } = await import('../../../core/discovery/index.js');
  const registry = getDiscovererRegistry();
  const discoverer = await registry.detect(projectRoot);
  ctx.logger.info(`[Bootstrap] Project type: ${discoverer.displayName} (${discoverer.id})`);

  await discoverer.load(projectRoot);
  const allTargets = await discoverer.listTargets();

  const seenPaths = new Set();
  const allFiles = []; // { name, path, relativePath, content, targetName }
  for (const t of allTargets) {
    try {
      const fileList = await discoverer.getTargetFiles(t);
      for (const f of fileList) {
        const fp = typeof f === 'string' ? f : f.path;
        if (seenPaths.has(fp)) {
          continue;
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

  report.phases.fileCollection = {
    discoverer: discoverer.id,
    discovererName: discoverer.displayName,
    targets: allTargets.length,
    files: allFiles.length,
    truncated: allFiles.length >= maxFiles,
  };
  report.totals.files = allFiles.length;

  // ═══════════════════════════════════════════════════════════
  // Phase 1.1: 增量 Bootstrap 评估
  // ═══════════════════════════════════════════════════════════
  let incrementalPlan = null;
  if (enableIncremental && allFiles.length > 0) {
    try {
      const db = ctx.container.get('database');
      if (db) {
        const { IncrementalBootstrap } = await import(
          './bootstrap/pipeline/IncrementalBootstrap.js'
        );
        const ib = new IncrementalBootstrap(db, projectRoot, { logger: ctx.logger });
        // 所有可能的维度 ID（动态维度在后面按语言过滤 + Enhancement Pack 追加）
        const allDimIds = [
          'project-profile',
          'code-standard',
          'code-pattern',
          'architecture',
          'best-practice',
          'event-and-data-flow',
          'agent-guidelines',
          // 语言条件维度
          'objc-deep-scan',
          'category-scan',
          'module-export-scan',
          'framework-convention-scan',
          'python-package-scan',
          'jvm-annotation-scan',
          'go-module-scan',
        ];
        incrementalPlan = ib.evaluate(allFiles, allDimIds);
        report.phases.incrementalEvaluation = {
          mode: incrementalPlan.mode,
          canIncremental: incrementalPlan.canIncremental,
          affectedDimensions: incrementalPlan.affectedDimensions,
          skippedDimensions: incrementalPlan.skippedDimensions,
          reason: incrementalPlan.reason,
          diff: incrementalPlan.diff
            ? {
                added: incrementalPlan.diff.added.length,
                modified: incrementalPlan.diff.modified.length,
                deleted: incrementalPlan.diff.deleted.length,
                unchanged: incrementalPlan.diff.unchanged.length,
                changeRatio: incrementalPlan.diff.changeRatio,
              }
            : null,
        };
        if (incrementalPlan.canIncremental) {
          ctx.logger.info(
            `[Bootstrap] 🔄 Incremental mode: ${incrementalPlan.affectedDimensions.length} affected, ` +
              `${incrementalPlan.skippedDimensions.length} skipped — ${incrementalPlan.reason}`
          );
        } else {
          ctx.logger.info(`[Bootstrap] Full mode: ${incrementalPlan.reason}`);
        }
      }
    } catch (incErr) {
      ctx.logger.warn(
        `[Bootstrap] Incremental evaluation failed (fallback to full): ${incErr.message}`
      );
    }
  }

  // ── 语言统计（全局一次计算，后续 Phase 共用）──────────────
  const langStats = {};
  for (const f of allFiles) {
    const ext = path.extname(f.name).replace('.', '') || 'unknown';
    langStats[ext] = (langStats[ext] || 0) + 1;
  }

  if (allFiles.length === 0) {
    return envelope({
      success: true,
      data: { report, message: 'No source files found, nothing to bootstrap' },
      meta: { tool: 'autosnippet_bootstrap', responseTimeMs: Date.now() - t0 },
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Phase 1.5: AST 代码结构分析（Tree-sitter）
  // ═══════════════════════════════════════════════════════════

  // ── Phase 1.5a: 按需安装缺失的 tree-sitter 语法包 ──────────
  let grammarInstallResult = null;
  try {
    const { ensureGrammars, inferLanguagesFromStats, reloadPlugins } = await import(
      '../../../core/ast/ensure-grammars.js'
    );
    const neededLangs = inferLanguagesFromStats(langStats);
    if (neededLangs.length > 0) {
      grammarInstallResult = await ensureGrammars(neededLangs, { logger: ctx.logger });
      if (grammarInstallResult.installed.length > 0) {
        ctx.logger.info(
          `[Bootstrap] Installed grammar packages: ${grammarInstallResult.installed.join(', ')} — reloading AST plugins`
        );
        await reloadPlugins();
      }
    }
    // 确保 AST 插件已加载（即使没有新安装语法包 — 首次启动时需要触发 loadPlugins）
    await import('../../../core/ast/index.js');
  } catch (e) {
    ctx.logger.warn(`[Bootstrap] Grammar auto-install skipped: ${e.message}`);
  }
  report.phases.grammarEnsure = grammarInstallResult || { installed: [], skipped: [], failed: [] };

  // ── Phase 1.5b: AST 分析 ──────────────────────────────────
  let astProjectSummary = null;
  let astContext = '';
  const primaryLangEarly = detectPrimaryLanguage(langStats);
  if (astIsAvailable() && primaryLangEarly) {
    try {
      const astFiles = allFiles.map((f) => ({
        name: f.name,
        relativePath: f.relativePath,
        content: f.content,
      }));

      // SFC 预处理: 支持 .vue / .svelte 等框架特有文件的 <script> 提取
      let sfcPreprocessor = null;
      try {
        const { initEnhancementRegistry } = await import('../../../core/enhancement/index.js');
        const enhReg = await initEnhancementRegistry();
        const allPacks = enhReg.all();
        // 找到第一个提供 preprocessFile 的增强包
        const preprocessPack = allPacks.find(
          (p) => typeof p.preprocessFile === 'function'
        );
        if (preprocessPack) {
          sfcPreprocessor = preprocessPack.preprocessFile.bind(preprocessPack);
        }
      } catch {
        /* Enhancement 未加载时跳过预处理 */
      }

      astProjectSummary = analyzeProject(astFiles, primaryLangEarly, {
        preprocessFile: sfcPreprocessor,
      });
      astContext = generateContextForAgent(astProjectSummary);
      ctx.logger.info(
        `[Bootstrap] AST analysis: ${astProjectSummary.classes.length} classes, ${astProjectSummary.protocols.length} protocols, ${astProjectSummary.categories.length} categories, ${Object.keys(astProjectSummary.patternStats).length} patterns`
      );
    } catch (e) {
      ctx.logger.warn(`[Bootstrap] AST analysis failed (graceful degradation): ${e.message}`);
    }
  } else {
    ctx.logger.info(
      `[Bootstrap] AST analysis skipped: tree-sitter ${astIsAvailable() ? 'available' : 'not available'}, lang=${primaryLangEarly}`
    );
  }
  report.phases.astAnalysis = {
    available: astIsAvailable(),
    classes: astProjectSummary?.classes?.length || 0,
    protocols: astProjectSummary?.protocols?.length || 0,
    categories: astProjectSummary?.categories?.length || 0,
    patterns: Object.keys(astProjectSummary?.patternStats || {}),
  };

  // ═══════════════════════════════════════════════════════════
  // Phase 1.6: AST → Code Entity Graph (代码实体关系图谱)
  // ═══════════════════════════════════════════════════════════
  let codeEntityResult = null;
  if (astProjectSummary) {
    try {
      const { CodeEntityGraph } = await import('../../../service/knowledge/CodeEntityGraph.js');
      const db = ctx.container.get('database');
      if (db) {
        const ceg = new CodeEntityGraph(db, { projectRoot });
        ceg.clearProject(); // 全量重建
        codeEntityResult = ceg.populateFromAst(astProjectSummary);
        ctx.logger.info(
          `[Bootstrap] Code Entity Graph: ${codeEntityResult.entitiesUpserted} entities, ` +
            `${codeEntityResult.edgesCreated} edges (${codeEntityResult.durationMs}ms)`
        );
      }
    } catch (e) {
      ctx.logger.warn(`[Bootstrap] Code Entity Graph failed (graceful degradation): ${e.message}`);
    }
  }
  report.phases.codeEntityGraph = {
    entities: codeEntityResult?.entitiesUpserted || 0,
    edges: codeEntityResult?.edgesCreated || 0,
    durationMs: codeEntityResult?.durationMs || 0,
  };

  // ═══════════════════════════════════════════════════════════
  // Phase 2: 依赖关系 → knowledge_edges
  // ═══════════════════════════════════════════════════════════
  let depEdgesWritten = 0;
  let depGraphData = null;
  try {
    const knowledgeGraphService = ctx.container.get('knowledgeGraphService');
    depGraphData = await discoverer.getDependencyGraph();
    if (knowledgeGraphService) {
      for (const edge of depGraphData.edges || []) {
        const result = knowledgeGraphService.addEdge(
          edge.from,
          'module',
          edge.to,
          'module',
          'depends_on',
          { weight: 1.0, source: `${discoverer.id}-bootstrap` }
        );
        if (result.success) {
          depEdgesWritten++;
        }
      }
    }
  } catch (e) {
    ctx.logger.warn(`[Bootstrap] DepGraph failed: ${e.message}`);
  }
  report.phases.dependencyGraph = { edgesWritten: depEdgesWritten };

  // Phase 2.1: Module 实体节点写入 Code Entity Graph
  if (depGraphData?.nodes?.length > 0) {
    try {
      const { CodeEntityGraph } = await import('../../../service/knowledge/CodeEntityGraph.js');
      const db = ctx.container.get('database');
      if (db) {
        const ceg = new CodeEntityGraph(db, { projectRoot });
        // populateFromSpm 接受通用的 { nodes, edges } 结构，不仅限于 SPM
        const depResult = ceg.populateFromSpm(depGraphData);
        ctx.logger.info(
          `[Bootstrap] Code Entity Graph modules: ${depResult.entitiesUpserted} entities`
        );
      }
    } catch (e) {
      ctx.logger.warn(`[Bootstrap] Code Entity Graph modules failed: ${e.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Phase 3: Guard 规则审计（初始 — Enhancement Pack 规则在 Phase 4 后补充注入）
  // ═══════════════════════════════════════════════════════════
  let guardAudit = null;
  let guardEngine = null; // 保持引用，供 Enhancement Pack 注入后二次审计
  if (!skipGuard) {
    try {
      const { GuardCheckEngine } = await import('../../../service/guard/GuardCheckEngine.js');
      const db = ctx.container.get('database');
      guardEngine = new GuardCheckEngine(db);
      const guardFiles = allFiles.map((f) => ({ path: f.path, content: f.content }));
      guardAudit = guardEngine.auditFiles(guardFiles, { scope: 'project' });

      // 写入 ViolationsStore
      try {
        const violationsStore = ctx.container.get('violationsStore');
        for (const fileResult of guardAudit.files || []) {
          if (fileResult.violations.length > 0) {
            violationsStore.appendRun({
              filePath: fileResult.filePath,
              violations: fileResult.violations,
              summary: `Bootstrap scan: ${fileResult.summary.errors}E ${fileResult.summary.warnings}W`,
            });
          }
        }
      } catch {
        /* ViolationsStore not available */
      }
    } catch (e) {
      ctx.logger.warn(`[Bootstrap] Guard audit failed: ${e.message}`);
    }
  }
  // guardAudit report 在 Enhancement Pack 注入后统一更新（见下方）
  report.totals.graphEdges = depEdgesWritten;

  const _elapsed = Date.now() - t0;

  // ═══════════════════════════════════════════════════════════
  // Phase 4: 构建响应 — filesByTarget + analysisFramework
  // ═══════════════════════════════════════════════════════════
  const targetFileMap = {};
  for (const f of allFiles) {
    if (!targetFileMap[f.targetName]) {
      targetFileMap[f.targetName] = [];
    }
    const lines = f.content.split('\n');
    targetFileMap[f.targetName].push({
      name: f.name,
      relativePath: f.relativePath,
      language: inferLang(f.name),
      totalLines: lines.length,
      priority: inferFilePriority(f.name),
      // content 仅保留在内存中供 Phase 5 异步 pipeline 使用
      // MCP 响应不包含文件内容（避免 1MB+ 响应导致 Cursor 无法处理）
      content: lines.slice(0, contentMaxLines).join('\n'),
      truncated: lines.length > contentMaxLines,
    });
  }
  // 每个 target 内按 priority 排序
  for (const tName of Object.keys(targetFileMap)) {
    const prio = { high: 0, medium: 1, low: 2 };
    targetFileMap[tName].sort((a, b) => (prio[a.priority] || 1) - (prio[b.priority] || 1));
  }

  // 当前主语言 + 语言扩展
  const primaryLang = detectPrimaryLanguage(langStats);

  // ═══════════════════════════════════════════════════════════
  // Phase 3.5: [Skill-aware] 加载 Skills 增强维度定义
  // 共享层：ChatAgent 和 MCP 外部 Agent 均可受益
  // ═══════════════════════════════════════════════════════════
  let skillContext = args.skillContext || null;
  if (!skillContext && shouldLoadSkills) {
    skillContext = loadBootstrapSkills(primaryLang, ctx.logger);
    ctx.logger.info(`[Bootstrap] Skills loaded: ${skillContext.loaded.join(', ') || 'none'}`);
  }
  const { guides: skillGuides, sectionMap: skillSections } = skillContext
    ? extractSkillDimensionGuides(skillContext)
    : { guides: {}, sectionMap: {} };
  const skillsEnhanced = Object.keys(skillGuides).length > 0;

  if (skillsEnhanced) {
    ctx.logger.info(
      `[Bootstrap] Skill dimension guides extracted for: ${Object.keys(skillGuides).join(', ')}`
    );
    // 输出每个 guide 的前 80 字符用于诊断
    for (const [dimId, guide] of Object.entries(skillGuides)) {
      ctx.logger.debug(`[Bootstrap] Skill guide [${dimId}]: ${guide.substring(0, 80)}...`);
    }
    // 输出 sectionMap 诊断
    for (const [dimId, sections] of Object.entries(skillSections)) {
      ctx.logger.debug(
        `[Bootstrap] Skill sections [${dimId}]: ${sections.length} section(s) — ${sections.map((s) => s.title).join(', ')}`
      );
    }
  } else {
    ctx.logger.warn(
      '[Bootstrap] No skill dimension guides extracted — Skills may not match expected format'
    );
  }

  report.phases.skillLoading = {
    loaded: skillContext?.loaded || [],
    dimensionsEnhanced: Object.keys(skillGuides),
    sectionCounts: Object.fromEntries(Object.entries(skillSections).map(([k, v]) => [k, v.length])),
    enabled: shouldLoadSkills || !!args.skillContext,
  };

  // 9 维度定义（Phase 4 响应 + Phase 5 候选创建共用）
  // → 从 bootstrap/base-dimensions.js 导入

  // ── 根据项目主语言和框架过滤条件维度 ──────────────────────
  const detectedFrameworks = allTargets
    .map((t) => (typeof t === 'object' ? t.framework : null))
    .filter(Boolean);
  const activeDimensions = resolveActiveDimensions(
    baseDimensions,
    primaryLang,
    detectedFrameworks
  );

  // ── Enhancement Pack 动态追加维度 + Guard 规则 ─────────────
  const enhancementPackInfo = [];
  const enhancementGuardRules = [];
  const enhancementPatterns = [];
  try {
    const { initEnhancementRegistry } = await import('../../../core/enhancement/index.js');
    const enhReg = await initEnhancementRegistry();
    const matchedPacks = enhReg.resolve(primaryLang, detectedFrameworks);
    for (const pack of matchedPacks) {
      enhancementPackInfo.push({ id: pack.id, displayName: pack.displayName });
      // 追加额外维度
      const extraDims = pack.getExtraDimensions();
      for (const dim of extraDims) {
        // 避免与 baseDimensions 中已有的 id 重复
        if (!activeDimensions.some((d) => d.id === dim.id)) {
          activeDimensions.push(dim);
        }
      }
      // 收集 Guard 规则
      const guardRules = pack.getGuardRules();
      if (guardRules.length > 0) {
        enhancementGuardRules.push(...guardRules);
      }
      // 收集 AST 模式检测
      if (astProjectSummary) {
        try {
          const patterns = pack.detectPatterns(astProjectSummary);
          if (patterns.length > 0) {
            enhancementPatterns.push(...patterns.map((p) => ({ ...p, source: pack.id })));
          }
        } catch {
          /* graceful degradation */
        }
      }
    }
    if (matchedPacks.length > 0) {
      ctx.logger.info(
        `[Bootstrap] Enhancement packs matched: ${matchedPacks.map((p) => p.id).join(', ')} → +${activeDimensions.length - baseDimensions.length} extra dims, ${enhancementGuardRules.length} guard rules, ${enhancementPatterns.length} patterns`
      );
    }
  } catch (enhErr) {
    ctx.logger.warn(`[Bootstrap] Enhancement pack loading skipped: ${enhErr.message}`);
  }

  // ── Enhancement Pack Guard 规则注入 + 补充审计 ──
  if (enhancementGuardRules.length > 0 && guardEngine) {
    try {
      guardEngine.injectExternalRules(enhancementGuardRules);
      // 补充审计：仅用新注入的 Enhancement Pack 规则重新扫描
      // 避免全量重审，只对已有 guardAudit 结果做增量合并
      const guardFiles = allFiles.map((f) => ({ path: f.path, content: f.content }));
      const enhancedAudit = guardEngine.auditFiles(guardFiles, { scope: 'project' });
      // 用包含 Enhancement Pack 规则的完整结果替换原始审计
      guardAudit = enhancedAudit;
      ctx.logger.info(
        `[Bootstrap] Guard re-audit with ${guardEngine.getExternalRuleCount()} Enhancement Pack rules → ${enhancedAudit.summary.totalViolations} total violations`
      );
    } catch (reAuditErr) {
      ctx.logger.warn(`[Bootstrap] Enhancement Pack guard re-audit failed: ${reAuditErr.message}`);
    }
  }

  report.phases.enhancementPacks = {
    matched: enhancementPackInfo,
    extraDimensions: enhancementPackInfo.length,
    guardRules: enhancementGuardRules.length,
    patterns: enhancementPatterns.length,
  };

  // ── Guard 审计报告统计（在 Enhancement Pack 注入后更新，确保包含 EP 规则结果）──
  report.phases.guardAudit = {
    totalViolations: guardAudit?.summary?.totalViolations || 0,
    filesWithViolations: (guardAudit?.files || []).filter((f) => f.violations.length > 0).length,
    skipped: skipGuard,
    enhancementRulesInjected: enhancementGuardRules.length,
  };
  report.totals.guardViolations = guardAudit?.summary?.totalViolations || 0;

  // 按项目语言画像注入差异化文案（支持多语言项目）
  const langProfile = LanguageService.detectProfile(langStats);
  DimensionCopy.applyMulti(activeDimensions, langProfile.primary, langProfile.secondary);

  // 用 Skill 内容增强维度 guide（共享层增强点）
  const dimensions = enhanceDimensions(activeDimensions, skillGuides, skillSections);

  const responseData = {
    report,
    targets: allTargets.map((t) => {
      const name = typeof t === 'string' ? t : t.name;
      return {
        name,
        type: t.type || 'target',
        packageName: t.packageName || undefined,
        inferredRole: inferTargetRole(name),
        fileCount: (targetFileMap[name] || []).length,
      };
    }),
    // 响应中只返回每个 target 的高优先级文件摘要（不含 content），
    // 避免 500+ 文件清单导致响应过大。完整文件列表保留在服务端供 Phase 5 使用。
    filesByTarget: Object.fromEntries(
      Object.entries(targetFileMap).map(([target, files]) => {
        const sorted = [...files].sort((a, b) => (b.priority || 0) - (a.priority || 0));
        const top = sorted.slice(0, 10);
        return [
          target,
          {
            totalFiles: files.length,
            topFiles: top.map(({ content, ...meta }) => meta),
            ...(files.length > 10 ? { truncated: true } : {}),
          },
        ];
      })
    ),
    dependencyGraph: depGraphData
      ? {
          nodes: (depGraphData.nodes || []).map((n) => ({
            id: typeof n === 'string' ? n : n.id,
            label: typeof n === 'string' ? n : n.label,
          })),
          edges: depGraphData.edges || [],
        }
      : null,
    languageStats: langStats,
    primaryLanguage: primaryLang,
    secondaryLanguages: langProfile.secondary,
    isMultiLang: langProfile.isMultiLang,
    languageExtension: buildLanguageExtension(primaryLang),
    guardSummary: guardAudit
      ? {
          totalViolations: guardAudit.summary?.totalViolations || 0,
          errors: guardAudit.summary?.errors || 0,
          warnings: guardAudit.summary?.warnings || 0,
        }
      : null,
    guardViolationFiles: guardAudit
      ? (guardAudit.files || [])
          .filter((f) => f.violations.length > 0)
          .map((f) => ({
            filePath: f.filePath,
            violations: f.violations.map((v) => ({
              ruleId: v.ruleId,
              severity: v.severity,
              message: v.message,
              line: v.line,
            })),
          }))
      : [],

    // 9 维度分析框架（4 Skill-only + 2 dualOutput + 3 Candidate-only）
    // 注意：anti-pattern 已移除，代码问题由 Guard 独立处理
    analysisFramework: {
      dimensions,
      skillWorthyDimensions: dimensions.filter((d) => d.skillWorthy).map((d) => d.id),
      candidateOnlyDimensions: dimensions.filter((d) => !d.skillWorthy).map((d) => d.id),
      candidateRequiredFields: [
        'title',
        'code',
        'language',
        'category',
        'knowledgeType',
        'reasoning',
      ],
      submissionTool: 'autosnippet_submit_knowledge_batch',
      expectedOutput: `候选知识（微观代码维度：code-pattern/best-practice/event-and-data-flow + 语言条件扫描）+ Project Skills（宏观叙事维度：code-standard/architecture/project-profile/agent-guidelines + 语言条件扫描）— 共 ${dimensions.length} 个维度`,
    },

    // AST 代码结构分析上下文（供 ChatAgent 使用）
    astContext: astContext || null,
    astSummary: astProjectSummary
      ? {
          classes: astProjectSummary.classes.length,
          protocols: astProjectSummary.protocols.length,
          categories: astProjectSummary.categories.length,
          patterns: Object.keys(astProjectSummary.patternStats || {}),
          metrics: astProjectSummary.projectMetrics
            ? {
                totalMethods: astProjectSummary.projectMetrics.totalMethods,
                avgMethodsPerClass: astProjectSummary.projectMetrics.avgMethodsPerClass,
                maxNestingDepth: astProjectSummary.projectMetrics.maxNestingDepth,
                complexMethods: astProjectSummary.projectMetrics.complexMethods?.length || 0,
                longMethods: astProjectSummary.projectMetrics.longMethods?.length || 0,
              }
            : null,
        }
      : null,

    // Enhancement Pack 检测到的额外模式
    enhancementPacks:
      enhancementPackInfo.length > 0
        ? {
            matched: enhancementPackInfo,
            patterns: enhancementPatterns,
            guardRules: enhancementGuardRules.length,
          }
        : null,

    // 引导 Agent 下一步操作
    nextSteps: [
      `✅ Bootstrap 骨架已创建，${dimensions.length} 个维度的 AI 分析任务已在后台启动。`,
      '',
      '== 后台自动执行中 ==',
      '后台 AI pipeline 正在逐维度分析代码并创建候选（Analyst → Producer 双 Agent 模式）。',
      '进度通过 Dashboard 实时展示，无需手动操作。',
      '',
      '== 完成后可执行的后续操作 ==',
      '1. 调用 autosnippet_enrich_candidates(candidateIds) 补全候选缺失字段',
      '2. 调用 autosnippet_bootstrap({ operation: "refine" }) 对候选进行 AI 精炼',
      '3. 使用 autosnippet_submit_knowledge_batch 手动提交更多知识条目',
      '4. 使用 autosnippet_skill({ operation: "load", name }) 加载自动生成的 Project Skills',
      '',
      '== 宏观维度 → Project Skills ==',
      `宏观维度（${dimensions
        .filter((d) => d.skillWorthy)
        .map((d) => d.id)
        .join('/')}）`,
      '自动生成 Project Skill 到 AutoSnippet/skills/，可通过 autosnippet_skill({ operation: "load" }) 加载。',
    ],
  };

  // ═══════════════════════════════════════════════════════════
  // Phase 5: 创建异步任务 — 骨架先返回，内容后填充
  //
  // 策略变更（v5）：
  //   旧：同步遍历所有维度 → 提取 + 创建 Candidate → 一次性返回
  //   新：快速创建任务清单 → 立即返回骨架 → 异步逐维度填充内容
  //       前端通过 Socket.io 接收进度更新，卡片 loading → 完成
  // ═══════════════════════════════════════════════════════════

  // 构建任务定义列表
  const taskDefs = dimensions.map((dim) => ({
    id: dim.id,
    meta: {
      type: dim.skillWorthy ? 'skill' : 'candidate',
      dimId: dim.id,
      label: dim.label,
      skillWorthy: !!dim.skillWorthy,
      skillMeta: dim.skillMeta || null,
    },
  }));

  // 启动 BootstrapTaskManager 会话（通过正式 DI 获取单例）
  let bootstrapSession = null;
  try {
    const taskManager = ctx.container.get('bootstrapTaskManager');
    bootstrapSession = taskManager.startSession(taskDefs);
  } catch (e) {
    ctx.logger.warn(
      `[Bootstrap] BootstrapTaskManager init failed (graceful degradation): ${e.message}`
    );
  }

  // 立即构建骨架响应
  responseData.bootstrapSession = bootstrapSession ? bootstrapSession.toJSON() : null;
  responseData.bootstrapCandidates = { created: 0, failed: 0, errors: [], status: 'filling' };
  responseData.autoSkills = { created: 0, failed: 0, skills: [], errors: [], status: 'filling' };
  responseData.skillsLoaded = skillContext?.loaded || [];
  responseData.skillsEnhanced = skillsEnhanced;
  responseData.message = `Bootstrap 骨架已创建: ${allFiles.length} files, ${allTargets.length} targets, ${taskDefs.length} 个维度任务已排队，正在后台逐一填充...`;

  // ── 异步后台填充（fire-and-forget）──
  const fillContext = {
    ctx,
    dimensions,
    allFiles,
    targetFileMap,
    depGraphData,
    guardAudit,
    langStats,
    primaryLang,
    astProjectSummary,
    skillContext,
    skillsEnhanced,
    taskManager: (() => {
      try {
        return ctx.container.get('bootstrapTaskManager');
      } catch {
        return null;
      }
    })(),
    sessionId: bootstrapSession?.id || null,
    projectRoot,
    // v5.0: 增量 Bootstrap 计划
    incrementalPlan,
  };

  // 使用 setImmediate 避免阻塞 HTTP 响应
  setImmediate(() => {
    ctx.logger.info(`[Bootstrap] Dispatching v3 AI-First pipeline`);
    fillDimensionsV3(fillContext).catch((e) => {
      ctx.logger.error(`[Bootstrap] Async fill (v3) failed: ${e.message}`);
    });
  });

  // ── SkillHooks: onBootstrapStarted (fire-and-forget) ──
  try {
    const skillHooks = ctx.container.get('skillHooks');
    skillHooks
      .run(
        'onBootstrapComplete',
        {
          filesScanned: allFiles.length,
          targetsFound: allTargets.length,
          candidatesCreated: 0, // 异步填充中，初始为 0
          candidatesFailed: 0,
          autoSkillsCreated: 0,
          autoSkills: [],
        },
        { projectRoot: ctx.container.get('database')?.filename || '' }
      )
      .catch(() => {}); // fire-and-forget
  } catch {
    /* skillHooks not available */
  }

  return envelope({
    success: true,
    data: responseData,
    meta: { tool: 'autosnippet_bootstrap', responseTimeMs: Date.now() - t0 },
  });
}

// bootstrapRefine → 已提取到 bootstrap/refine.js（通过顶部 re-export）
