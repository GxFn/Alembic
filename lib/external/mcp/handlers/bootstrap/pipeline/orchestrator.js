/**
 * orchestrator.js — 内部 Agent AI-First Bootstrap 管线
 *
 * ⚠️ 本文件是「内部 Agent」专用 — 由 bootstrap.js Phase 5 调用。
 *    外部 Agent (Cursor/Copilot) 不经过此管线，它们自行分析代码。
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
import { clearCheckpoints, loadCheckpoints, saveDimensionCheckpoint } from './checkpoint.js';
import { buildTierReflection, DIMENSION_CONFIGS_V3 } from './dimension-configs.js';
import { DimensionContext, parseDimensionDigest } from './dimension-context.js';
import { EpisodicMemory } from './EpisodicMemory.js';
import { IncrementalBootstrap } from './IncrementalBootstrap.js';
import { runNoAiFallback } from './noAiFallback.js';
import { ToolResultCache } from './ToolResultCache.js';
import { TierScheduler } from './tier-scheduler.js';
import { generateSkill } from '../shared/skill-generator.js';

const logger = Logger.getInstance();

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
    logger.info('[Bootstrap-v3] AI not available — entering rule-based fallback');
    taskManager?.emitProgress('bootstrap:ai-unavailable', {
      message: 'AI 不可用，将使用规则化降级提取基础知识。请配置 AI Provider 以获取完整分析。',
    });

    // ── 规则化降级: 从 Phase 0-4 数据中提取基础知识 ──
    try {
      fillContext.allFiles = allFiles;
      const fallbackResult = await runNoAiFallback(fillContext);

      // ── 持久化候选到数据库 (KnowledgeService.create) ──
      let persistedCount = 0;
      if (fallbackResult.candidates.length > 0) {
        try {
          const knowledgeService = ctx.container.get('knowledgeService');
          for (const candidate of fallbackResult.candidates) {
            try {
              await knowledgeService.create(
                {
                  title: candidate.title,
                  content: candidate.content,
                  language: candidate.language || primaryLang || '',
                  category: candidate.category || '',
                  knowledgeType: candidate.knowledgeType || 'code-pattern',
                  source: 'bootstrap-fallback',
                  difficulty: candidate.difficulty || 'beginner',
                  scope: candidate.scope || 'project-specific',
                  reasoning: candidate.reasoning || {},
                  tags: ['bootstrap-fallback', 'rule-based'],
                },
                { userId: 'bootstrap-fallback' }
              );
              persistedCount++;
            } catch (entryErr) {
              logger.warn(
                `[Bootstrap-fallback] Candidate "${candidate.title}" persist failed: ${entryErr.message}`
              );
            }
          }
          logger.info(
            `[Bootstrap-fallback] ${persistedCount}/${fallbackResult.candidates.length} candidates persisted to DB`
          );
        } catch (svcErr) {
          logger.warn(
            `[Bootstrap-fallback] KnowledgeService not available — candidates not persisted: ${svcErr.message}`
          );
        }
      }

      // ── 持久化 Skill 文件 ──
      let skillsCreated = 0;
      if (fallbackResult.skills.length > 0) {
        try {
          const { createSkill } = await import('../../skill.js');
          for (const sk of fallbackResult.skills) {
            try {
              const result = createSkill(ctx, {
                name: sk.name,
                description: sk.description,
                content: sk.content,
                overwrite: true,
                createdBy: 'bootstrap-fallback',
              });
              const parsed = JSON.parse(result);
              if (parsed.success) {
                skillsCreated++;
                logger.info(`[Bootstrap-fallback] Skill "${sk.name}" created`);
              }
            } catch (skErr) {
              logger.warn(`[Bootstrap-fallback] Skill "${sk.name}" write failed: ${skErr.message}`);
            }
          }
        } catch (importErr) {
          logger.warn(`[Bootstrap-fallback] Skill module import failed: ${importErr.message}`);
        }
      }

      // ── 写入降级报告 ──
      try {
        const reportDir = path.join(projectRoot, '.autosnippet');
        await fs.mkdir(reportDir, { recursive: true });
        await fs.writeFile(
          path.join(reportDir, 'bootstrap-report.json'),
          JSON.stringify(
            {
              version: '2.7.0',
              timestamp: new Date().toISOString(),
              mode: 'no-ai-fallback',
              project: {
                name: path.basename(projectRoot),
                files: allFiles?.length || 0,
                lang: primaryLang || 'unknown',
              },
              fallback: fallbackResult.report,
              persisted: { candidates: persistedCount, skills: skillsCreated },
            },
            null,
            2
          )
        );
      } catch {
        /* non-critical */
      }

      // ── 通知前端降级产出已完成 ──
      taskManager?.emitProgress('bootstrap:fallback-complete', {
        message: `降级产出完成: ${persistedCount} 条知识已入库, ${skillsCreated} 个 Skill 已生成`,
        candidates: persistedCount,
        skills: skillsCreated,
        errors: fallbackResult.report.errors.length,
      });

      logger.info(
        `[Bootstrap-fallback] Completed: ${persistedCount} candidates persisted, ` +
          `${skillsCreated} skills written, ${fallbackResult.report.errors.length} errors`
      );
    } catch (fallbackErr) {
      logger.error(`[Bootstrap-fallback] Fallback failed: ${fallbackErr.message}`);
      // 即使降级也失败，仍标记所有维度为 skipped
      for (const dim of dimensions) {
        taskManager?.markTaskCompleted(dim.id, { type: 'skipped', reason: 'fallback-failed' });
      }
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
        findings: analysisReport.findings || distilled.keyFindings,
        referencedFiles: analysisReport.referencedFiles || [],
        candidatesSummary: [],
        workingMemoryDistilled: distilled,
      });

      // v4.2: 记录 Artifact 增强数据 (如果使用了 v2 pipeline)
      const isArtifact = !!analysisReport.evidenceMap;
      const evidenceMapSize = isArtifact ? analysisReport.evidenceMap.size : 0;
      const negativeSignalCount = isArtifact ? analysisReport.negativeSignals?.length || 0 : 0;
      const qualityScore = isArtifact ? analysisReport.qualityReport?.totalScore : null;

      logger.info(
        `[Bootstrap-v3] Analyst "${dimId}": ${analysisReport.analysisText.length} chars, ` +
          `${analysisReport.referencedFiles.length} files, ` +
          `${distilled.keyFindings.length} key findings, ` +
          `${distilled.totalObservations} observations` +
          (isArtifact
            ? `, evidence: ${evidenceMapSize} files, negative: ${negativeSignalCount}, quality: ${qualityScore}`
            : '') +
          ` (${Date.now() - dimStartTime}ms)`
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
          logger.error(
            `[Bootstrap-v3] Producer "${dimId}" failed: ${producerErr.message} — Analyst result preserved for Skill generation`
          );
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

  // tierHints: Enhancement Pack 维度通过 tierHint 字段声明首选 Tier
  const tierHints = {};
  for (const dim of dimensions) {
    if (typeof dim.tierHint === 'number') {
      tierHints[dim.id] = dim.tierHint;
    }
  }

  if (enableParallel) {
    const results = await scheduler.execute(executeDimension, {
      concurrency,
      activeDimIds,
      tierHints,
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
  // 使用 shared/skill-generator.js 统一质量门控和内容构建
  // ═══════════════════════════════════════════════════════════
  const skillResults = { created: 0, failed: 0, skills: [], errors: [] };

  try {
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
        const analysisText = dimData.analysisReport.analysisText;
        const referencedFiles = dimData.analysisReport.referencedFiles || [];

        const result = await generateSkill(
          ctx, dim, analysisText, referencedFiles, [], 'bootstrap-v3'
        );

        if (result.success) {
          skillResults.created++;
          skillResults.skills.push(result.skillName);

          taskManager?.markTaskCompleted(dim.id, {
            type: 'skill',
            skillName: result.skillName,
            sourceCount: referencedFiles.length,
          });
        } else {
          skillResults.failed++;
          skillResults.errors.push({ dimId: dim.id, error: result.error });
          taskManager?.markTaskFailed?.(dim.id, new Error(result.error));
        }
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
          `D: ${deliveryResult.channelD?.documentsCount || 0} documents, ` +
          `F: ${deliveryResult.channelF?.filesWritten || 0} agent files`
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

    // 同步 wiki 路由的任务状态，让前端轮询 /wiki/status 能看到进度
    let patchWikiTask = null;
    let realtimeService = null;
    try {
      const wikiRoute = await import('../../../../../http/routes/wiki.js');
      patchWikiTask = wikiRoute.patchWikiTask;
    } catch { /* ok */ }
    try {
      realtimeService = wikiContainer.singletons?.realtimeService || null;
    } catch { /* ok */ }

    // 标记任务开始
    patchWikiTask?.({
      status: 'running',
      startedAt: Date.now(),
      phase: null,
      progress: 0,
      message: 'Bootstrap Wiki 生成中...',
      finishedAt: null,
      result: null,
      error: null,
    });

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
      onProgress: (phase, progress, message) => {
        // 同步到 wiki 路由的任务状态
        patchWikiTask?.({ phase, progress, message });
        // 通过 Socket.io 推送进度
        if (realtimeService) {
          try {
            realtimeService.broadcastEvent('wiki:progress', {
              phase, progress, message, timestamp: Date.now(),
            });
          } catch { /* non-critical */ }
        }
      },
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

    // 标记任务完成
    patchWikiTask?.({
      status: wikiResult.success ? 'done' : 'error',
      finishedAt: Date.now(),
      result: wikiResult,
      error: wikiResult.success ? null : (wikiResult.error || 'Unknown error'),
      progress: 100,
    });
    if (realtimeService) {
      try {
        realtimeService.broadcastEvent('wiki:completed', {
          success: wikiResult.success,
          filesGenerated: wikiResult.filesGenerated,
          duration: wikiResult.duration,
        });
      } catch { /* non-critical */ }
    }
  } catch (wikiErr) {
    logger.warn(`[Bootstrap-v3] Wiki generation failed (non-blocking): ${wikiErr.message}`);
    try {
      const wikiRoute = await import('../../../../../http/routes/wiki.js');
      wikiRoute.patchWikiTask?.({
        status: 'error',
        finishedAt: Date.now(),
        error: wikiErr.message,
      });
    } catch { /* ok */ }
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
