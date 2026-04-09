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

import Logger from '#infra/logging/Logger.js';
import { BootstrapEventEmitter } from '#service/bootstrap/BootstrapEventEmitter.js';
import { getDeveloperIdentity } from '#shared/developer-identity.js';
import { envelope } from '../envelope.js';
import { saveDimensionCheckpoint } from './bootstrap/pipeline/checkpoint.js';
import { BOOTSTRAP_COMPLETE_ACTIONS } from './bootstrap/shared/dimension-text.js';
import { generateSkill } from './bootstrap/shared/skill-generator.js';
import { getActiveSession } from './bootstrap-external.js';
import type { McpContext } from './types.js';

const logger = Logger.getInstance();

// ── 主入口 ─────────────────────────────────────────────────────

/**
 * dimensionComplete — 维度分析完成通知
 *
 * @param ctx { container, logger, startedAt }
 * @param args 工具参数
 * @param [args.sessionId] bootstrap 返回的 session.id
 * @param args.dimensionId 维度 ID
 * @param args.submittedRecipeIds 本维度提交的 recipe ID 列表
 * @param args.analysisText 分析报告全文（Markdown）
 * @param [args.referencedFiles] 引用的文件路径列表
 * @param [args.keyFindings] 关键发现摘要 (3-5 条)
 * @param [args.candidateCount] 本维度提交的候选数量
 * @param [args.crossDimensionHints] 对其他维度的建议
 */
