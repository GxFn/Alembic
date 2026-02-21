/**
 * orchestrator.js — AI-First Bootstrap 管线
 *
 * 核心架构: Analyst → Gate → Producer (双 Agent 模式)
 *
 * 1. Analyst Agent 自由探索代码 (AST 工具 + 文件搜索)
 * 2. HandoffProtocol 质量门控
 * 3. Producer Agent 格式化输出 (submit_knowledge)
 * 4. TierScheduler 分层并行执行
 *
 * @module pipeline/orchestrator
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import Logger from '../../../../../infrastructure/logging/Logger.js';
import { AnalystAgent } from '../../../../../service/chat/AnalystAgent.js';
import { EpisodicConsolidator } from '../../../../../service/chat/EpisodicConsolidator.js';
import { ProducerAgent } from '../../../../../service/chat/ProducerAgent.js';
import { ProjectSemanticMemory } from '../../../../../service/chat/ProjectSemanticMemory.js';
import { WorkingMemory } from '../../../../../service/chat/WorkingMemory.js';
import { DimensionContext, parseDimensionDigest } from './dimension-context.js';
import { EpisodicMemory } from './EpisodicMemory.js';
import { IncrementalBootstrap } from './IncrementalBootstrap.js';
import { ToolResultCache } from './ToolResultCache.js';
import { TierScheduler } from './tier-scheduler.js';

const logger = Logger.getInstance();

// ──────────────────────────────────────────────────────────────────
// P3: 断点续传 — Checkpoint 存储/恢复
// ──────────────────────────────────────────────────────────────────

const CHECKPOINT_TTL_MS = 3600_000; // 1小时内有效

/**
 * 保存维度级 checkpoint
 * @param {string} projectRoot
 * @param {string} sessionId
 * @param {string} dimId
 * @param {object} result — 维度执行结果
 * @param {object} [digest] — DimensionDigest
 */
async function saveDimensionCheckpoint(projectRoot, sessionId, dimId, result, digest = null) {
  try {
    const checkpointDir = path.join(projectRoot, '.autosnippet', 'bootstrap-checkpoint');
    await fs.mkdir(checkpointDir, { recursive: true });
    await fs.writeFile(
      path.join(checkpointDir, `${dimId}.json`),
      JSON.stringify({ dimId, sessionId, ...result, digest, completedAt: Date.now() })
    );
  } catch (err) {
    logger.warn(`[Bootstrap-v3] checkpoint save failed for "${dimId}": ${err.message}`);
  }
}

/**
 * 加载有效的 checkpoints
 * @param {string} projectRoot
 * @returns {Promise<Map<string, object>>} dimId → checkpoint data
 */
async function loadCheckpoints(projectRoot) {
  const checkpoints = new Map();
  try {
    const checkpointDir = path.join(projectRoot, '.autosnippet', 'bootstrap-checkpoint');
    const files = await fs.readdir(checkpointDir).catch(() => []);
    const now = Date.now();
    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      try {
        const content = await fs.readFile(path.join(checkpointDir, file), 'utf-8');
        const data = JSON.parse(content);
        if (data.completedAt && now - data.completedAt < CHECKPOINT_TTL_MS) {
          checkpoints.set(data.dimId, data);
        }
      } catch {
        /* skip corrupt checkpoint */
      }
    }
  } catch {
    /* checkpoint dir doesn't exist */
  }
  return checkpoints;
}

/**
 * 清理 checkpoint 目录
 * @param {string} projectRoot
 */
