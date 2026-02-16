/**
 * orchestrator.js — AI-First Bootstrap 管线
 *
 * 核心架构: Analyst → Gate → Producer (双 Agent 模式)
 *
 * 1. Analyst Agent 自由探索代码 (AST 工具 + 文件搜索)
 * 2. HandoffProtocol 质量门控
 * 3. Producer Agent 格式化输出 (submit_candidate)
 * 4. TierScheduler 分层并行执行
 *
 * @module pipeline/orchestrator
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { AnalystAgent } from '../../../../../service/chat/AnalystAgent.js';
import { ProducerAgent } from '../../../../../service/chat/ProducerAgent.js';
import { TierScheduler } from './tier-scheduler.js';
import { DimensionContext, parseDimensionDigest } from './dimension-context.js';
import Logger from '../../../../../infrastructure/logging/Logger.js';

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
      JSON.stringify({ dimId, sessionId, ...result, digest, completedAt: Date.now() }),
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
      if (!file.endsWith('.json')) continue;
      try {
        const content = await fs.readFile(path.join(checkpointDir, file), 'utf-8');
        const data = JSON.parse(content);
        if (data.completedAt && (now - data.completedAt) < CHECKPOINT_TTL_MS) {
          checkpoints.set(data.dimId, data);
        }
      } catch { /* skip corrupt checkpoint */ }
    }
  } catch { /* checkpoint dir doesn't exist */ }
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
  } catch { /* ignore */ }
}

// ──────────────────────────────────────────────────────────────────
// v3.0 维度配置 (增加 focusAreas 用于 Analyst prompt)
// ──────────────────────────────────────────────────────────────────

