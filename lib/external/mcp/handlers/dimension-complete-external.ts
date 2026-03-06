/**
 * MCP Handler — 维度完成通知 (dimension_complete)
 *
 * 外部 Agent 完成一个维度的分析后调用此 handler：
 *   1. Recipe 关联 — 标记 submit_knowledge 提交的 recipes 属于此维度
 *   2. Skill 生成 — skillWorthy 维度自动生成 Project Skill
 *   3. Checkpoint 保存 — 持久化进度，支持断点续传
 *   4. EpisodicMemory 写入 — 供 Dashboard 和增量 Bootstrap
 *   5. SemanticMemory 固化 — 提炼为项目级永久记忆
 *   6. 进度推送 — Socket.io/EventBus 通知 Dashboard
 *   7. Hints 收集与分发 — 跨维度知识传递
 *
 * 幂等性：同一 dimensionId 多次调用 → 覆盖更新，不产生重复
 *
 * @module handlers/dimension-complete
 */

import Logger from '../../../infrastructure/logging/Logger.js';
import { envelope } from '../envelope.js';
import { getActiveSession } from './bootstrap-external.js';
import { saveDimensionCheckpoint } from './bootstrap/pipeline/checkpoint.js';
import { generateSkill } from './bootstrap/shared/skill-generator.js';
import { BOOTSTRAP_COMPLETE_ACTIONS } from './bootstrap/shared/dimension-text.js';
import { BootstrapEventEmitter } from '../../../shared/BootstrapEventEmitter.js';

const logger = Logger.getInstance();

// ── 主入口 ─────────────────────────────────────────────────────

/**
 * dimensionComplete — 维度分析完成通知
 *
 * @param {object} ctx  - { container, logger, startedAt }
 * @param {object} args 工具参数
 * @param {string} [args.sessionId]          - bootstrap 返回的 session.id
 * @param {string} args.dimensionId          维度 ID
 * @param {string[]} args.submittedRecipeIds 本维度提交的 recipe ID 列表
 * @param {string} args.analysisText         分析报告全文（Markdown）
 * @param {string[]} [args.referencedFiles]  引用的文件路径列表
 * @param {string[]} [args.keyFindings]      关键发现摘要 (3-5 条)
 * @param {number} [args.candidateCount]     本维度提交的候选数量
 * @param {object} [args.crossDimensionHints] 对其他维度的建议
 * @returns {Promise<object>}
 */
