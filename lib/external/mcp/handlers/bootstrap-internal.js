/**
 * MCP Handlers — Bootstrap 冷启动知识库初始化 (内部 Agent 路径)
 *
 * ⚠️ 本文件是「内部 Agent」冷启动路径 — 由 AutoSnippet 内置的 Analyst/Producer
 *    双 Agent AI pipeline 自动完成知识提取。需要配置 AI Provider (API Key)。
 *
 * 调用方:
 *   - CLI: `asd bootstrap --knowledge`
 *   - ChatAgent: `bootstrapKnowledgeTool` (infrastructure.js)
 *   - Dashboard HTTP: POST /api/bootstrap/knowledge
 *
 * 外部 Agent 路径（Cursor/Copilot 等 IDE Agent）请参见:
 *   - bootstrap-external.js  — 无参数 Mission Briefing 入口
 *   - dimension-complete.js  — 维度完成通知
 *   外部 Agent 使用 read_file/grep_search 等原生能力自行分析代码，
 *   不经过本文件的 Phase 5 AI pipeline。
 *
 * 内部 Agent 架构 (v5 + Async Fill):
 *
 * 同步阶段（快速返回，~1-3s）:
 *   Phase 1   → 文件收集（SPM Target 源文件扫描）
 *   Phase 1.5 → AST 代码结构分析（Tree-sitter）
 *   Phase 2   → SPM 依赖关系 → knowledge_edges（模块级图谱）
 *   Phase 3   → Guard 规则审计
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
 *   bootstrap.js              ← 内部 Agent 主入口 (本文件)
 *   bootstrap-external.js     ← 外部 Agent 主入口 (Mission Briefing)

 *   bootstrap/patterns.js     ← 多语言代码模式匹配（内部 Agent 专用）
 *   bootstrap/dimensions.js   ← 7 维度知识提取器（内部 Agent 专用）
 *   bootstrap/projectSkills.js ← Phase 5.5 Project Skill 生成（内部 Agent 专用）
 */

import { envelope } from '../envelope.js';
import {
  clearCheckpoints,
  clearSnapshots,
  fillDimensionsV3,
} from './bootstrap/pipeline/orchestrator.js';
import { bootstrapRefine } from './bootstrap/refine.js';
import { buildInternalNextSteps } from './bootstrap/shared/dimension-text.js';
import { runAllPhases } from './bootstrap/shared/bootstrap-phases.js';
import { buildLanguageExtension, inferLang } from './LanguageExtensions.js';
import { inferFilePriority, inferTargetRole } from './TargetClassifier.js';
import { getInternalAgentRequiredFields } from '../../../shared/FieldSpec.js';

export { bootstrapRefine };

/**
 * bootstrapKnowledge — 一键初始化知识库 (Skill-aware)
 *
 * 覆盖 7 大知识维度: 项目规范、使用习惯、架构模式、代码模式、最佳实践、项目库特征、Agent开发注意事项
 * （注意：反模式/代码问题由 Guard 独立处理，不在 Bootstrap 覆盖范围）
 * 为每个维度自动创建 Candidate（PENDING），由内置 Analyst/Producer pipeline 分析代码。
 *
 * ⚠️ 本函数是内部 Agent 路径。外部 Agent 使用 bootstrap-external.js 的 Mission Briefing + dimension_complete 流程。
 *
 * @param {object} ctx  { container, logger }
 * @param {object} args
 * @param {number} [args.maxFiles=500] 最大扫描文件数
 * @param {boolean} [args.skipGuard=false] 是否跳过 Guard 审计
 * @param {number} [args.contentMaxLines=120] 每文件读取最大行数
 * @param {boolean} [args.incremental=true] 是否启用增量 Bootstrap (自动检测变更, 仅重跑受影响维度)
 */