interface DimensionCompleteArgs {
  sessionId?: string;
  dimensionId?: string;
  submittedRecipeIds?: string[];
  analysisText?: string;
  referencedFiles?: string[];
  keyFindings?: string[];
  candidateCount?: number;
  crossDimensionHints?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function dimensionComplete(ctx: McpContext, args: DimensionCompleteArgs) {
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
  const session = getActiveSession(
    ctx.container as Parameters<typeof getActiveSession>[0],
    sessionId
  );
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
  const dim = session.dimensions.find((d: { id: string }) => d.id === dimensionId);
  if (!dim) {
    return envelope({
      success: false,
      message: `Unknown dimensionId: "${dimensionId}". Valid dimensions: ${session.dimensions.map((d: { id: string }) => d.id).join(', ')}`,
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
        referencedFiles = [...filesFromSources] as string[];
        logger.debug(
          `[DimensionComplete] Auto-recovered ${referencedFiles.length} referencedFiles from submissions for "${dimensionId}"`
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
      const recoveredIds = submissions
        .map((s) => s.recipeId)
        .filter((id): id is string => Boolean(id));
      if (recoveredIds.length > 0) {
        submittedRecipeIds = recoveredIds;
        logger.debug(
          `[DimensionComplete] Auto-recovered ${submittedRecipeIds.length} submittedRecipeIds from tracker for "${dimensionId}"`
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
              let existingTags: string[] = [];
              if (Array.isArray(entry.tags)) {
                existingTags = entry.tags;
              } else if (typeof entry.tags === 'string') {
                try {
                  const parsed = JSON.parse(entry.tags);
                  existingTags = Array.isArray(parsed) ? parsed : [];
                } catch {
                  // tags 不是有效 JSON，尝试按逗号分割
                  existingTags = entry.tags
                    .split(',')
                    .map((t: string) => t.trim())
                    .filter(Boolean);
                }
              }
              const newTags = [
                ...new Set([
                  ...existingTags,
                  `dimension:${dimensionId}`,
                  `bootstrap:${session.id}`,
                ]),
              ];
              await knowledgeService.update(
                recipeId,
                {
                  category: dimensionId,
                  tags: newTags,
                },
                { userId: getDeveloperIdentity() }
              );
              recipesBound++;
            }
          } catch (e: unknown) {
            logger.debug(
              `[DimensionComplete] Failed to tag recipe ${recipeId}: ${e instanceof Error ? e.message : String(e)}`
            );
          }
        }
      }
    } catch (e: unknown) {
      logger.warn(
        `[DimensionComplete] Recipe tagging failed (degraded): ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 2. Skill 生成 (skillWorthy 维度) — 使用共享 skill-generator
  //    如果 analysisText 太短，自动从已提交的候选知识中合成结构化内容
  // ═══════════════════════════════════════════════════════════

  let skillCreated = false;
  if (dim.skillWorthy) {
    let effectiveAnalysis = analysisText;

    // 当 analysisText 不足以通过质量门控时，从候选知识中合成
    if (analysisText.length < 500 && submittedRecipeIds.length > 0) {
      try {
        const knowledgeService = ctx.container.get('knowledgeService');
        if (knowledgeService) {
          const parts: string[] = [`## ${dim.label || dimensionId} — 分析报告\n`];

          if (analysisText.trim().length > 0) {
            parts.push(analysisText.trim(), '');
          }

          for (const recipeId of submittedRecipeIds) {
            const entry = await knowledgeService.get(recipeId);
            if (!entry) {
              continue;
            }
            parts.push(`### ${entry.title || 'Untitled'}`);
            if (entry.description) {
              parts.push(entry.description);
            }
            if (entry.whenClause || entry.doClause || entry.dontClause) {
              parts.push('');
              if (entry.whenClause) {
                parts.push(`- **When**: ${entry.whenClause}`);
              }
              if (entry.doClause) {
                parts.push(`- **Do**: ${entry.doClause}`);
              }
              if (entry.dontClause) {
                parts.push(`- **Don't**: ${entry.dontClause}`);
              }
            }
            if (entry.coreCode) {
              parts.push('', '```', entry.coreCode.substring(0, 500), '```');
            }
            parts.push('');
          }

          if (keyFindings.length > 0) {
            parts.push('## Key Findings', '');
            for (const f of keyFindings) {
              parts.push(`- ${f}`);
            }
          }

          const synthesized = parts.join('\n');
          if (synthesized.length > effectiveAnalysis.length) {
            effectiveAnalysis = synthesized;
            logger.info(
              `[DimensionComplete] Synthesized analysisText for "${dimensionId}" from ${submittedRecipeIds.length} candidates (${analysisText.length} → ${synthesized.length} chars)`
            );
          }
        }
      } catch (e: unknown) {
        logger.debug(
          `[DimensionComplete] Failed to synthesize analysisText: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    const skillResult = await generateSkill(
      ctx,
      dim,
      effectiveAnalysis,
      referencedFiles,
      keyFindings,
      'external-agent-bootstrap'
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
  } catch (e: unknown) {
    logger.warn(
      `[DimensionComplete] Checkpoint save failed: ${e instanceof Error ? e.message : String(e)}`
    );
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
          dimensionId,
          'dimension',
          finding.substring(0, 80),
          'finding',
          'discovered_in',
          { source: 'external-agent-bootstrap', sessionId: session.id }
        );
      }
    }
  } catch (e: unknown) {
    logger.debug(
      `[DimensionComplete] SemanticMemory fixation skipped: ${e instanceof Error ? e.message : String(e)}`
    );
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
  // 6.5 Bootstrap 完成后，自动触发 Delivery / Panorama / Wiki / SemanticMemory (R4/R4.5/R5/R6)
  // ═══════════════════════════════════════════════════════════

  let deliveryVerification:
    | import('#service/bootstrap/DeliveryVerifier.js').DeliveryVerification
    | null = null;

  if (isComplete) {
    // R4: 自动触发 Cursor Delivery
    try {
      const { getServiceContainer } = await import('#inject/ServiceContainer.js');
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
    } catch (e: unknown) {
      logger.warn(
        `[DimensionComplete] Auto CursorDelivery failed (non-blocking): ${e instanceof Error ? e.message : String(e)}`
      );
    }

    // R4+: DeliveryVerifier — 交付完整性检查
    try {
      const { DeliveryVerifier } = await import('#service/bootstrap/DeliveryVerifier.js');
      const { resolveProjectRoot } = await import('#shared/resolveProjectRoot.js');
      const projectRoot = resolveProjectRoot(ctx.container);
      const verifier = new DeliveryVerifier(projectRoot);
      const verification = verifier.verify();
      if (!verification.allPassed) {
        logger.warn('[DimensionComplete] Delivery verification incomplete', {
          failures: verification.failures,
        });
      } else {
        logger.info('[DimensionComplete] Delivery verification passed — all channels OK');
      }
      // 附加到响应中的 completionExtras
      deliveryVerification = verification;
    } catch (e: unknown) {
      logger.warn(
        `[DimensionComplete] DeliveryVerifier failed (non-blocking): ${e instanceof Error ? e.message : String(e)}`
      );
    }

    // R4.5: Panorama 数据刷新（冷启动完成后知识库已填充，需重新计算全景）
    try {
      const { getServiceContainer: getPanoramaContainer } = await import(
        '#inject/ServiceContainer.js'
      );
      const panoramaContainer = getPanoramaContainer();
      const panoramaService = panoramaContainer.services.panoramaService
        ? panoramaContainer.get('panoramaService')
        : null;
      if (
        panoramaService &&
        typeof (panoramaService as { rescan?: () => Promise<void> }).rescan === 'function'
      ) {
        await (panoramaService as { rescan: () => Promise<void> }).rescan();
        const overview = (
          panoramaService as { getOverview: () => { moduleCount: number; gapCount: number } }
        ).getOverview();
        logger.info(
          `[DimensionComplete] Panorama refreshed — ${overview.moduleCount} modules, ${overview.gapCount} gaps`
        );
      }
    } catch (e: unknown) {
      logger.warn(
        `[DimensionComplete] Panorama refresh failed (non-blocking): ${e instanceof Error ? e.message : String(e)}`
      );
    }

    // R5: 自动触发 Wiki 生成 (fire-and-forget)
    setImmediate(async () => {
      try {
        const { getServiceContainer: getWikiContainer } = await import(
          '#inject/ServiceContainer.js'
        );
        const wikiContainer = getWikiContainer();
        const { WikiGenerator } = await import('#service/wiki/WikiGenerator.js');
        const moduleService = wikiContainer.get?.('moduleService');
        const knowledgeService = wikiContainer.get?.('knowledgeService');
        if (moduleService && knowledgeService) {
          const wikiGen = new WikiGenerator({
            projectRoot,
            moduleService,
            knowledgeService,
            options: { mode: 'bootstrap' },
          } as unknown as ConstructorParameters<typeof WikiGenerator>[0]);
          const wikiResult = await wikiGen.generate();
          logger.info(
            `[DimensionComplete] Auto Wiki generation: ${(wikiResult as { totalPages?: number })?.totalPages || 0} pages`
          );
        }
      } catch (e: unknown) {
        logger.warn(
          `[DimensionComplete] Wiki generation failed (non-blocking): ${e instanceof Error ? e.message : String(e)}`
        );
      }
    });

    // R6: 全量 Semantic Memory 固化 (fire-and-forget)
    setImmediate(async () => {
      try {
        const { EpisodicConsolidator } = await import('#agent/domain/EpisodicConsolidator.js');
        const db = ctx.container.get?.('database') ?? ctx.container.get?.('db');
        if (db && session.sessionStore) {
          const { PersistentMemory } = await import('#agent/memory/PersistentMemory.js');
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
      } catch (e: unknown) {
        logger.warn(
          `[DimensionComplete] SemanticMemory consolidation failed (non-blocking): ${e instanceof Error ? e.message : String(e)}`
        );
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
  let qualityFeedback: Record<string, unknown> | undefined;
  if (qualityReport) {
    qualityFeedback = {
      totalScore: qualityReport.totalScore,
      pass: qualityReport.pass,
      scores: qualityReport.scores,
      suggestions: qualityReport.suggestions.length > 0 ? qualityReport.suggestions : undefined,
    };
    if (qualityReport.pass) {
      logger.info(
        `[DimensionComplete] Quality assessment for "${dimensionId}": score=${qualityReport.totalScore}/100 PASS`
      );
    } else {
      logger.warn(
        `[DimensionComplete] Quality assessment for "${dimensionId}": score=${qualityReport.totalScore}/100 BELOW_THRESHOLD`
      );
    }
  }

  // Wiki 生成提示（冷启动完成时）
  const nextActions = isComplete ? BOOTSTRAP_COMPLETE_ACTIONS : undefined;

  // §9: 子包覆盖校验 — 检查 referencedFiles 是否覆盖了关键本地子包
  let subpackageCoverageWarning: string | undefined;
  try {
    const snapshotCache = session.getSnapshotCache?.();
    const localPkgs = snapshotCache?.localPackageModules;
    if (localPkgs && localPkgs.length > 0 && referencedFiles.length > 0) {
      const uncoveredPkgs: string[] = [];
      for (const pkg of localPkgs) {
        const pkgPrefix = pkg.packageName.replace(/\/$/, '');
        const covered = referencedFiles.some((f) => f.includes(pkgPrefix) || f.includes(pkg.name));
        if (!covered) {
          uncoveredPkgs.push(pkg.name);
        }
      }
      if (uncoveredPkgs.length > 0) {
        subpackageCoverageWarning =
          `本维度未覆盖以下本地子包: ${uncoveredPkgs.join(', ')}。` +
          `建议在分析中纳入这些模块的源码，以确保知识库完整性。`;
        logger.info(
          `[DimensionComplete] Subpackage coverage gap for "${dimensionId}": ${uncoveredPkgs.join(', ')}`
        );
      }
    }
  } catch {
    /* best effort */
  }

  // v2: 为下游维度构建结构化提示 (基于累积证据)
  let evidenceHints: Record<string, unknown> | undefined;
  if (
    !isComplete &&
    (accumulatedEvidence.completedDimSummaries.length > 0 ||
      accumulatedEvidence.negativeSignals.length > 0)
  ) {
    evidenceHints = {
      previousSubmissions: accumulatedEvidence.completedDimSummaries.map(
        (s: {
          dimId: string;
          submissionCount: number;
          titles: string[];
          referencedFiles: string[];
        }) => ({
          dimId: s.dimId,
          submissionCount: s.submissionCount,
          titles: s.titles,
          referencedFiles: s.referencedFiles,
        })
      ),
      // v3: 从 SessionStore 提取前序维度分析摘要 + 关键发现（对标内部 Agent 的 buildContextForDimension）
      previousDimensionAnalysis: (() => {
        try {
          const summaries: { dimId: string; analysisSummary: string; keyFindings: string[] }[] = [];
          for (const dimSummary of accumulatedEvidence.completedDimSummaries) {
            const report = session.sessionStore.getDimensionReport(dimSummary.dimId);
            if (report) {
              summaries.push({
                dimId: dimSummary.dimId,
                analysisSummary: (report.analysisText || '').substring(0, 500),
                keyFindings: (report.findings || [])
                  .slice(0, 5)
                  .map((f: { finding?: string; content?: string }) => f.finding || f.content || ''),
              });
            }
          }
          return summaries.length > 0 ? summaries : undefined;
        } catch {
          return undefined;
        }
      })(),
      sharedFiles:
        accumulatedEvidence.sharedFiles.length > 0 ? accumulatedEvidence.sharedFiles : undefined,
      negativeSignals:
        accumulatedEvidence.negativeSignals.length > 0
          ? accumulatedEvidence.negativeSignals.map((s: { pattern?: string }) => s.pattern)
          : undefined,
      usedTriggers:
        accumulatedEvidence.usedTriggers.length > 0 ? accumulatedEvidence.usedTriggers : undefined,
      _note:
        '以上为前序维度的分析证据，包含分析摘要和关键发现。请利用其中的文件引用和负空间信号，避免重复分析已覆盖的内容',
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
      accumulatedHints: Object.keys(accumulatedHints).length > 0 ? accumulatedHints : undefined,
      // v2: 质量评估反馈
      qualityFeedback,
      // v2: 跨维度证据 (供后续维度利用)
      evidenceHints,
      // v3: 子包覆盖校验警告
      subpackageCoverageWarning,
      // v3.1: 交付完整性验证 (仅 bootstrap 完成时)
      deliveryVerification: isComplete ? deliveryVerification : undefined,
      nextActions,
    },
    meta: {
      tool: 'autosnippet_dimension_complete',
      responseTimeMs: Date.now() - t0,
    },
  });
}