export async function dimensionComplete(ctx, args) {
  const t0 = Date.now();
  const {
    sessionId,
    dimensionId,
    submittedRecipeIds: rawSubmittedRecipeIds = [],
    analysisText,
    referencedFiles: rawReferencedFiles = [],
    keyFindings = [],
    candidateCount,
    crossDimensionHints,
  } = args;

  // referencedFiles / submittedRecipeIds 自动补全：若 Agent 未传递，
  // 从 SubmissionTracker 已记录的数据中恢复
  let referencedFiles = rawReferencedFiles;
  let submittedRecipeIds = rawSubmittedRecipeIds;

  // ── 参数校验 ──
  if (!dimensionId) {
    return envelope({
      success: false,
      message: 'Missing required parameter: dimensionId',
      errorCode: 'VALIDATION_ERROR',
      meta: { tool: 'autosnippet_dimension_complete' },
    });
  }
  if (!analysisText || analysisText.length < 10) {
    return envelope({
      success: false,
      message: 'analysisText is required and must be at least 10 characters',
      errorCode: 'VALIDATION_ERROR',
      meta: { tool: 'autosnippet_dimension_complete' },
    });
  }
  if (!Array.isArray(submittedRecipeIds)) {
    return envelope({
      success: false,
      message: 'submittedRecipeIds must be an array of recipe ID strings',
      errorCode: 'VALIDATION_ERROR',
      meta: { tool: 'autosnippet_dimension_complete' },
    });
  }

  // ── 获取 Session ──
  const session = getActiveSession(ctx.container, sessionId);
  if (!session) {
    return envelope({
      success: false,
      message: sessionId
        ? `No active bootstrap session found with id: ${sessionId}`
        : 'No active bootstrap session. Call autosnippet_bootstrap first.',
      errorCode: 'SESSION_NOT_FOUND',
      meta: { tool: 'autosnippet_dimension_complete' },
    });
  }

  // R11: Session TTL 自动延长 — 每次 dimension_complete 调用时至少再延 1h
  if (session.expiresAt) {
    session.expiresAt = Math.max(session.expiresAt, Date.now() + 60 * 60 * 1000);
  }

  // ── 查找维度定义 ──
  const dim = session.dimensions.find((d) => d.id === dimensionId);
  if (!dim) {
    return envelope({
      success: false,
      message: `Unknown dimensionId: "${dimensionId}". Valid dimensions: ${session.dimensions.map((d) => d.id).join(', ')}`,
      errorCode: 'VALIDATION_ERROR',
      meta: { tool: 'autosnippet_dimension_complete' },
    });
  }

  const projectRoot = session.projectRoot;

  // ── referencedFiles 自动补全 ──
  // 外部 Agent 常常忘记传 referencedFiles，从 SubmissionTracker 的 reasoning.sources 中恢复
  if (referencedFiles.length === 0) {
    try {
      const submissions = session.submissionTracker.getSubmissions(dimensionId);
      const filesFromSources = new Set();
      for (const sub of submissions) {
        for (const src of sub.sources) {
          // "BDVideoPlayer.h:37" → "BDVideoPlayer.h"
          filesFromSources.add(src.split(':')[0]);
        }
      }
      if (filesFromSources.size > 0) {
        referencedFiles = [...filesFromSources];
        logger.debug(
          `[DimensionComplete] Auto-recovered ${referencedFiles.length} referencedFiles from submissions for "${dimensionId}"`,
        );
      }
    } catch {
      /* best effort */
    }
  }

  // ── submittedRecipeIds 自动补全 ──
  // 外部 Agent 常常忘记传 submittedRecipeIds（batch 接口不返回 ID 列表），
  // 从 SubmissionTracker 已记录的 recipeId 中恢复
  if (submittedRecipeIds.length === 0) {
    try {
      const submissions = session.submissionTracker.getSubmissions(dimensionId);
      const recoveredIds = submissions.map((s) => s.recipeId).filter(Boolean);
      if (recoveredIds.length > 0) {
        submittedRecipeIds = recoveredIds;
        logger.debug(
          `[DimensionComplete] Auto-recovered ${submittedRecipeIds.length} submittedRecipeIds from tracker for "${dimensionId}"`,
        );
      }
    } catch {
      /* best effort */
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 1. Recipe 关联 — 标记 recipes 的 dimensionId
  // ═══════════════════════════════════════════════════════════

  let recipesBound = 0;
  if (submittedRecipeIds.length > 0) {
    try {
      const knowledgeService = ctx.container.get('knowledgeService');
      if (knowledgeService) {
        for (const recipeId of submittedRecipeIds) {
          try {
            // 通过 updatable 字段标记 recipe 的维度关联
            const entry = await knowledgeService.get(recipeId);
            if (entry) {
              const existingTags = Array.isArray(entry.tags)
                ? entry.tags
                : (typeof entry.tags === 'string' ? JSON.parse(entry.tags) : []);
              const newTags = [...new Set([
                ...existingTags,
                `dimension:${dimensionId}`,
                `bootstrap:${session.id}`,
              ])];
              await knowledgeService.update(recipeId, {
                category: dimensionId,
                tags: newTags,
              }, { userId: 'mcp' });
              recipesBound++;
            }
          } catch (e: any) {
            logger.debug(
              `[DimensionComplete] Failed to tag recipe ${recipeId}: ${e.message}`
            );
          }
        }
      }
    } catch (e: any) {
      logger.warn(`[DimensionComplete] Recipe tagging failed (degraded): ${e.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 2. Skill 生成 (skillWorthy 维度) — 使用共享 skill-generator
  // ═══════════════════════════════════════════════════════════

  let skillCreated = false;
  if (dim.skillWorthy) {
    const skillResult = await generateSkill(
      ctx, dim, analysisText, referencedFiles, keyFindings, 'external-agent-bootstrap'
    );
    skillCreated = skillResult.success;
    if (!skillCreated) {
      logger.warn(`[DimensionComplete] Skill skipped for "${dimensionId}": ${skillResult.error}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 3. BootstrapSession 标记完成 + EpisodicMemory 写入 + Quality
  // ═══════════════════════════════════════════════════════════

  const { updated, qualityReport } = session.markDimensionComplete(dimensionId, {
    analysisText,
    keyFindings,
    referencedFiles,
    recipeIds: submittedRecipeIds,
    candidateCount: candidateCount || submittedRecipeIds.length,
  });

  // ═══════════════════════════════════════════════════════════
  // 4. Checkpoint 保存（持久化，支持断点续传）
  // ═══════════════════════════════════════════════════════════

  try {
    await saveDimensionCheckpoint(projectRoot, session.id, dimensionId, {
      candidateCount: candidateCount || submittedRecipeIds.length,
      analysisChars: analysisText.length,
      referencedFiles: referencedFiles.length,
      recipeIds: submittedRecipeIds,
      skillCreated,
    });
  } catch (e: any) {
    logger.warn(`[DimensionComplete] Checkpoint save failed: ${e.message}`);
  }

  // ═══════════════════════════════════════════════════════════
  // 5. SemanticMemory 固化 (提炼为项目级永久记忆)
  // ═══════════════════════════════════════════════════════════

  try {
    const knowledgeGraphService = ctx.container.get('knowledgeGraphService');
    if (knowledgeGraphService && keyFindings.length > 0) {
      // 将每个 keyFinding 创建为知识图谱中的实体
      for (const finding of keyFindings) {
        knowledgeGraphService.addEdge(
          dimensionId, 'dimension',
          finding.substring(0, 80), 'finding',
          'discovered_in',
          { source: 'external-agent-bootstrap', sessionId: session.id }
        );
      }
    }
  } catch (e: any) {
    logger.debug(`[DimensionComplete] SemanticMemory fixation skipped: ${e.message}`);
  }

  // ═══════════════════════════════════════════════════════════
  // 6. 进度推送 (BootstrapEventEmitter 统一封装)
  // ═══════════════════════════════════════════════════════════

  const progress = session.getProgress();
  const isComplete = session.isComplete;

  const emitter = new BootstrapEventEmitter(ctx.container);
  emitter.emitDimensionComplete(dimensionId, {
    type: dim.skillWorthy ? 'skill' : 'candidate',
    extracted: candidateCount || submittedRecipeIds.length,
    skillCreated,
    recipesBound,
    progress: `${progress.completed}/${progress.total}`,
    isBootstrapComplete: isComplete,
    source: 'external-agent',
  });

  if (isComplete) {
    emitter.emitAllComplete(session.id, progress.total, 'external-agent');
  }

  // ═══════════════════════════════════════════════════════════
  // 6.5 Bootstrap 完成后，自动触发 Delivery / Wiki / SemanticMemory (R4/R5/R6)
  // ═══════════════════════════════════════════════════════════

  if (isComplete) {
    // R4: 自动触发 Cursor Delivery
    try {
      const { getServiceContainer } = await import('../../../injection/ServiceContainer.js');
      const container = getServiceContainer();
      if (container.services.cursorDeliveryPipeline) {
        const pipeline = container.get('cursorDeliveryPipeline');
        const deliveryResult = await pipeline.deliver();
        logger.info(
          `[DimensionComplete] Auto Cursor Delivery complete — ` +
            `A: ${deliveryResult.channelA?.rulesCount || 0} rules, ` +
            `B: ${deliveryResult.channelB?.topicCount || 0} topics, ` +
            `C: ${deliveryResult.channelC?.synced || 0} skills, ` +
            `F: ${deliveryResult.channelF?.filesWritten || 0} agent files`
        );
      }
    } catch (e: any) {
      logger.warn(`[DimensionComplete] Auto CursorDelivery failed (non-blocking): ${e.message}`);
    }

    // R5: 自动触发 Wiki 生成 (fire-and-forget)
    setImmediate(async () => {
      try {
        const { getServiceContainer: getWikiContainer } = await import('../../../injection/ServiceContainer.js');
        const wikiContainer = getWikiContainer();
        const { WikiGenerator } = await import('../../../service/wiki/WikiGenerator.js');
        const moduleService = wikiContainer.get?.('moduleService');
        const knowledgeService = wikiContainer.get?.('knowledgeService');
        if (moduleService && knowledgeService) {
          const wikiGen = new WikiGenerator({
            projectRoot,
            moduleService,
            knowledgeService,
            options: { mode: 'bootstrap' },
          });
          const wikiResult = await wikiGen.generate();
          logger.info(
            `[DimensionComplete] Auto Wiki generation: ${(wikiResult as any)?.totalPages || 0} pages`
          );
        }
      } catch (e: any) {
        logger.warn(`[DimensionComplete] Wiki generation failed (non-blocking): ${e.message}`);
      }
    });

    // R6: 全量 Semantic Memory 固化 (fire-and-forget)
    setImmediate(async () => {
      try {
        const { EpisodicConsolidator } = await import('../../../service/agent/domain/EpisodicConsolidator.js');
        const db = ctx.container.get?.('database') ?? ctx.container.get?.('db');
        if (db && session.sessionStore) {
          const { PersistentMemory } = await import('../../../service/agent/memory/PersistentMemory.js');
          const semanticMemory = new PersistentMemory(db, { logger });
          const consolidator = new EpisodicConsolidator(semanticMemory, { logger });
          const result = await consolidator.consolidate(session.sessionStore, {
            bootstrapSession: session.id,
            clearPrevious: true,
          });
          logger.info(
            `[DimensionComplete] Semantic Memory consolidation: +${result?.total?.added || 0} ADD, ~${result?.total?.updated || 0} UPDATE`
          );
        }
      } catch (e: any) {
        logger.warn(`[DimensionComplete] SemanticMemory consolidation failed (non-blocking): ${e.message}`);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════
  // 7. Cross-Dimension Hints
  // ═══════════════════════════════════════════════════════════

  if (crossDimensionHints) {
    session.storeHints(dimensionId, crossDimensionHints);
  }
  const accumulatedHints = session.getAccumulatedHints();

  // ═══════════════════════════════════════════════════════════
  // 8. 构建响应 (v2: 含质量评估 + 跨维度证据)
  // ═══════════════════════════════════════════════════════════

  // v2: 获取跨维度累积证据 (帮助外部 Agent 做下游维度时避免重复和借鉴)
  const accumulatedEvidence = session.submissionTracker.getAccumulatedEvidence(dimensionId);

  // v2: 质量反馈构建
  let qualityFeedback;
  if (qualityReport) {
    qualityFeedback = {
      totalScore: qualityReport.totalScore,
      pass: qualityReport.pass,
      scores: qualityReport.scores,
      suggestions: qualityReport.suggestions.length > 0
        ? qualityReport.suggestions
        : undefined,
    };
    if (qualityReport.pass) {
      logger.info(
        `[DimensionComplete] Quality assessment for "${dimensionId}": score=${qualityReport.totalScore}/100 PASS`,
      );
    } else {
      logger.warn(
        `[DimensionComplete] Quality assessment for "${dimensionId}": score=${qualityReport.totalScore}/100 BELOW_THRESHOLD`,
      );
    }
  }

  // Wiki 生成提示（冷启动完成时）
  const nextActions = isComplete ? BOOTSTRAP_COMPLETE_ACTIONS : undefined;

  // v2: 为下游维度构建结构化提示 (基于累积证据)
  let evidenceHints;
  if (
    !isComplete &&
    (accumulatedEvidence.completedDimSummaries.length > 0 ||
      accumulatedEvidence.negativeSignals.length > 0)
  ) {
    evidenceHints = {
      previousSubmissions: accumulatedEvidence.completedDimSummaries.map((s) => ({
        dimId: s.dimId,
        submissionCount: s.submissionCount,
        titles: s.titles,
        referencedFiles: s.referencedFiles,
      })),
      // v3: 从 SessionStore 提取前序维度分析摘要 + 关键发现（对标内部 Agent 的 buildContextForDimension）
      previousDimensionAnalysis: (() => {
        try {
          const summaries = [];
          for (const dimSummary of accumulatedEvidence.completedDimSummaries) {
            const report = session.sessionStore.getDimensionReport(dimSummary.dimId);
            if (report) {
              summaries.push({
                dimId: dimSummary.dimId,
                analysisSummary: (report.analysisText || '').substring(0, 500),
                keyFindings: (report.findings || [])
                  .slice(0, 5)
                  .map((f) => f.finding || f.content || ''),
              });
            }
          }
          return summaries.length > 0 ? summaries : undefined;
        } catch {
          return undefined;
        }
      })(),
      sharedFiles: accumulatedEvidence.sharedFiles.length > 0
        ? accumulatedEvidence.sharedFiles
        : undefined,
      negativeSignals: accumulatedEvidence.negativeSignals.length > 0
        ? accumulatedEvidence.negativeSignals.map((s) => s.pattern)
        : undefined,
      usedTriggers: accumulatedEvidence.usedTriggers.length > 0
        ? accumulatedEvidence.usedTriggers
        : undefined,
      _note: '以上为前序维度的分析证据，包含分析摘要和关键发现。请利用其中的文件引用和负空间信号，避免重复分析已覆盖的内容',
    };
  }

  return envelope({
    success: true,
    data: {
      dimensionId,
      updated, // true = 覆盖了已有记录（幂等更新）
      skillCreated,
      recipesBound,
      progress: `${progress.completed}/${progress.total}`,
      completedDimensions: progress.completedDimIds,
      remainingDimensions: progress.remainingDimIds,
      isBootstrapComplete: isComplete,
      accumulatedHints:
        Object.keys(accumulatedHints).length > 0 ? accumulatedHints : undefined,
      // v2: 质量评估反馈
      qualityFeedback,
      // v2: 跨维度证据 (供后续维度利用)
      evidenceHints,
      nextActions,
    },
    meta: {
      tool: 'autosnippet_dimension_complete',
      responseTimeMs: Date.now() - t0,
    },
  });
}