async function clearCheckpoints(projectRoot) {
  try {
    const checkpointDir = path.join(projectRoot, '.autosnippet', 'bootstrap-checkpoint');
    await fs.rm(checkpointDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ──────────────────────────────────────────────────────────────────
// v3.0 维度配置 (增加 focusAreas 用于 Analyst prompt)
// ──────────────────────────────────────────────────────────────────

const DIMENSION_CONFIGS_V3 = {
  'project-profile': {
    label: '项目概貌',
    guide: '分析项目的整体结构、技术栈、模块划分和入口点。',
    focusAreas: ['项目结构和模块划分', '技术栈和框架依赖', '核心入口点和启动流程'],
    outputType: 'dual',
    allowedKnowledgeTypes: ['architecture'],
  },
  'objc-deep-scan': {
    label: '深度扫描（常量/Hook）',
    guide: '扫描 #define 宏、extern/static 常量、Method Swizzling hook。',
    focusAreas: [
      '#define 值宏和函数宏',
      'extern/static 常量定义',
      'Method Swizzling hook 和 load/initialize 方法',
    ],
    outputType: 'dual',
    allowedKnowledgeTypes: ['code-standard', 'code-pattern'],
  },
  'category-scan': {
    label: '基础类分类方法扫描',
    guide: '扫描 Foundation/UIKit 的 Category/Extension 方法及其实现。',
    focusAreas: [
      'NSString/NSArray/NSDictionary 等基础类的 Category',
      'UIView/UIColor/UIImage 等 UI 组件的 Category',
      '各 Category 方法的使用场景和频率',
    ],
    outputType: 'dual',
    allowedKnowledgeTypes: ['code-standard', 'code-pattern'],
  },
  'code-standard': {
    label: '代码规范',
    guide: '分析项目的命名约定、注释风格、文件组织方式。',
    focusAreas: [
      '类名前缀和命名约定 (BD/BDUIKit 等)',
      '方法签名风格和 API 命名',
      '注释风格 (语言/格式/MARK 分段)',
      '文件组织和目录规范',
    ],
    outputType: 'dual',
    allowedKnowledgeTypes: ['code-standard', 'code-style'],
  },
  architecture: {
    label: '架构模式',
    guide: '分析项目的分层架构、模块职责和依赖关系。',
    focusAreas: [
      '分层架构 (MVC/MVVM/其他)',
      '模块间通信方式 (Protocol/Notification/Target-Action)',
      '依赖管理和服务注册',
      '模块边界约束',
    ],
    outputType: 'dual',
    allowedKnowledgeTypes: ['architecture', 'module-dependency', 'boundary-constraint'],
  },
  'code-pattern': {
    label: '设计模式',
    guide: '识别项目中使用的设计模式和架构模式。',
    focusAreas: [
      '创建型模式 (Singleton, Factory, Builder)',
      '结构型模式 (Proxy, Adapter, Decorator, Composite)',
      '行为型模式 (Observer, Strategy, Template Method, Delegate)',
      '架构模式 (MVC/MVVM, Service Locator, Coordinator)',
    ],
    outputType: 'candidate',
    allowedKnowledgeTypes: ['code-pattern', 'code-relation', 'inheritance'],
  },
  'event-and-data-flow': {
    label: '事件与数据流',
    guide: '分析事件传播和数据状态管理方式。',
    focusAreas: [
      '事件传播 (Delegate/Notification/Block/Target-Action)',
      '数据状态管理 (KVO/属性观察/响应式)',
      '数据持久化方案',
      '数据流转路径和状态同步',
    ],
    outputType: 'candidate',
    allowedKnowledgeTypes: ['call-chain', 'data-flow', 'event-and-data-flow'],
  },
  'best-practice': {
    label: '最佳实践',
    guide: '分析错误处理、并发安全、内存管理等工程实践。',
    focusAreas: [
      '错误处理策略和模式',
      '并发安全 (GCD/NSOperation/锁)',
      '内存管理 (ARC 下的弱引用/循环引用处理)',
      '日志规范和调试基础设施',
    ],
    outputType: 'candidate',
    allowedKnowledgeTypes: ['best-practice'],
  },
  'agent-guidelines': {
    label: 'Agent 开发注意事项',
    guide: '总结 Agent 在此项目开发时必须遵守的规则和约束。',
    focusAreas: [
      '命名强制规则和前缀约定',
      '线程安全约束',
      '已废弃 API 标记',
      '架构约束注释 (TODO/FIXME)',
    ],
    outputType: 'skill',
    allowedKnowledgeTypes: ['boundary-constraint', 'code-standard'],
  },

  // ── 语言条件维度（v3.1: 多语言支持）──────────────────────

  'module-export-scan': {
    label: '模块导出分析',
    guide: '分析 TS/JS 模块的导出结构和 public API surface。',
    focusAreas: [
      'barrel export 结构和 re-export 链路',
      'public API surface 合规性',
      'tree-shaking 兼容性',
      '循环依赖检测',
    ],
    outputType: 'dual',
    allowedKnowledgeTypes: ['code-standard', 'architecture'],
  },
  'framework-convention-scan': {
    label: '框架约定扫描',
    guide: '分析前端框架约定（组件结构、状态管理、路由）。',
    focusAreas: [
      '组件目录结构和命名约定',
      '状态管理模式 (Redux/Vuex/Pinia/Zustand)',
      '路由约定和数据获取模式',
      '样式约定 (CSS Module/Tailwind/CSS-in-JS)',
    ],
    outputType: 'dual',
    allowedKnowledgeTypes: ['code-standard', 'architecture'],
  },
  'python-package-scan': {
    label: 'Python 包结构分析',
    guide: '分析 Python 包的导入风格、类型标注和 __init__.py 策略。',
    focusAreas: [
      '__init__.py 导出策略和 __all__ 定义',
      '相对/绝对导入风格',
      'type hints 覆盖率和 Protocol 使用',
      'decorator 使用模式',
    ],
    outputType: 'dual',
    allowedKnowledgeTypes: ['code-standard', 'architecture'],
  },
  'jvm-annotation-scan': {
    label: '注解/Annotation 扫描',
    guide: '扫描 Java/Kotlin 项目中的 DI、ORM、API 注解使用模式。',
    focusAreas: [
      'DI 注解 (@Inject/@Autowired/@Component)',
      'ORM 注解 (@Entity/@Table/@Column)',
      'API 注解 (@RestController/@RequestMapping)',
      '自定义注解和元编程模式',
    ],
    outputType: 'dual',
    allowedKnowledgeTypes: ['code-pattern', 'architecture'],
  },
};

// ──────────────────────────────────────────────────────────────────
// v4.0: Tier Reflection — 综合分析 (规则化, 不需要 AI)
// ──────────────────────────────────────────────────────────────────

/**
 * 构建 Tier 级 Reflection — 在每个 Tier 完成后调用
 *
 * 无需 AI 调用，通过规则化聚合维度发现:
 * - 收集所有维度的关键发现并按重要性排序
 * - 检测跨维度重复模式
 * - 为下一 Tier 生成建议
 *
 * @param {number} tierIndex — Tier 索引 (0-based)
 * @param {Map<string, object>} tierResults — 本 Tier 的维度结果
 * @param {import('./EpisodicMemory.js').EpisodicMemory} episodicMemory
 * @returns {object} TierReflection
 */
function buildTierReflection(tierIndex, tierResults, episodicMemory) {
  const completedDimensions = [...tierResults.keys()];

  // 收集本 Tier 所有维度的 findings
  const allFindings = [];
  for (const dimId of completedDimensions) {
    const report = episodicMemory.getDimensionReport(dimId);
    if (report?.findings) {
      for (const f of report.findings) {
        allFindings.push({ dimId, ...f });
      }
    }
  }

  // Top findings by importance
  const topFindings = allFindings
    .sort((a, b) => (b.importance || 5) - (a.importance || 5))
    .slice(0, 10);

  // 检测跨维度模式 (多个维度提到同一文件/关键词)
  const fileMentions = {};
  const keywordMentions = {};

  for (const f of allFindings) {
    // 统计文件引用频率
    if (f.evidence) {
      const file = f.evidence.split(':')[0];
      if (file) {
        fileMentions[file] = (fileMentions[file] || 0) + 1;
      }
    }
    // 统计关键词
    const words = (f.finding || '').split(/[\s,，。.]+/).filter((w) => w.length > 3);
    for (const w of words) {
      keywordMentions[w] = (keywordMentions[w] || 0) + 1;
    }
  }

  const crossDimensionPatterns = [];

  // 多维度引用的文件 = 跨维度热点
  for (const [file, count] of Object.entries(fileMentions)) {
    if (count >= 2) {
      crossDimensionPatterns.push(`文件 "${file}" 被 ${count} 个维度引用 — 可能是系统核心组件`);
    }
  }

  // 多维度提及的关键词
  for (const [word, count] of Object.entries(keywordMentions)) {
    if (count >= 3) {
      crossDimensionPatterns.push(`关键词 "${word}" 出现 ${count} 次 — 跨维度关联主题`);
    }
  }

  // 为下一 Tier 生成建议
  const suggestionsForNextTier = [];

  // 找出 gaps (各维度报告的未覆盖方面)
  for (const dimId of completedDimensions) {
    const report = episodicMemory.getDimensionReport(dimId);
    const gaps = report?.digest?.gaps || [];
    for (const gap of gaps) {
      if (gap && typeof gap === 'string' && gap.length > 5) {
        suggestionsForNextTier.push(`[${dimId}] 未覆盖: ${gap}`);
      }
    }
  }

  // remainingTasks
  for (const dimId of completedDimensions) {
    const report = episodicMemory.getDimensionReport(dimId);
    const remaining = report?.digest?.remainingTasks || [];
    for (const task of remaining) {
      if (task?.signal) {
        suggestionsForNextTier.push(
          `[${dimId}] 遗留信号: ${task.signal} (${task.reason || '未处理'})`
        );
      }
    }
  }

  return {
    tierIndex,
    completedDimensions,
    topFindings,
    crossDimensionPatterns: crossDimensionPatterns.slice(0, 5),
    suggestionsForNextTier: suggestionsForNextTier.slice(0, 8),
  };
}

// ──────────────────────────────────────────────────────────────────
// fillDimensionsV3 — v3.0 管线入口
// ──────────────────────────────────────────────────────────────────

/**
 * fillDimensionsV3 — v3.0 AI-First 维度填充管线
 *
 * @param {object} fillContext — 由 bootstrapKnowledge 构建的上下文
 */
export async function fillDimensionsV3(fillContext) {
  const {
    ctx,
    dimensions,
    taskManager,
    sessionId,
    projectRoot,
    depGraphData,
    guardAudit,
    primaryLang,
    astProjectSummary,
    incrementalPlan, // v5.0: 增量 Bootstrap 计划 (from bootstrap.js)
  } = fillContext;

  const isIncremental = incrementalPlan?.canIncremental && incrementalPlan?.mode === 'incremental';
  logger.info(
    `[Bootstrap-v3] ═══ fillDimensionsV3 entered — ${isIncremental ? 'INCREMENTAL' : 'FULL'} pipeline`
  );

  let allFiles = fillContext.allFiles;
  fillContext.allFiles = null;

  // ═══════════════════════════════════════════════════════════
  // Step 0: AI 可用性检查
  // ═══════════════════════════════════════════════════════════
  let chatAgent = null;
  try {
    chatAgent = ctx.container.get('chatAgent');
    if (chatAgent && !chatAgent.hasRealAI) {
      chatAgent = null;
    }
    if (chatAgent) {
      chatAgent.resetGlobalSubmittedTitles();
    }
  } catch {
    /* not available */
  }

  if (!chatAgent) {
    logger.info('[Bootstrap-v3] AI not available — aborting v3 pipeline');
    taskManager?.emitProgress('bootstrap:ai-unavailable', {
      message: 'AI 不可用，v3 管线需要 AI。请检查 AI Provider 配置。',
    });
    for (const dim of dimensions) {
      taskManager?.markTaskCompleted(dim.id, { type: 'skipped', reason: 'ai-unavailable' });
    }
    return;
  }

  // ═══════════════════════════════════════════════════════════
  // Step 0.5: 构建 ProjectGraph
  // ═══════════════════════════════════════════════════════════
  let projectGraph = null;
  try {
    projectGraph = await ctx.container.buildProjectGraph(projectRoot, {
      maxFiles: 500,
      timeoutMs: 15_000,
    });
    if (projectGraph) {
      const overview = projectGraph.getOverview();
      logger.info(
        `[Bootstrap-v3] ProjectGraph: ${overview.totalClasses} classes, ${overview.totalProtocols} protocols (${overview.buildTimeMs}ms)`
      );
    }
  } catch (e) {
    logger.warn(`[Bootstrap-v3] ProjectGraph build failed: ${e.message}`);
  }

  // ═══════════════════════════════════════════════════════════
  // Step 1: 构建 Agents + 上下文
  // ═══════════════════════════════════════════════════════════
  const analystAgent = new AnalystAgent(chatAgent, projectGraph, { maxRetries: 1 });
  const producerAgent = new ProducerAgent(chatAgent);

  // 注入文件缓存
  chatAgent.setFileCache(allFiles);

  // 项目信息
  const projectInfo = {
    name: path.basename(projectRoot),
    lang: primaryLang || 'unknown',
    fileCount: allFiles?.length || 0,
  };

  // 跨维度上下文 (保留 DimensionContext 用于兼容)
  const dimContext = new DimensionContext({
    projectName: projectInfo.name,
    primaryLang: projectInfo.lang,
    fileCount: projectInfo.fileCount,
    targetCount: Object.keys(fillContext.targetFileMap || {}).length,
    modules: Object.keys(fillContext.targetFileMap || {}),
    depGraph: depGraphData || null,
    astMetrics: astProjectSummary?.projectMetrics || null,
    guardSummary: guardAudit?.summary || null,
  });

  // v4.0: EpisodicMemory — 替代 DimensionContext 提供更丰富的跨维度上下文
  // v5.0: 增量模式下从快照恢复已完成维度的记忆
  let episodicMemory;
  if (isIncremental && incrementalPlan.restoredEpisodic) {
    episodicMemory = incrementalPlan.restoredEpisodic;
    const restoredDims = episodicMemory.getCompletedDimensions();
    logger.info(
      `[Bootstrap-v3] Restored EpisodicMemory: ${restoredDims.length} dims [${restoredDims.join(', ')}]`
    );

    // 同步恢复 DimensionContext 的 digests (兼容)
    for (const dimId of restoredDims) {
      const report = episodicMemory.getDimensionReport(dimId);
      if (report?.digest) {
        dimContext.addDimensionDigest(dimId, report.digest);
      }
    }
  } else {
    episodicMemory = new EpisodicMemory({
      projectName: projectInfo.name,
      primaryLang: projectInfo.lang,
      fileCount: projectInfo.fileCount,
      modules: Object.keys(fillContext.targetFileMap || {}),
    });
  }

  // v4.0: ToolResultCache — 跨维度工具结果缓存 (search/read 去重)
  const toolResultCache = new ToolResultCache();

  // v4.1: ProjectSemanticMemory — 项目级永久语义记忆 (Tier 3)
  // 加载历史 bootstrap 记忆 → 注入 AnalystAgent prompt
  let semanticMemory = null;
  try {
    const db = ctx.container.get('database');
    if (db) {
      semanticMemory = new ProjectSemanticMemory(db, { logger });
      const smStats = semanticMemory.getStats();
      if (smStats.total > 0) {
        logger.info(
          `[Bootstrap-v3] Loaded ${smStats.total} semantic memories from previous bootstrap ` +
            `(fact: ${smStats.byType.fact || 0}, insight: ${smStats.byType.insight || 0}, preference: ${smStats.byType.preference || 0})`
        );
      }
    }
  } catch (smErr) {
    logger.warn(`[Bootstrap-v3] SemanticMemory init failed (non-blocking): ${smErr.message}`);
  }

  // Phase E: CodeEntityGraph — 代码实体关系图谱 (供 Analyst prompt 注入)
  let codeEntityGraphInst = null;
  try {
    const { CodeEntityGraph } = await import('../../../../../service/knowledge/CodeEntityGraph.js');
    const db = ctx.container.get('database');
    if (db) {
      codeEntityGraphInst = new CodeEntityGraph(db, { projectRoot, logger });
      const topo = codeEntityGraphInst.getTopology();
      if (topo.totalEntities > 0) {
        logger.info(
          `[Bootstrap-v3] CodeEntityGraph: ${topo.totalEntities} entities, ${topo.totalEdges} edges`
        );
      }
    }
  } catch (cegErr) {
    logger.warn(`[Bootstrap-v3] CodeEntityGraph init failed (non-blocking): ${cegErr.message}`);
  }

  // ═══════════════════════════════════════════════════════════
  // Step 2: 按维度分层执行 (Analyst → Gate → Producer)
  // ═══════════════════════════════════════════════════════════
  const concurrency = parseInt(process.env.ASD_PARALLEL_CONCURRENCY || '3', 10);
  const enableParallel = process.env.ASD_PARALLEL_BOOTSTRAP !== 'false';
  const scheduler = new TierScheduler();

  // 包含所有维度（含 Enhancement Pack 动态追加的维度）
  const activeDimIds = dimensions.map((d) => d.id);

  // v5.0: 增量模式 — 仅执行受影响维度, 跳过未变更维度
  const incrementalSkippedDims = [];
  if (isIncremental) {
    const affected = new Set(incrementalPlan.affectedDimensions);
    for (const dimId of activeDimIds) {
      if (!affected.has(dimId) && incrementalPlan.skippedDimensions.includes(dimId)) {
        incrementalSkippedDims.push(dimId);
        // 标记为已完成 (使用历史结果)
        taskManager?.markTaskCompleted(dimId, {
          type: 'incremental-restored',
          reason: 'no-change-detected',
        });
      }
    }
    if (incrementalSkippedDims.length > 0) {
      logger.info(
        `[Bootstrap-v3] ⏩ Incremental skip: [${incrementalSkippedDims.join(', ')}] ` +
          `(using historical results)`
      );
    }
  }

  logger.info(
    `[Bootstrap-v3] Active dimensions: [${activeDimIds.join(', ')}], concurrency=${enableParallel ? concurrency : 1}${isIncremental ? `, incremental skip: [${incrementalSkippedDims.join(', ')}]` : ''}`
  );

  // ── P3: 断点续传 — 加载有效 checkpoints ──
  const completedCheckpoints = await loadCheckpoints(projectRoot);
  const skippedDims = [];
  for (const [dimId, checkpoint] of completedCheckpoints) {
    if (activeDimIds.includes(dimId)) {
      // 恢复 DimensionContext 中的 digest
      if (checkpoint.digest) {
        dimContext.addDimensionDigest(dimId, checkpoint.digest);
        // v4.0: 同步恢复到 EpisodicMemory
        episodicMemory.addDimensionDigest(dimId, checkpoint.digest);
      }
      taskManager?.markTaskCompleted(dimId, {
        type: 'checkpoint-restored',
        ...checkpoint,
      });
      skippedDims.push(dimId);
      logger.info(`[Bootstrap-v3] ⏩ 跳过已完成维度 (checkpoint): "${dimId}"`);
    }
  }

  const candidateResults = { created: 0, failed: 0, errors: [] };
  const dimensionCandidates = {};
  const dimensionStats = {}; // P4.2: 维度级统计

  /**
   * 执行单个维度: Analyst → Gate → Producer
   */
  async function executeDimension(dimId) {
    // v5.0: 增量模式 — 跳过未受影响的维度 (使用历史 EpisodicMemory)
    if (incrementalSkippedDims.includes(dimId)) {
      const report = episodicMemory.getDimensionReport(dimId);
      const dimResult = {
        candidateCount: report?.candidatesSummary?.length || 0,
        rejectedCount: 0,
        analysisChars: report?.analysisText?.length || 0,
        referencedFiles: report?.referencedFiles?.length || 0,
        referencedFilesList: report?.referencedFiles || [],
        durationMs: 0,
        toolCallCount: 0,
        tokenUsage: { input: 0, output: 0 },
        skipped: true,
        restoredFromIncremental: true,
      };
      dimensionStats[dimId] = dimResult;
      logger.info(`[Bootstrap-v3] ⏩ "${dimId}" — incremental skip (historical result)`);
      return dimResult;
    }

    // P3: 跳过已有 checkpoint 的维度
    if (skippedDims.includes(dimId)) {
      const cp = completedCheckpoints.get(dimId);
      const cpResult = {
        candidateCount: cp?.candidateCount || 0,
        rejectedCount: cp?.rejectedCount || 0,
        analysisChars: cp?.analysisChars || 0,
        referencedFiles: cp?.referencedFiles || 0,
        durationMs: cp?.durationMs || 0,
        toolCallCount: cp?.toolCallCount || 0,
        tokenUsage: cp?.tokenUsage || { input: 0, output: 0 },
        skipped: true,
        restoredFromCheckpoint: true,
      };
      // P4.2: 将恢复的维度也记入统计
      dimensionStats[dimId] = cpResult;
      candidateResults.created += cpResult.candidateCount;

      // P3+: 恢复 analysisText 到 dimensionCandidates + EpisodicMemory 供 Skill 生成
      if (cp?.analysisText) {
        const restoredFiles = cp.referencedFilesList || [];
        dimensionCandidates[dimId] = {
          analysisReport: {
            analysisText: cp.analysisText,
            referencedFiles: restoredFiles,
            metadata: {},
          },
          producerResult: { candidateCount: cp.candidateCount || 0, toolCalls: [] },
        };
        episodicMemory.storeDimensionReport(dimId, {
          analysisText: cp.analysisText,
          findings: [],
          referencedFiles: restoredFiles,
          candidatesSummary: [],
        });
        logger.info(
          `[Bootstrap-v3] ✅ Checkpoint "${dimId}": analysisText restored (${cp.analysisText.length} chars) — Skill generation enabled`
        );
      }

      return cpResult;
    }

    const dim = dimensions.find((d) => d.id === dimId);
    if (!dim) {
      return { candidateCount: 0, error: 'dimension not found' };
    }

    // 合并 v3 配置和原始维度配置
    // Enhancement Pack 动态维度可能不在 DIMENSION_CONFIGS_V3 中 — 从 dim 本身构建配置
    const v3Config = DIMENSION_CONFIGS_V3[dimId];
    const dimConfig = v3Config
      ? {
          ...v3Config,
          id: dimId,
          skillWorthy: dim.skillWorthy,
          dualOutput: dim.dualOutput,
          skillMeta: dim.skillMeta,
          knowledgeTypes: dim.knowledgeTypes || v3Config.allowedKnowledgeTypes,
        }
      : {
          id: dimId,
          label: dim.label,
          guide: dim.guide || '',
          focusAreas: dim.focusAreas || [dim.guide || ''].filter(Boolean),
          outputType: dim.dualOutput ? 'dual' : dim.skillWorthy ? 'skill' : 'candidate',
          allowedKnowledgeTypes: dim.knowledgeTypes || [],
          skillWorthy: dim.skillWorthy,
          dualOutput: dim.dualOutput,
          skillMeta: dim.skillMeta,
          knowledgeTypes: dim.knowledgeTypes || [],
        };

    // Session 有效性检查
    if (taskManager && !taskManager.isSessionValid(sessionId)) {
      logger.warn(`[Bootstrap-v3] Session superseded — skipping "${dimId}"`);
      return { candidateCount: 0, error: 'session-superseded' };
    }

    taskManager?.markTaskFilling(dimId);
    logger.info(`[Bootstrap-v3] ── Dimension "${dimId}" (${dimConfig.label}) ──`);

    const dimStartTime = Date.now();

    try {
      // v4.0: 为每个维度创建独立的 WorkingMemory
      const dimWorkingMemory = new WorkingMemory({ maxRecentRounds: 3 });

      // ── Phase 1: Analyst ──
      const analysisReport = await Promise.race([
        analystAgent.analyze(dimConfig, projectInfo, {
          sessionId,
          dimensionContext: dimContext,
          // v4.0: Agent Memory 注入
          episodicMemory,
          workingMemory: dimWorkingMemory,
          toolResultCache,
          // v4.1: Semantic Memory (历史 bootstrap 记忆)
          semanticMemory,
          // Phase E: Code Entity Graph 代码实体图谱
          codeEntityGraph: codeEntityGraphInst,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Analyst timeout for "${dimId}"`)), 300_000)
        ),
      ]);

      // v4.0: 蒸馏 Working → Episodic
      const distilled = dimWorkingMemory.distill();
      episodicMemory.storeDimensionReport(dimId, {
        analysisText: analysisReport.analysisText,
        findings: distilled.keyFindings,
        referencedFiles: analysisReport.referencedFiles || [],
        candidatesSummary: [],
        workingMemoryDistilled: distilled,
      });

      logger.info(
        `[Bootstrap-v3] Analyst "${dimId}": ${analysisReport.analysisText.length} chars, ` +
          `${analysisReport.referencedFiles.length} files, ` +
          `${distilled.keyFindings.length} key findings, ` +
          `${distilled.totalObservations} observations (${Date.now() - dimStartTime}ms)`
      );

      // ── Phase 2: Producer (如果需要候选输出) ──
      let producerResult = { candidateCount: 0, toolCalls: [], reply: '' };
      // v3 优先使用 DIMENSION_CONFIGS_V3 的 outputType，回退到 baseDimension 的 skillWorthy/dualOutput
      const v3OutputType = DIMENSION_CONFIGS_V3[dimId]?.outputType;
      const needsCandidates = v3OutputType
        ? v3OutputType !== 'skill' // 'dual' 或 'candidate' 都产出候选
        : !dimConfig.skillWorthy || dimConfig.dualOutput;

      // 先保存 Analyst 结果，确保即使 Producer 失败也能生成 Skill
      dimensionCandidates[dimId] = {
        analysisReport,
        producerResult,
      };

      if (needsCandidates && analysisReport.analysisText.length >= 100) {
        try {
          producerResult = await Promise.race([
            producerAgent.produce(analysisReport, dimConfig, projectInfo, { sessionId }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Producer timeout for "${dimId}"`)), 180_000)
            ),
          ]);

          candidateResults.created += producerResult.candidateCount;
          // 更新 dimensionCandidates 以包含 Producer 结果
          dimensionCandidates[dimId].producerResult = producerResult;
          logger.info(
            `[Bootstrap-v3] Producer "${dimId}": ${producerResult.candidateCount} candidates (${Date.now() - dimStartTime}ms total)`
          );
        } catch (producerErr) {
          logger.error(`[Bootstrap-v3] Producer "${dimId}" failed: ${producerErr.message} — Analyst result preserved for Skill generation`);
          candidateResults.errors.push({ dimId, error: `Producer: ${producerErr.message}` });
        }
      }

      // ── Phase 3: 记录 DimensionDigest ──
      const digest = parseDimensionDigest(producerResult.reply) || {
        summary: `v3 分析: ${analysisReport.analysisText.substring(0, 200)}...`,
        candidateCount: producerResult.candidateCount,
        keyFindings: [],
        crossRefs: {},
        gaps: [],
      };
      dimContext.addDimensionDigest(dimId, digest);

      // v4.0: 同步 digest 到 EpisodicMemory
      episodicMemory.addDimensionDigest(dimId, digest);

      // 记录到 DimensionContext + EpisodicMemory
      for (const tc of producerResult.toolCalls || []) {
        const tool = tc.tool || tc.name;
        if (tool === 'submit_knowledge' || tool === 'submit_with_check') {
          const candidateSummary = {
            title: tc.params?.title || '',
            subTopic: tc.params?.category || '',
            summary: tc.params?.summary || '',
          };
          dimContext.addSubmittedCandidate(dimId, candidateSummary);
          // v4.0: 同步到 EpisodicMemory
          episodicMemory.addSubmittedCandidate(dimId, candidateSummary);
        }
      }

      taskManager?.markTaskCompleted(dimId, {
        type: needsCandidates ? 'candidate' : 'skill',
        extracted: producerResult.candidateCount,
        created: producerResult.candidateCount,
        status: 'v3-complete',
        durationMs: Date.now() - dimStartTime,
        toolCallCount:
          (analysisReport.metadata?.toolCallCount || 0) + (producerResult.toolCalls?.length || 0),
      });

      // P4.1: 聚合 token 用量
      const analystTokens = analysisReport.metadata?.tokenUsage || { input: 0, output: 0 };
      const producerTokens = producerResult.tokenUsage || { input: 0, output: 0 };
      const dimTokenUsage = {
        input: (analystTokens.input || 0) + (producerTokens.input || 0),
        output: (analystTokens.output || 0) + (producerTokens.output || 0),
      };

      const dimResult = {
        candidateCount: producerResult.candidateCount,
        rejectedCount: producerResult.rejectedCount || 0,
        analysisChars: analysisReport.analysisText.length,
        referencedFiles: analysisReport.referencedFiles.length,
        durationMs: Date.now() - dimStartTime,
        toolCallCount:
          (analysisReport.metadata?.toolCallCount || 0) + (producerResult.toolCalls?.length || 0),
        tokenUsage: dimTokenUsage,
        // P3+: 保存 analysisText 供 checkpoint 恢复后 Skill 生成使用
        analysisText: analysisReport.analysisText,
        referencedFilesList: analysisReport.referencedFiles || [],
      };

      // P4.2: 记录维度统计
      dimensionStats[dimId] = dimResult;

      // P3: 保存 checkpoint
      await saveDimensionCheckpoint(projectRoot, sessionId, dimId, dimResult, digest);

      return dimResult;
    } catch (err) {
      logger.error(`[Bootstrap-v3] Dimension "${dimId}" failed: ${err.message}`);
      candidateResults.errors.push({ dimId, error: err.message });
      taskManager?.markTaskCompleted(dimId, { type: 'error', reason: err.message });
      return { candidateCount: 0, error: err.message };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Step 3: 执行 (并行 or 串行)
  // ═══════════════════════════════════════════════════════════
  const t0 = Date.now();

  if (enableParallel) {
    const results = await scheduler.execute(executeDimension, {
      concurrency,
      activeDimIds,
      shouldAbort: () => taskManager && !taskManager.isSessionValid(sessionId),
      onTierComplete: (tierIndex, tierResults) => {
        const tierStats = [...tierResults.values()];
        const totalCandidates = tierStats.reduce((s, r) => s + (r.candidateCount || 0), 0);
        logger.info(
          `[Bootstrap-v3] Tier ${tierIndex + 1} complete: ${tierResults.size} dimensions, ${totalCandidates} candidates`
        );

        // v4.0: Tier 级 Reflection — 综合本 Tier 所有维度的发现
        try {
          const reflection = buildTierReflection(tierIndex, tierResults, episodicMemory);
          episodicMemory.addTierReflection(tierIndex, reflection);
          logger.info(
            `[Bootstrap-v3] Tier ${tierIndex + 1} reflection: ` +
              `${reflection.topFindings.length} top findings, ` +
              `${reflection.crossDimensionPatterns.length} patterns`
          );
        } catch (refErr) {
          logger.warn(`[Bootstrap-v3] Tier ${tierIndex + 1} reflection failed: ${refErr.message}`);
        }
      },
    });

    logger.info(
      `[Bootstrap-v3] All tiers complete: ${results.size} dimensions in ${Date.now() - t0}ms`
    );
    // v4.0: 记录 EpisodicMemory 统计 + ToolResultCache 效率
    const emStats = episodicMemory.getStats();
    const cacheStats = toolResultCache.getStats();
    logger.info(
      `[Bootstrap-v3] Memory stats: ${emStats.completedDimensions} dims, ` +
        `${emStats.totalFindings} findings, ${emStats.referencedFiles} files, ` +
        `${emStats.crossReferences} cross-refs, ${emStats.tierReflections} reflections`
    );
    logger.info(
      `[Bootstrap-v3] Cache stats: ${cacheStats.hitRate} hit rate, ` +
        `${cacheStats.searchCacheSize} searches, ${cacheStats.fileCacheSize} files`
    );
  } else {
    // 串行: 按 TierScheduler 内部顺序逐个执行
    for (const tier of scheduler.getTiers()) {
      for (const dimId of tier) {
        if (!activeDimIds.includes(dimId)) {
          continue;
        }
        if (taskManager && !taskManager.isSessionValid(sessionId)) {
          break;
        }
        await executeDimension(dimId);
      }
    }
    logger.info(`[Bootstrap-v3] Serial execution complete in ${Date.now() - t0}ms`);
  }

  // ═══════════════════════════════════════════════════════════
  // Step 4: Project Skill 生成 (skillWorthy 维度)
  //
  // v3: 直接使用 Analyst 的分析文本作为 Skill 内容
  // 不再通过 buildProjectSkillContent 转换候选数组
  // ═══════════════════════════════════════════════════════════
  const skillResults = { created: 0, failed: 0, skills: [], errors: [] };

  try {
    const { createSkill } = await import('../../skill.js');

    for (const dim of dimensions) {
      if (!dim.skillWorthy) {
        continue;
      }
      const dimData = dimensionCandidates[dim.id];
      if (!dimData?.analysisReport?.analysisText) {
        continue;
      }
      if (taskManager && !taskManager.isSessionValid(sessionId)) {
        break;
      }

      try {
        const skillName = dim.skillMeta?.name || `project-${dim.id}`;
        const skillDescription =
          dim.skillMeta?.description || `Auto-generated skill for ${dim.label}`;

        // v3: Analyst 分析文本就是高质量的 Skill 内容
        const analysisText = dimData.analysisReport.analysisText;
        const referencedFiles = dimData.analysisReport.referencedFiles || [];

        // ── Skill 质量门控 ──
        // 1. 文本过短（Analyst 产出空洞或仅 "请继续"）
        if (!analysisText || analysisText.trim().length < 100) {
          logger.warn(
            `[Bootstrap-v3] Skill "${dim.id}" skipped — analysisText too short (${analysisText?.trim().length || 0} chars)`
          );
          skillResults.failed++;
          skillResults.errors.push({ dimId: dim.id, error: 'analysisText too short' });
          continue;
        }
        // 2. 重复行检测（AI 陷入循环输出工具提示等）
        const textLines = analysisText.split('\n').filter(l => l.trim().length > 0);
        const uniqueLines = new Set(textLines.map(l => l.trim()));
        const uniqueRatio = textLines.length > 0 ? uniqueLines.size / textLines.length : 1;
        if (textLines.length > 20 && uniqueRatio < 0.3) {
          logger.warn(
            `[Bootstrap-v3] Skill "${dim.id}" skipped — heavy repetition (${uniqueLines.size}/${textLines.length} unique, ratio ${uniqueRatio.toFixed(2)})`
          );
          skillResults.failed++;
          skillResults.errors.push({ dimId: dim.id, error: 'repetitive content detected' });
          continue;
        }
        // 3. 内容中不包含项目特定标记（无 Markdown 标题、列表、代码块等结构化内容）
        const hasStructure =
          /^#{1,3}\s.+/m.test(analysisText) ||
          /^\d+\.\s/m.test(analysisText) ||
          /^[-*•]\s/m.test(analysisText) ||
          /```[\s\S]*?```/.test(analysisText);
        if (!hasStructure && analysisText.length < 500) {
          logger.warn(
            `[Bootstrap-v3] Skill "${dim.id}" skipped — no structured content detected`
          );
          skillResults.failed++;
          skillResults.errors.push({ dimId: dim.id, error: 'no structured content' });
          continue;
        }

        // 构建 Markdown Skill 内容
        const skillContent = [
          `# ${dim.label || dim.id}`,
          '',
          `> Auto-generated by Bootstrap v3 (AI-First). Sources: ${referencedFiles.length} files analyzed.`,
          '',
          analysisText,
          '',
          referencedFiles.length > 0
            ? `## Referenced Files\n\n${referencedFiles.map((f) => `- \`${f}\``).join('\n')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n');

        const result = createSkill(ctx, {
          name: skillName,
          description: skillDescription,
          content: skillContent,
          overwrite: true,
          createdBy: 'bootstrap-v3',
        });

        const parsed = JSON.parse(result);
        if (parsed.success) {
          skillResults.created++;
          skillResults.skills.push(skillName);
          logger.info(`[Bootstrap-v3] Skill "${skillName}" created for "${dim.id}"`);
        } else {
          throw new Error(parsed.error?.message || 'createSkill returned failure');
        }

        taskManager?.markTaskCompleted(dim.id, {
          type: 'skill',
          skillName,
          sourceCount: referencedFiles.length,
        });
      } catch (err) {
        logger.warn(`[Bootstrap-v3] Skill generation failed for "${dim.id}": ${err.message}`);
        skillResults.failed++;
        skillResults.errors.push({ dimId: dim.id, error: err.message });
        taskManager?.markTaskFailed?.(dim.id, err);
      }
    }
  } catch (e) {
    logger.warn(`[Bootstrap-v3] Skill generation module import failed: ${e.message}`);
  }

  // ═══════════════════════════════════════════════════════════
  // Step 4.5: Candidate Relations → Code Entity Graph (Phase E)
  //
  // 将各维度 Producer 产出的候选关系写入代码实体图谱，
  // 完善 inherits/calls/depends_on/data_flow 等语义边。
  // ═══════════════════════════════════════════════════════════
  try {
    const { CodeEntityGraph } = await import('../../../../../service/knowledge/CodeEntityGraph.js');
    const db = ctx.container.get('database');
    if (db) {
      const ceg = new CodeEntityGraph(db, { projectRoot, logger });
      // 收集所有维度产出的候选 (从 Producer toolCalls 中提取)
      const allCandidates = [];
      for (const dimData of Object.values(dimensionCandidates)) {
        const toolCalls = dimData?.producerResult?.toolCalls || [];
        for (const tc of toolCalls) {
          const toolName = tc.tool || tc.name;
          if (toolName === 'submit_knowledge' || toolName === 'submit_with_check') {
            const params = tc.params || tc.args || {};
            if (params.title) {
              allCandidates.push({
                title: params.title,
                relations: params.relations || null,
              });
            }
          }
        }
      }
      if (allCandidates.length > 0) {
        const relResult = ceg.populateFromCandidateRelations(allCandidates);
        logger.info(
          `[Bootstrap-v3] Code Entity Graph relations: ${relResult.edgesCreated} edges from ${allCandidates.length} candidates (${relResult.durationMs}ms)`
        );
      }
    }
  } catch (cegErr) {
    logger.warn(
      `[Bootstrap-v3] Code Entity Graph relations failed (non-blocking): ${cegErr.message}`
    );
  }

  // ═══════════════════════════════════════════════════════════
  // Step 5: Episodic → Semantic 固化 (Phase C)
  //
  // 将 EpisodicMemory 中的发现和洞察提炼为持久化的语义记忆，
  // 存入 SQLite semantic_memories 表，供二次冷启动和日常对话使用。
  // ═══════════════════════════════════════════════════════════
  let consolidationResult = null;
  try {
    const db = ctx.container.get('database');
    if (db) {
      const semanticMemory = new ProjectSemanticMemory(db, { logger });
      const consolidator = new EpisodicConsolidator(semanticMemory, { logger });

      consolidationResult = consolidator.consolidate(episodicMemory, {
        bootstrapSession: sessionId,
        clearPrevious: true, // 全量冷启动: 先清除旧的 bootstrap 记忆
      });

      const smStats = semanticMemory.getStats();
      logger.info(
        `[Bootstrap-v3] Semantic Memory consolidation: ` +
          `+${consolidationResult.total.added} ADD, ` +
          `~${consolidationResult.total.updated} UPDATE, ` +
          `⊕${consolidationResult.total.merged} MERGE | ` +
          `Total: ${smStats.total} memories (avg importance: ${smStats.avgImportance})`
      );
    } else {
      logger.warn('[Bootstrap-v3] Database not available — skipping Semantic Memory consolidation');
    }
  } catch (consolidateErr) {
    logger.warn(
      `[Bootstrap-v3] Semantic Memory consolidation failed (non-blocking): ${consolidateErr.message}`
    );
  }

  // ═══════════════════════════════════════════════════════════
  // Summary + P4.2: Bootstrap Report
  // ═══════════════════════════════════════════════════════════
  const totalTimeMs = Date.now() - t0;

  // P4.1: 汇总所有维度 token 用量
  const totalTokenUsage = { input: 0, output: 0 };
  const totalToolCalls = Object.values(dimensionStats).reduce(
    (sum, s) => sum + (s.toolCallCount || 0),
    0
  );
  for (const stat of Object.values(dimensionStats)) {
    if (stat.tokenUsage) {
      totalTokenUsage.input += stat.tokenUsage.input || 0;
      totalTokenUsage.output += stat.tokenUsage.output || 0;
    }
  }

  logger.info(
    [
      `[Bootstrap-v3] ═══ Pipeline complete ═══`,
      isIncremental
        ? `  Mode: INCREMENTAL (${incrementalPlan.affectedDimensions.length} affected, ${incrementalSkippedDims.length} skipped)`
        : '',
      `  Candidates: ${candidateResults.created} created, ${candidateResults.errors.length} errors`,
      `  Skills: ${skillResults.created} created, ${skillResults.failed} failed`,
      consolidationResult
        ? `  Semantic Memory: +${consolidationResult.total.added} ADD, ~${consolidationResult.total.updated} UPDATE, ⊕${consolidationResult.total.merged} MERGE`
        : '',
      `  Time: ${totalTimeMs}ms (${(totalTimeMs / 1000).toFixed(1)}s)`,
      `  Mode: ${enableParallel ? `parallel (concurrency=${concurrency})` : 'serial'}`,
      `  Tokens: input=${totalTokenUsage.input}, output=${totalTokenUsage.output}`,
      `  Tool calls: ${totalToolCalls}`,
      skippedDims.length > 0 ? `  Checkpoints restored: [${skippedDims.join(', ')}]` : '',
      incrementalSkippedDims.length > 0
        ? `  Incremental skip: [${incrementalSkippedDims.join(', ')}]`
        : '',
    ]
      .filter(Boolean)
      .join('\n')
  );

  // P4.2: 生成冷启动报告
  try {
    const report = {
      version: '2.7.0',
      timestamp: new Date().toISOString(),
      project: {
        name: projectInfo.name,
        files: projectInfo.fileCount,
        lang: projectInfo.lang,
      },
      duration: {
        totalMs: totalTimeMs,
        totalSec: Math.round(totalTimeMs / 1000),
      },
      dimensions: {},
      totals: {
        candidates: candidateResults.created,
        skills: skillResults.created,
        toolCalls: totalToolCalls,
        tokenUsage: totalTokenUsage,
        errors: candidateResults.errors.length,
      },
      checkpoints: {
        restored: skippedDims,
      },
      incremental: isIncremental
        ? {
            mode: 'incremental',
            affectedDimensions: incrementalPlan.affectedDimensions,
            skippedDimensions: incrementalSkippedDims,
            diff: incrementalPlan.diff
              ? {
                  added: incrementalPlan.diff.added.length,
                  modified: incrementalPlan.diff.modified.length,
                  deleted: incrementalPlan.diff.deleted.length,
                  unchanged: incrementalPlan.diff.unchanged.length,
                }
              : null,
            reason: incrementalPlan.reason,
          }
        : null,
      semanticMemory: consolidationResult
        ? {
            added: consolidationResult.total.added,
            updated: consolidationResult.total.updated,
            merged: consolidationResult.total.merged,
            skipped: consolidationResult.total.skipped,
            durationMs: consolidationResult.durationMs,
          }
        : null,
    };

    for (const [dimId, stat] of Object.entries(dimensionStats)) {
      report.dimensions[dimId] = {
        candidatesSubmitted: stat.candidateCount || 0,
        candidatesRejected: stat.rejectedCount || 0,
        analysisChars: stat.analysisChars || 0,
        referencedFiles: stat.referencedFiles || 0,
        durationMs: stat.durationMs || 0,
        toolCallCount: stat.toolCallCount || 0,
        tokenUsage: stat.tokenUsage || { input: 0, output: 0 },
      };
    }

    // Phase E: 附加 Code Entity Graph 拓扑到报告
    try {
      const { CodeEntityGraph } = await import(
        '../../../../../service/knowledge/CodeEntityGraph.js'
      );
      const db = ctx.container.get('database');
      if (db) {
        const ceg = new CodeEntityGraph(db, { projectRoot, logger });
        const topo = ceg.getTopology();
        report.codeEntityGraph = {
          entities: topo.entities,
          edges: topo.edges,
          totalEntities: topo.totalEntities,
          totalEdges: topo.totalEdges,
          hotNodes: topo.hotNodes?.slice(0, 5),
        };
      }
    } catch {
      /* non-blocking */
    }

    const reportDir = path.join(projectRoot, '.autosnippet');
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(
      path.join(reportDir, 'bootstrap-report.json'),
      JSON.stringify(report, null, 2)
    );
    logger.info(`[Bootstrap-v3] 📊 Bootstrap report saved to .autosnippet/bootstrap-report.json`);
  } catch (reportErr) {
    logger.warn(`[Bootstrap-v3] Bootstrap report generation failed: ${reportErr.message}`);
  }

  // P3: 成功完成后清理 checkpoints
  await clearCheckpoints(projectRoot);

  // v5.0: 保存 Bootstrap 快照 (用于下次增量 Bootstrap)
  try {
    const db = ctx.container.get('database');
    if (db && allFiles) {
      const ib = new IncrementalBootstrap(db, projectRoot, { logger });
      const snapshotId = ib.saveSnapshot({
        sessionId,
        allFiles,
        dimensionStats,
        episodicMemory,
        meta: {
          durationMs: totalTimeMs,
          candidateCount: candidateResults.created,
          primaryLang: primaryLang || projectInfo.lang,
        },
        plan: isIncremental ? incrementalPlan : null,
      });
      logger.info(`[Bootstrap-v3] 📸 Snapshot saved: ${snapshotId}`);
    }
  } catch (snapErr) {
    logger.warn(`[Bootstrap-v3] Snapshot save failed (non-blocking): ${snapErr.message}`);
  }

  // 释放文件缓存
  allFiles = null;
  chatAgent.setFileCache(null);

  // ── Cursor Delivery: 生成 4 通道交付物料 ──
  try {
    const { getServiceContainer } = await import('../../../../../injection/ServiceContainer.js');
    const container = getServiceContainer();
    if (container.services.cursorDeliveryPipeline) {
      const pipeline = container.get('cursorDeliveryPipeline');
      const deliveryResult = await pipeline.deliver();
      logger.info(
        `[Bootstrap-v3] 🚀 Cursor Delivery complete — ` +
          `A: ${deliveryResult.channelA.rulesCount} rules, ` +
          `B: ${deliveryResult.channelB.topicCount} topics, ` +
          `C: ${deliveryResult.channelC.synced} skills, ` +
          `D: ${deliveryResult.channelD?.documentsCount || 0} documents`
      );
    }
  } catch (deliveryErr) {
    logger.warn(`[Bootstrap-v3] Cursor Delivery failed (non-blocking): ${deliveryErr.message}`);
  }

  // ── Repo Wiki: 自动生成项目文档 Wiki ──
  try {
    const { getServiceContainer: getWikiContainer } = await import(
      '../../../../../injection/ServiceContainer.js'
    );
    const wikiContainer = getWikiContainer();
    const { WikiGenerator } = await import('../../../../../service/wiki/WikiGenerator.js');

    let moduleService = null,
      knowledgeService = null,
      codeEntityGraph = null;
    try {
      moduleService = wikiContainer.get('moduleService');
    } catch {
      /* optional */
    }
    try {
      knowledgeService = wikiContainer.get('knowledgeService');
    } catch {
      /* optional */
    }
    try {
      codeEntityGraph = wikiContainer.get('codeEntityGraph');
    } catch {
      /* optional */
    }

    const wiki = new WikiGenerator({
      projectRoot,
      moduleService,
      knowledgeService,
      projectGraph, // 来自 Step 0.5 构建的 ProjectGraph
      codeEntityGraph,
      aiProvider: wikiContainer.singletons?.aiProvider || null,
      options: { language: process.env.ASD_WIKI_LANG || 'zh' },
    });
    const wikiResult = await wiki.generate();
    if (wikiResult.success) {
      logger.info(
        `[Bootstrap-v3] 📖 Wiki generated — ${wikiResult.filesGenerated} files, ` +
          `AI: ${wikiResult.aiComposed || 0}, Synced: ${wikiResult.syncedDocs || 0}, ` +
          `Dedup removed: ${wikiResult.dedup?.removed?.length || 0}`
      );
    }
  } catch (wikiErr) {
    logger.warn(`[Bootstrap-v3] Wiki generation failed (non-blocking): ${wikiErr.message}`);
  }
}

/**
 * 清除增量 Bootstrap 快照 — 供 bootstrapKnowledge 在手动冷启动时调用
 * @param {string} projectRoot
 * @param {object} ctx — { container, logger }
 */
async function clearSnapshotsImpl(projectRoot, ctx) {
  try {
    const db = ctx.container.get('database');
    if (db) {
      const { BootstrapSnapshot } = await import('./BootstrapSnapshot.js');
      const snap = new BootstrapSnapshot(db, { logger: ctx.logger });
      snap.clearProject(projectRoot);
      ctx.logger.info('[Bootstrap] Cleared incremental snapshots — forcing full rebuild');
    }
  } catch (err) {
    ctx.logger.warn(`[Bootstrap] clearSnapshots failed (non-blocking): ${err.message}`);
  }
}

export { clearCheckpoints };
export { clearSnapshotsImpl as clearSnapshots };
export default fillDimensionsV3;