export async function bootstrapKnowledge(ctx, args) {
  const t0 = Date.now();
  const projectRoot = process.env.ASD_PROJECT_DIR || process.cwd();

  // v5.0: 增量 Bootstrap 开关 (默认启用, 自动检测是否可增量)
  const enableIncremental = args.incremental !== false;
  const maxFiles = args.maxFiles || 500;
  const skipGuard = args.skipGuard || false;
  const contentMaxLines = args.contentMaxLines || 120;

  // ═══════════════════════════════════════════════════════════
  // Phase 1-4: 共享管线（文件收集→AST→依赖→Guard→维度解析）
  // ═══════════════════════════════════════════════════════════
  const phaseResults = await runAllPhases(projectRoot, ctx, {
    maxFiles,
    skipGuard,
    clearOldData: true,
    generateReport: true,
    generateAstContext: true,
    incremental: enableIncremental,
    sourceTag: 'bootstrap',
  });

  if (phaseResults.isEmpty) {
    return envelope({
      success: true,
      data: { report: phaseResults.report, message: 'No source files found, nothing to bootstrap' },
      meta: { tool: 'autosnippet_bootstrap', responseTimeMs: Date.now() - t0 },
    });
  }

  const {
    allFiles, allTargets, discoverer, langStats, primaryLang,
    astProjectSummary, astContext,
    depGraphData, depEdgesWritten,
    guardAudit, guardEngine,
    activeDimensions, enhancementPackInfo, enhancementPatterns, enhancementGuardRules,
    langProfile, targetsSummary, incrementalPlan, detectedFrameworks,
    warnings: phaseWarnings, report: phaseReport,
  } = phaseResults;

  // 构建兼容的 report 对象（保持原有 API 格式）
  const report = {
    phases: {
      fileCollection: {
        discoverer: discoverer.id,
        discovererName: discoverer.displayName,
        targets: allTargets.length,
        files: allFiles.length,
        truncated: allFiles.length >= maxFiles,
      },
      incrementalEvaluation: incrementalPlan ? {
        mode: incrementalPlan.mode,
        canIncremental: incrementalPlan.canIncremental,
        affectedDimensions: incrementalPlan.affectedDimensions,
        skippedDimensions: incrementalPlan.skippedDimensions,
        reason: incrementalPlan.reason,
        diff: incrementalPlan.diff ? {
          added: incrementalPlan.diff.added.length,
          modified: incrementalPlan.diff.modified.length,
          deleted: incrementalPlan.diff.deleted.length,
          unchanged: incrementalPlan.diff.unchanged.length,
          changeRatio: incrementalPlan.diff.changeRatio,
        } : null,
      } : undefined,
      astAnalysis: {
        classes: astProjectSummary?.classes?.length || 0,
        protocols: astProjectSummary?.protocols?.length || 0,
        categories: astProjectSummary?.categories?.length || 0,
        patterns: Object.keys(astProjectSummary?.patternStats || {}),
      },
      codeEntityGraph: phaseReport?.phases?.entityGraph || { entities: 0, edges: 0, durationMs: 0 },
      dependencyGraph: { edgesWritten: depEdgesWritten || 0 },
      enhancementPacks: {
        matched: enhancementPackInfo,
        extraDimensions: enhancementPackInfo.length,
        guardRules: enhancementGuardRules?.length || 0,
        patterns: enhancementPatterns?.length || 0,
      },
      guardAudit: {
        totalViolations: guardAudit?.summary?.totalViolations || 0,
        filesWithViolations: (guardAudit?.files || []).filter((f) => f.violations.length > 0).length,
        skipped: skipGuard,
        enhancementRulesInjected: enhancementGuardRules?.length || 0,
      },
    },
    totals: {
      files: allFiles.length,
      graphEdges: depEdgesWritten || 0,
      guardViolations: guardAudit?.summary?.totalViolations || 0,
    },
  };

  // ═══════════════════════════════════════════════════════════
  // Phase 4.5: 构建响应 — filesByTarget + analysisFramework
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

  const dimensions = activeDimensions;

  const responseData = {
    report,
    targets: targetsSummary || allTargets.map((t) => {
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
      candidateRequiredFields: getInternalAgentRequiredFields(),
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

    // 引导 Agent 下一步操作（共享文本层）
    nextSteps: buildInternalNextSteps(dimensions),
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