const DIMENSION_CONFIGS_V3 = {
  'project-profile': {
    label: '项目概貌',
    guide: '分析项目的整体结构、技术栈、模块划分和入口点。',
    focusAreas: [
      '项目结构和模块划分',
      '技术栈和框架依赖',
      '核心入口点和启动流程',
    ],
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
  'architecture': {
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
};

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
    ctx, dimensions, taskManager, sessionId, projectRoot,
    depGraphData, guardAudit, langStats, primaryLang, astProjectSummary,
    skillContext, skillsEnhanced,
  } = fillContext;

  logger.info('[Bootstrap-v3] ═══ fillDimensionsV3 entered — AI-First pipeline');

  let allFiles = fillContext.allFiles;
  fillContext.allFiles = null;

  // ═══════════════════════════════════════════════════════════
  // Step 0: AI 可用性检查
  // ═══════════════════════════════════════════════════════════
  let chatAgent = null;
  try {
    chatAgent = ctx.container.get('chatAgent');
    if (chatAgent && !chatAgent.hasRealAI) chatAgent = null;
    if (chatAgent) chatAgent.resetGlobalSubmittedTitles();
  } catch { /* not available */ }

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
      logger.info(`[Bootstrap-v3] ProjectGraph: ${overview.totalClasses} classes, ${overview.totalProtocols} protocols (${overview.buildTimeMs}ms)`);
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
    lang: primaryLang || 'objectivec',
    fileCount: allFiles?.length || 0,
  };

  // 跨维度上下文
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

  // ═══════════════════════════════════════════════════════════
  // Step 2: 按维度分层执行 (Analyst → Gate → Producer)
  // ═══════════════════════════════════════════════════════════
  const concurrency = parseInt(process.env.ASD_PARALLEL_CONCURRENCY || '3', 10);
  const enableParallel = process.env.ASD_PARALLEL_BOOTSTRAP !== 'false';
  const scheduler = new TierScheduler();

  // 过滤出有定义的维度
  const activeDimIds = dimensions
    .map(d => d.id)
    .filter(id => DIMENSION_CONFIGS_V3[id]);

  logger.info(`[Bootstrap-v3] Active dimensions: [${activeDimIds.join(', ')}], concurrency=${enableParallel ? concurrency : 1}`);

  // ── P3: 断点续传 — 加载有效 checkpoints ──
  const completedCheckpoints = await loadCheckpoints(projectRoot);
  const skippedDims = [];
  for (const [dimId, checkpoint] of completedCheckpoints) {
    if (activeDimIds.includes(dimId)) {
      // 恢复 DimensionContext 中的 digest
      if (checkpoint.digest) {
        dimContext.addDimensionDigest(dimId, checkpoint.digest);
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
      return cpResult;
    }

    const dim = dimensions.find(d => d.id === dimId);
    const v3Config = DIMENSION_CONFIGS_V3[dimId];
    if (!dim || !v3Config) {
      return { candidateCount: 0, error: 'dimension not found' };
    }

    // 合并 v3 配置和原始维度配置 (保留 skillWorthy, skillMeta 等)
    const dimConfig = {
      ...v3Config,
      id: dimId,
      skillWorthy: dim.skillWorthy,
      dualOutput: dim.dualOutput,
      skillMeta: dim.skillMeta,
      knowledgeTypes: dim.knowledgeTypes || v3Config.allowedKnowledgeTypes,
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
      // ── Phase 1: Analyst ──
      const analysisReport = await Promise.race([
        analystAgent.analyze(dimConfig, projectInfo, { sessionId, dimensionContext: dimContext }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Analyst timeout for "${dimId}"`)), 180_000)),
      ]);

      logger.info(`[Bootstrap-v3] Analyst "${dimId}": ${analysisReport.analysisText.length} chars, ${analysisReport.referencedFiles.length} files (${Date.now() - dimStartTime}ms)`);

      // ── Phase 2: Producer (如果需要候选输出) ──
      let producerResult = { candidateCount: 0, toolCalls: [], reply: '' };
      // v3 优先使用 DIMENSION_CONFIGS_V3 的 outputType，回退到 baseDimension 的 skillWorthy/dualOutput
      const v3OutputType = DIMENSION_CONFIGS_V3[dimId]?.outputType;
      const needsCandidates = v3OutputType
        ? v3OutputType !== 'skill'   // 'dual' 或 'candidate' 都产出候选
        : (!dimConfig.skillWorthy || dimConfig.dualOutput);

      if (needsCandidates && analysisReport.analysisText.length >= 100) {
        producerResult = await Promise.race([
          producerAgent.produce(analysisReport, dimConfig, projectInfo, { sessionId }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Producer timeout for "${dimId}"`)), 120_000)),
        ]);

        candidateResults.created += producerResult.candidateCount;
        logger.info(`[Bootstrap-v3] Producer "${dimId}": ${producerResult.candidateCount} candidates (${Date.now() - dimStartTime}ms total)`);
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

      // 记录到 DimensionContext
      for (const tc of (producerResult.toolCalls || [])) {
        const tool = tc.tool || tc.name;
        if (tool === 'submit_candidate' || tool === 'submit_with_check') {
          dimContext.addSubmittedCandidate(dimId, {
            title: tc.params?.title || '',
            subTopic: tc.params?.category || '',
            summary: tc.params?.summary || '',
          });
        }
      }

      // 保存分析结果供 Skill 生成
      dimensionCandidates[dimId] = {
        analysisReport,
        producerResult,
      };

      taskManager?.markTaskCompleted(dimId, {
        type: needsCandidates ? 'candidate' : 'skill',
        extracted: producerResult.candidateCount,
        created: producerResult.candidateCount,
        status: 'v3-complete',
        durationMs: Date.now() - dimStartTime,
        toolCallCount: (analysisReport.metadata?.toolCallCount || 0) + (producerResult.toolCalls?.length || 0),
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
        toolCallCount: (analysisReport.metadata?.toolCallCount || 0) + (producerResult.toolCalls?.length || 0),
        tokenUsage: dimTokenUsage,
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
      shouldAbort: () => taskManager && !taskManager.isSessionValid(sessionId),
      onTierComplete: (tierIndex, tierResults) => {
        const tierStats = [...tierResults.values()];
        const totalCandidates = tierStats.reduce((s, r) => s + (r.candidateCount || 0), 0);
        logger.info(`[Bootstrap-v3] Tier ${tierIndex + 1} complete: ${tierResults.size} dimensions, ${totalCandidates} candidates`);
      },
    });

    logger.info(`[Bootstrap-v3] All tiers complete: ${results.size} dimensions in ${Date.now() - t0}ms`);
  } else {
    // 串行: 按 TierScheduler 内部顺序逐个执行
    for (const tier of scheduler.getTiers()) {
      for (const dimId of tier) {
        if (!activeDimIds.includes(dimId)) continue;
        if (taskManager && !taskManager.isSessionValid(sessionId)) break;
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
      if (!dim.skillWorthy) continue;
      const dimData = dimensionCandidates[dim.id];
      if (!dimData?.analysisReport?.analysisText) continue;
      if (taskManager && !taskManager.isSessionValid(sessionId)) break;

      try {
        const skillName = dim.skillMeta?.name || `project-${dim.id}`;
        const skillDescription = dim.skillMeta?.description || `Auto-generated skill for ${dim.label}`;

        // v3: Analyst 分析文本就是高质量的 Skill 内容
        const analysisText = dimData.analysisReport.analysisText;
        const referencedFiles = dimData.analysisReport.referencedFiles || [];

        // 构建 Markdown Skill 内容
        const skillContent = [
          `# ${dim.label || dim.id}`,
          '',
          `> Auto-generated by Bootstrap v3 (AI-First). Sources: ${referencedFiles.length} files analyzed.`,
          '',
          analysisText,
          '',
          referencedFiles.length > 0
            ? `## Referenced Files\n\n${referencedFiles.map(f => `- \`${f}\``).join('\n')}`
            : '',
        ].filter(Boolean).join('\n');

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
  // Summary + P4.2: Bootstrap Report
  // ═══════════════════════════════════════════════════════════
  const totalTimeMs = Date.now() - t0;

  // P4.1: 汇总所有维度 token 用量
  const totalTokenUsage = { input: 0, output: 0 };
  const totalToolCalls = Object.values(dimensionStats).reduce((sum, s) => sum + (s.toolCallCount || 0), 0);
  for (const stat of Object.values(dimensionStats)) {
    if (stat.tokenUsage) {
      totalTokenUsage.input += stat.tokenUsage.input || 0;
      totalTokenUsage.output += stat.tokenUsage.output || 0;
    }
  }

  logger.info([
    `[Bootstrap-v3] ═══ Pipeline complete ═══`,
    `  Candidates: ${candidateResults.created} created, ${candidateResults.errors.length} errors`,
    `  Skills: ${skillResults.created} created, ${skillResults.failed} failed`,
    `  Time: ${totalTimeMs}ms (${(totalTimeMs / 1000).toFixed(1)}s)`,
    `  Mode: ${enableParallel ? `parallel (concurrency=${concurrency})` : 'serial'}`,
    `  Tokens: input=${totalTokenUsage.input}, output=${totalTokenUsage.output}`,
    `  Tool calls: ${totalToolCalls}`,
    skippedDims.length > 0 ? `  Checkpoints restored: [${skippedDims.join(', ')}]` : '',
  ].filter(Boolean).join('\n'));

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

    const reportDir = path.join(projectRoot, '.autosnippet');
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(
      path.join(reportDir, 'bootstrap-report.json'),
      JSON.stringify(report, null, 2),
    );
    logger.info(`[Bootstrap-v3] 📊 Bootstrap report saved to .autosnippet/bootstrap-report.json`);
  } catch (reportErr) {
    logger.warn(`[Bootstrap-v3] Bootstrap report generation failed: ${reportErr.message}`);
  }

  // P3: 成功完成后清理 checkpoints
  await clearCheckpoints(projectRoot);

  // 释放文件缓存
  allFiles = null;
  chatAgent.setFileCache(null);
}

export { clearCheckpoints };
export default fillDimensionsV3;
