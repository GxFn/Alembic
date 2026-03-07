/**
 * orchestrator.js — 内部 Agent AI-First Bootstrap 管线
 *
 * ⚠️ 本文件是「内部 Agent」专用 — 由 bootstrap.js Phase 5 调用。
 *    外部 Agent (Cursor/Copilot) 不经过此管线，它们自行分析代码。
 *
 * 核心架构: PipelineStrategy 驱动 (Analyze → QualityGate → Produce → RejectionGate)
 *
 * 1. Analyze 阶段: 自由探索代码 (AST 工具 + 文件搜索)
 * 2. QualityGate: 质量门控 (insightGateEvaluator)
 * 3. Produce 阶段: 格式化输出 (submit_knowledge)
 * 4. TierScheduler 分层并行执行
 *
 * @module pipeline/orchestrator
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import Logger from '../../../../../infrastructure/logging/Logger.js';
import { AgentMessage } from '../../../../../service/agent/AgentMessage.js';
import { ExplorationTracker } from '../../../../../service/agent/context/ExplorationTracker.js';
import { EpisodicConsolidator } from '../../../../../service/agent/domain/EpisodicConsolidator.js';
import { ANALYST_BUDGET } from '../../../../../service/agent/domain/insight-analyst.js';
import { MemoryCoordinator } from '../../../../../service/agent/memory/MemoryCoordinator.js';
import { PersistentMemory } from '../../../../../service/agent/memory/PersistentMemory.js';
import { SessionStore } from '../../../../../service/agent/memory/SessionStore.js';
import { PRESETS } from '../../../../../service/agent/presets.js';
import { BootstrapEventEmitter } from '../../../../../shared/BootstrapEventEmitter.js';
import type { IncrementalPlan, McpContext } from '../../types.js';
import type { BaseDimension } from '../base-dimensions.js';
import { getDimensionFocusKeywords } from '../shared/dimension-sop.js';
import { generateSkill } from '../shared/skill-generator.js';
import { clearCheckpoints, loadCheckpoints, saveDimensionCheckpoint } from './checkpoint.js';
import {
  buildTierReflection,
  DIMENSION_CONFIGS_V3,
  getFullDimensionConfig,
} from './dimension-configs.js';
import { DimensionContext, parseDimensionDigest } from './dimension-context.js';
import { IncrementalBootstrap } from './IncrementalBootstrap.js';
import { runNoAiFallback } from './noAiFallback.js';
import { TierScheduler } from './tier-scheduler.js';

const logger = Logger.getInstance();

// ── TypeScript Interfaces ────────────────────────────────────

/** Extended DI container shape for orchestrator (supports buildProjectGraph etc.) */
interface OrchestratorContainer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DI container: callers know the service type
  get(name: string): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic DI container shape
  [key: string]: any;
}

/** Orchestrator context (extended McpContext) */
interface OrchestratorContext {
  container: OrchestratorContainer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic ctx shape from various callers
  [key: string]: any;
}

/** ProjectGraph minimal shape */
interface ProjectGraphLike {
  getOverview(): { totalClasses: number; totalProtocols: number; [key: string]: unknown };
  [key: string]: unknown;
}

/** Fill context passed from bootstrapKnowledge to fillDimensionsV3 */
interface FillContextV3 {
  ctx: OrchestratorContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic shape from bootstrapKnowledge; properties vary per caller
  [key: string]: any;
}

/** Bootstrap file entry */
interface BootstrapFileEntry {
  name: string;
  path: string;
  relativePath: string;
  content: string;
  targetName?: string;
}

/** Task manager minimal shape */
interface TaskManagerLike {
  isSessionValid(sessionId: string): boolean;
  emitProgress?(event: string, data: Record<string, unknown>): void;
  [key: string]: unknown;
}

/** Agent factory minimal shape */
interface AgentFactoryLike {
  createRuntime(preset: string, overrides?: Record<string, unknown>): AgentRuntimeLike;
  createContextWindow(opts?: { isSystem?: boolean }): unknown;
  [key: string]: unknown;
}

/** Agent runtime minimal shape */
interface AgentRuntimeLike {
  execute(message: unknown, opts?: Record<string, unknown>): Promise<AgentResultLike>;
  setFileCache(files: unknown[] | null): void;
  aiProvider: { name?: string; model?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Agent execution result */
interface AgentResultLike {
  reply?: string;
  toolCalls?: ToolCallRecord[];
  tokenUsage?: { input: number; output: number };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- phase results have dynamic shapes from agent execution
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- phase results have dynamic shapes from agent execution
  phases?: Record<string, { reply?: string; artifact?: Record<string, any>; [key: string]: any }>;
  degraded?: boolean;
  [key: string]: unknown;
}

/** Tool call record from runtime */
interface ToolCallRecord {
  tool?: string;
  name?: string;
  args?: Record<string, unknown>;
  params?: Record<string, unknown>;
  result?: unknown;
  [key: string]: unknown;
}

/** Dimension execution statistics */
interface DimensionStat {
  candidateCount: number;
  rejectedCount?: number;
  analysisChars?: number;
  referencedFiles?: number;
  referencedFilesList?: string[];
  durationMs: number;
  toolCallCount?: number;
  tokenUsage?: { input: number; output: number };
  skipped?: boolean;
  restoredFromCheckpoint?: boolean;
  restoredFromIncremental?: boolean;
  analysisText?: string;
  error?: string;
  [key: string]: unknown;
}

/** Candidate results accumulator */
interface CandidateResults {
  created: number;
  failed: number;
  errors: Array<{ dimId: string; error: string }>;
}

/** Dimension candidate data (analysis + producer) */
interface DimensionCandidateData {
  analysisReport: {
    dimensionId?: string;
    analysisText: string;
    findings: unknown[];
    referencedFiles: string[];
    evidenceMap?: unknown;
    negativeSignals?: unknown[];
    metadata?: Record<string, unknown>;
  };
  producerResult: {
    candidateCount: number;
    rejectedCount?: number;
    toolCalls: ToolCallRecord[];
    reply?: string;
    tokenUsage?: { input: number; output: number };
  };
}

/** Skill generation results */
interface SkillResults {
  created: number;
  failed: number;
  skills: string[];
  errors: Array<{ dimId: string; error: string }>;
}

/** Bootstrap report structure */
interface BootstrapReport {
  version: string;
  timestamp: string;
  project: { name: string; files: number; lang: string };
  duration: { totalMs: number; totalSec: number };
  dimensions: Record<string, Record<string, unknown>>;
  totals: Record<string, unknown>;
  checkpoints: { restored: string[] };
  incremental: Record<string, unknown> | null;
  semanticMemory: Record<string, unknown> | null;
  codeEntityGraph?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Consolidation result from EpisodicConsolidator */
interface ConsolidationResult {
  total: { added: number; updated: number; merged: number; skipped: number };
  durationMs: number;
  [key: string]: unknown;
}

/** Dimension finding entry */
interface DimensionFinding {
  finding?: string;
  importance?: number;
  [key: string]: unknown;
}

/** Wiki generation result */
interface WikiResult {
  success: boolean;
  filesGenerated?: number;
  aiComposed?: number;
  syncedDocs?: number;
  dedup?: { removed?: unknown[] };
  duration?: number;
  error?: string;
  [key: string]: unknown;
}

// ──────────────────────────────────────────────────────────────────
// fillDimensionsV3 — v3.0 管线入口
// ──────────────────────────────────────────────────────────────────

/**
 * fillDimensionsV3 — v3.0 AI-First 维度填充管线
 *
 * @param {object} fillContext 由 bootstrapKnowledge 构建的上下文
 */
export async function fillDimensionsV3(fillContext: FillContextV3) {
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
  const emitter = new BootstrapEventEmitter(ctx.container);
  logger.info(
    `[Insight-v3] ═══ fillDimensionsV3 entered — ${isIncremental ? 'INCREMENTAL' : 'FULL'} pipeline`
  );

  let allFiles = fillContext.allFiles;
  fillContext.allFiles = null;

  // ═══════════════════════════════════════════════════════════
  // Step 0: AI 可用性检查 (v7.2: 使用 AgentFactory)
  // ═══════════════════════════════════════════════════════════
  let agentFactory: AgentFactoryLike | null = null;
  try {
    agentFactory = ctx.container.get('agentFactory');
    // 检查 AI Provider 是否可用
    const aiProvider = ctx.container.singletons?.aiProvider;
    if (!aiProvider || aiProvider.name === 'mock') {
      agentFactory = null;
    }
  } catch {
    /* not available */
  }

  if (!agentFactory) {
    logger.info('[Insight-v3] AI not available — entering rule-based fallback');
    emitter.emitProgress('bootstrap:ai-unavailable', {
      message: 'AI 不可用，将使用规则化降级提取基础知识。请配置 AI Provider 以获取完整分析。',
    });

    // ── 规则化降级: 从 Phase 0-4 数据中提取基础知识 ──
    try {
      fillContext.allFiles = allFiles;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- FillContextV3 is structurally compatible with FillContext at runtime
      const fallbackResult = await runNoAiFallback(
        fillContext as unknown as Parameters<typeof runNoAiFallback>[0]
      );

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
                  trigger: candidate.trigger || '',
                  doClause: candidate.doClause || '',
                  dontClause: candidate.dontClause || '',
                  whenClause: candidate.whenClause || '',
                  coreCode: candidate.coreCode || '',
                },
                { userId: 'bootstrap-fallback' }
              );
              persistedCount++;
            } catch (entryErr: unknown) {
              logger.warn(
                `[Bootstrap-fallback] Candidate "${candidate.title}" persist failed: ${entryErr instanceof Error ? entryErr.message : String(entryErr)}`
              );
            }
          }
          logger.info(
            `[Bootstrap-fallback] ${persistedCount}/${fallbackResult.candidates.length} candidates persisted to DB`
          );
        } catch (svcErr: unknown) {
          logger.warn(
            `[Bootstrap-fallback] KnowledgeService not available — candidates not persisted: ${svcErr instanceof Error ? svcErr.message : String(svcErr)}`
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
            } catch (skErr: unknown) {
              logger.warn(
                `[Bootstrap-fallback] Skill "${sk.name}" write failed: ${skErr instanceof Error ? skErr.message : String(skErr)}`
              );
            }
          }
        } catch (importErr: unknown) {
          logger.warn(
            `[Bootstrap-fallback] Skill module import failed: ${importErr instanceof Error ? importErr.message : String(importErr)}`
          );
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
      emitter.emitProgress('bootstrap:fallback-complete', {
        message: `降级产出完成: ${persistedCount} 条知识已入库, ${skillsCreated} 个 Skill 已生成`,
        candidates: persistedCount,
        skills: skillsCreated,
        errors: fallbackResult.report.errors.length,
      });

      // ── R7: No-AI 降级路径完成后也触发 Cursor Delivery ──
      if (persistedCount > 0 || skillsCreated > 0) {
        try {
          const { getServiceContainer } = await import(
            '../../../../../injection/ServiceContainer.js'
          );
          const deliveryContainer = getServiceContainer();
          if (deliveryContainer.services.cursorDeliveryPipeline) {
            const pipeline = deliveryContainer.get('cursorDeliveryPipeline');
            const deliveryResult = await pipeline.deliver();
            logger.info(
              `[Bootstrap-fallback] Cursor Delivery complete — ` +
                `A: ${deliveryResult.channelA?.rulesCount || 0}, ` +
                `B: ${deliveryResult.channelB?.topicCount || 0}, ` +
                `F: ${deliveryResult.channelF?.filesWritten || 0}`
            );
          }
        } catch (deliveryErr: unknown) {
          logger.warn(
            `[Bootstrap-fallback] CursorDelivery failed (non-blocking): ${deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr)}`
          );
        }
      }

      logger.info(
        `[Bootstrap-fallback] Completed: ${persistedCount} candidates persisted, ` +
          `${skillsCreated} skills written, ${fallbackResult.report.errors.length} errors`
      );
    } catch (fallbackErr: unknown) {
      logger.error(
        `[Bootstrap-fallback] Fallback failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`
      );
      // 即使降级也失败，仍标记所有维度为 skipped
      for (const dim of dimensions) {
        emitter.emitDimensionComplete(dim.id, { type: 'skipped', reason: 'fallback-failed' });
      }
    }
    return;
  }

  // ═══════════════════════════════════════════════════════════
  // Step 0.5: 构建 ProjectGraph
  // ═══════════════════════════════════════════════════════════
  let projectGraph: ProjectGraphLike | null = null;
  try {
    projectGraph = await ctx.container.buildProjectGraph(projectRoot, {
      maxFiles: 500,
      timeoutMs: 15_000,
    });
    if (projectGraph) {
      const overview = projectGraph.getOverview();
      logger.info(
        `[Insight-v3] ProjectGraph: ${overview.totalClasses} classes, ${overview.totalProtocols} protocols (${(overview as Record<string, unknown>).buildTimeMs}ms)`
      );
    }
  } catch (e: unknown) {
    logger.warn(
      `[Insight-v3] ProjectGraph build failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // ═══════════════════════════════════════════════════════════
  // Step 1: 构建 Agents + 上下文
  // ═══════════════════════════════════════════════════════════
  logger.info(
    '[Insight-v7] Using unified AgentRuntime pipeline (no legacy Analyst/Producer wrappers)'
  );

  // 注入文件缓存到容器 (v7.2: 通过容器传递)
  ctx.container.singletons._fileCache = allFiles;

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

  // v4.0: SessionStore — 替代 EpisodicMemory + ToolResultCache
  // v5.0: 增量模式下从快照恢复已完成维度的记忆
  let sessionStore: SessionStore;
  if (isIncremental && incrementalPlan.restoredEpisodic) {
    sessionStore = incrementalPlan.restoredEpisodic;
    const restoredDims = sessionStore.getCompletedDimensions();
    logger.info(
      `[Insight-v3] Restored SessionStore: ${restoredDims.length} dims [${restoredDims.join(', ')}]`
    );

    // 同步恢复 DimensionContext 的 digests (兼容)
    for (const dimId of restoredDims) {
      const report = sessionStore.getDimensionReport(dimId);
      if (report?.digest) {
        dimContext.addDimensionDigest(
          dimId,
          report.digest as Parameters<typeof dimContext.addDimensionDigest>[1]
        );
      }
    }
  } else {
    sessionStore = new SessionStore({
      projectName: projectInfo.name,
      primaryLang: projectInfo.lang,
      fileCount: projectInfo.fileCount,
      modules: Object.keys(fillContext.targetFileMap || {}),
    });
  }

  // v4.1: PersistentMemory — 项目级永久语义记忆 (Tier 3)
  // 加载历史 bootstrap 记忆 → 注入 Analyst promptBuilder
  let semanticMemory: PersistentMemory | null = null;
  try {
    const db = ctx.container.get('database');
    if (db) {
      semanticMemory = new PersistentMemory(db, { logger });
      const smStats = semanticMemory.getStats();
      if (smStats.total > 0) {
        logger.info(
          `[Insight-v3] Loaded ${smStats.total} semantic memories from previous bootstrap ` +
            `(fact: ${smStats.byType.fact || 0}, insight: ${smStats.byType.insight || 0}, preference: ${smStats.byType.preference || 0})`
        );
      }
    }
  } catch (smErr: unknown) {
    logger.warn(
      `[Insight-v3] SemanticMemory init failed (non-blocking): ${smErr instanceof Error ? smErr.message : String(smErr)}`
    );
  }

  // Phase E: CodeEntityGraph — 代码实体关系图谱 (供 Analyst prompt 注入)
  let codeEntityGraphInst: { getTopology(): { totalEntities: number; totalEdges: number } } | null =
    null;
  try {
    const { CodeEntityGraph } = await import('../../../../../service/knowledge/CodeEntityGraph.js');
    const db = ctx.container.get('database');
    if (db) {
      codeEntityGraphInst = new CodeEntityGraph(db, { projectRoot, logger });
      const topo = codeEntityGraphInst.getTopology();
      if (topo.totalEntities > 0) {
        logger.info(
          `[Insight-v3] CodeEntityGraph: ${topo.totalEntities} entities, ${topo.totalEdges} edges`
        );
      }
    }
  } catch (cegErr: unknown) {
    logger.warn(
      `[Insight-v3] CodeEntityGraph init failed (non-blocking): ${cegErr instanceof Error ? cegErr.message : String(cegErr)}`
    );
  }

  // v5.0: MemoryCoordinator — 统一记忆协调器 (会话级)
  const memoryCoordinator = new MemoryCoordinator({
    persistentMemory: semanticMemory,
    sessionStore,
    mode: 'bootstrap',
  });

  // ═══════════════════════════════════════════════════════════
  // Step 2: 按维度分层执行 (Analyst → Gate → Producer)
  // ═══════════════════════════════════════════════════════════
  const concurrency = parseInt(process.env.ASD_PARALLEL_CONCURRENCY || '3', 10);
  const enableParallel = process.env.ASD_PARALLEL_BOOTSTRAP !== 'false';
  const scheduler = new TierScheduler();

  // 包含所有维度（含 Enhancement Pack 动态追加的维度）
  const activeDimIds = dimensions.map((d: BaseDimension) => d.id);

  // v5.0: 增量模式 — 仅执行受影响维度, 跳过未变更维度
  const incrementalSkippedDims: string[] = [];
  if (isIncremental) {
    const affected = new Set(incrementalPlan.affectedDimensions);
    for (const dimId of activeDimIds) {
      if (!affected.has(dimId) && incrementalPlan.skippedDimensions.includes(dimId)) {
        incrementalSkippedDims.push(dimId);
        // 标记为已完成 (使用历史结果)
        emitter.emitDimensionComplete(dimId, {
          type: 'incremental-restored',
          reason: 'no-change-detected',
        });
      }
    }
    if (incrementalSkippedDims.length > 0) {
      logger.info(
        `[Insight-v3] ⏩ Incremental skip: [${incrementalSkippedDims.join(', ')}] ` +
          `(using historical results)`
      );
    }
  }

  logger.info(
    `[Insight-v3] Active dimensions: [${activeDimIds.join(', ')}], concurrency=${enableParallel ? concurrency : 1}${isIncremental ? `, incremental skip: [${incrementalSkippedDims.join(', ')}]` : ''}`
  );

  // ── P3: 断点续传 — 加载有效 checkpoints ──
  const completedCheckpoints = await loadCheckpoints(projectRoot);
  const skippedDims: string[] = [];
  for (const [dimId, checkpoint] of completedCheckpoints) {
    if (activeDimIds.includes(dimId)) {
      // 恢复 DimensionContext 中的 digest
      if (checkpoint.digest) {
        dimContext.addDimensionDigest(dimId, checkpoint.digest);
        // v4.0: 同步恢复到 SessionStore
        sessionStore.addDimensionDigest(dimId, checkpoint.digest);
      }
      emitter.emitDimensionComplete(dimId, {
        type: 'checkpoint-restored',
        ...checkpoint,
      });
      skippedDims.push(dimId);
      logger.info(`[Insight-v3] ⏩ 跳过已完成维度 (checkpoint): "${dimId}"`);
    }
  }

  const candidateResults: CandidateResults = { created: 0, failed: 0, errors: [] };
  const dimensionCandidates: Record<string, DimensionCandidateData> = {};
  const dimensionStats: Record<string, DimensionStat> = {}; // P4.2: 维度级统计

  // ── 跨维度去重集合 (实例级持久化，等效旧 ChatAgent.#globalSubmittedTitles/Patterns) ──
  const globalSubmittedTitles = new Set<string>();
  const globalSubmittedPatterns = new Set<string>();

  /**
   * 执行单个维度: Analyst → Gate → Producer
   */
  async function executeDimension(dimId: string) {
    // v5.0: 增量模式 — 跳过未受影响的维度 (使用历史 EpisodicMemory)
    if (incrementalSkippedDims.includes(dimId)) {
      const report = sessionStore.getDimensionReport(dimId);
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
      logger.info(`[Insight-v3] ⏩ "${dimId}" — incremental skip (historical result)`);
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
            findings: [],
            metadata: {},
          },
          producerResult: { candidateCount: cp.candidateCount || 0, toolCalls: [] },
        };
        sessionStore.storeDimensionReport(dimId, {
          analysisText: cp.analysisText,
          findings: [],
          referencedFiles: restoredFiles,
          candidatesSummary: [],
        });
        logger.info(
          `[Insight-v3] ✅ Checkpoint "${dimId}": analysisText restored (${cp.analysisText.length} chars) — Skill generation enabled`
        );
      }

      return cpResult;
    }

    const dim = dimensions.find((d: BaseDimension) => d.id === dimId);
    if (!dim) {
      return { candidateCount: 0, error: 'dimension not found' };
    }

    // 合并 v3 配置和原始维度配置 — 优先使用 getFullDimensionConfig()
    // Enhancement Pack 动态维度可能不在 DIMENSION_CONFIGS_V3 中 — 从 dim 本身构建配置
    const fullConfig = getFullDimensionConfig(dimId);
    const v3Config = (DIMENSION_CONFIGS_V3 as Record<string, any>)[dimId];
    const dimConfig = fullConfig
      ? {
          ...fullConfig,
          // focusKeywords: 用于 EpisodicMemory 跨维度 findings 相关性匹配
          focusKeywords: fullConfig.focusKeywords || [],
        }
      : v3Config
        ? {
            ...v3Config,
            id: dimId,
            label: dim.label,
            guide: dim.guide || '',
            focusKeywords: getDimensionFocusKeywords(dimId, dim.guide || ''),
            skillWorthy: dim.skillWorthy,
            dualOutput: dim.dualOutput,
            skillMeta: dim.skillMeta,
            knowledgeTypes: dim.knowledgeTypes || v3Config.allowedKnowledgeTypes,
          }
        : {
            id: dimId,
            label: dim.label,
            guide: dim.guide || '',
            focusKeywords: getDimensionFocusKeywords(dimId, dim.guide || ''),
            outputType: dim.dualOutput ? 'dual' : dim.skillWorthy ? 'skill' : 'candidate',
            allowedKnowledgeTypes: dim.knowledgeTypes || [],
            skillWorthy: dim.skillWorthy,
            dualOutput: dim.dualOutput,
            skillMeta: dim.skillMeta,
            knowledgeTypes: dim.knowledgeTypes || [],
          };

    // Session 有效性检查
    if (taskManager && !taskManager.isSessionValid(sessionId)) {
      logger.warn(`[Insight-v3] Session superseded — skipping "${dimId}"`);
      return { candidateCount: 0, error: 'session-superseded' };
    }

    emitter.emitDimensionStart(dimId);
    logger.info(`[Insight-v3] ── Dimension "${dimId}" (${dimConfig.label}) ──`);

    const dimStartTime = Date.now();

    try {
      // ═══ v3.0: 增强 PipelineStrategy 驱动 ═══
      const analystScopeId = `${dimId}:analyst`;
      memoryCoordinator.createDimensionScope(analystScopeId);

      const v3OutputType = (DIMENSION_CONFIGS_V3 as Record<string, any>)[dimId]?.outputType;
      const needsCandidates = v3OutputType
        ? v3OutputType !== 'skill'
        : !dimConfig.skillWorthy || dimConfig.dualOutput;

      // ── 获取 Preset 的标准 stages 配置作为基础 ──
      const presetStages = PRESETS.insight.strategy.stages;

      // ── 构建 per-dimension 的 stages ──
      // NOTE: onToolCall 不再注入 ac.recordToolCall — ToolExecutionPipeline 的
      // traceRecord 中间件已通过 loopCtx.trace 统一记录,避免同一 AC 上双重记录。
      const analyzeStage = {
        ...presetStages[0],
      };

      let stages;
      if (needsCandidates) {
        // 候选维度: Analyze→QualityGate→Produce→RejectionGate
        const produceStage = {
          ...presetStages[2],
          promptBuilder: (ctx: Record<string, unknown>) => {
            (memoryCoordinator as { allocateBudget(role: string): void }).allocateBudget(
              'producer'
            );
            return presetStages[2].promptBuilder?.(ctx);
          },
        };
        stages = [
          analyzeStage,
          presetStages[1], // quality_gate
          produceStage,
          presetStages[3], // rejection_gate
        ];
      } else {
        // Skill-only 维度: 仅 Analyze
        stages = [analyzeStage];
      }

      // ── 创建 Runtime (使用增强 PipelineStrategy) ──
      const runtime = agentFactory!.createRuntime('insight', {
        lang: primaryLang || projectInfo.lang || null,
        strategy: {
          type: 'pipeline',
          maxRetries: 1,
          stages,
        },
      });
      runtime.setFileCache(allFiles);

      // ── 构建消息 + strategyContext ──
      const message = AgentMessage.internal(`Bootstrap dimension: ${dimConfig.label}`, {
        sessionId,
        dimension: dimId,
        phase: 'bootstrap',
      });

      const strategyContext = {
        dimConfig,
        projectInfo,
        dimContext,
        sessionStore,
        semanticMemory,
        codeEntityGraph: codeEntityGraphInst,
        projectGraph: null, // ProjectGraph 在 orchestrator 级别可用时注入
        dimId,
        activeContext: memoryCoordinator.getActiveContext(analystScopeId),
        outputType: dimConfig.outputType || 'analysis',
        // ── 引擎增强参数 (PipelineStrategy → reactLoop 透传) ──
        contextWindow: agentFactory!.createContextWindow({ isSystem: true }),
        // B1 fix: 分析阶段使用 analyst 策略 (SCAN→EXPLORE→VERIFY→SUMMARIZE)
        // 而非 bootstrap (EXPLORE→PRODUCE→SUMMARIZE)，避免 PRODUCE nudge 浪费轮次
        // B3 fix: 透传完整 ANALYST_BUDGET (searchBudget/maxSubmits/softSubmitLimit/idleRoundsToExit)
        tracker: ExplorationTracker.resolve(
          { source: 'system', strategy: 'analyst' },
          { ...ANALYST_BUDGET }
        ),
        trace: memoryCoordinator.getActiveContext(analystScopeId),
        memoryCoordinator,
        sharedState: {
          submittedTitles: globalSubmittedTitles,
          submittedPatterns: globalSubmittedPatterns,
          _dimensionMeta: {
            id: dimId,
            outputType: dimConfig.outputType || 'candidate',
            allowedKnowledgeTypes: dimConfig.allowedKnowledgeTypes || [],
          },
          _projectLanguage: primaryLang || projectInfo.lang || null,
          _dimensionScopeId: analystScopeId,
        },
        source: 'system',
      };

      // ── 执行 ──
      // 外层超时 = 安全网 (各阶段已有独立超时: Analyst 300s + Producer 180s + 硬缓冲 60s)
      const outerTimeoutMs = 600_000;
      const runResult = await Promise.race([
        runtime.execute(message, { strategyContext }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Bootstrap runtime timeout for "${dimId}"`)),
            outerTimeoutMs
          )
        ),
      ]);

      // ── 提取结果 ──
      const analyzeResult = runResult?.phases?.analyze;
      const gateResult = runResult?.phases?.quality_gate;
      const produceResult = runResult?.phases?.produce;
      const analysisText = (analyzeResult?.reply || runResult?.reply || '').trim();
      const artifact = gateResult?.artifact || {
        analysisText,
        referencedFiles: [],
        findings: [],
        metadata: { toolCallCount: 0 },
      };

      const runtimeToolCalls = runResult?.toolCalls || [];
      const combinedTokenUsage = runResult?.tokenUsage || { input: 0, output: 0 };

      // 引用文件: 优先从 artifact 取, 回退从 toolCalls 提取
      const referencedFiles =
        artifact.referencedFiles?.length > 0
          ? artifact.referencedFiles
          : [
              ...new Set(
                runtimeToolCalls.flatMap((tc: ToolCallRecord) => {
                  const a = tc?.args || tc?.params || {};
                  const files: string[] = [];
                  if (typeof a.filePath === 'string' && a.filePath.trim()) {
                    files.push(a.filePath.trim());
                  }
                  if (Array.isArray(a.filePaths)) {
                    for (const f of a.filePaths) {
                      if (typeof f === 'string' && f.trim()) {
                        files.push(f.trim());
                      }
                    }
                  }
                  return files;
                })
              ),
            ];

      const analysisReport = {
        dimensionId: dimId,
        analysisText: artifact.analysisText || analysisText,
        findings: artifact.findings || [],
        referencedFiles,
        evidenceMap: artifact.evidenceMap || null,
        negativeSignals: artifact.negativeSignals || [],
        metadata: {
          toolCallCount: runtimeToolCalls.length,
          tokenUsage: combinedTokenUsage,
          artifactVersion: artifact.metadata?.artifactVersion || 1,
        },
      };

      // ── Producer 结果统计 ──
      const submitCalls = runtimeToolCalls.filter((tc: ToolCallRecord) => {
        const tool = tc?.tool || tc?.name;
        return tool === 'submit_knowledge' || tool === 'submit_with_check';
      });
      const successCount = submitCalls.filter((tc: ToolCallRecord) => {
        const res = tc?.result;
        if (!res) {
          return true;
        }
        if (typeof res === 'string') {
          return !res.includes('rejected') && !res.includes('error');
        }
        return (
          (res as Record<string, unknown>).status !== 'rejected' &&
          (res as Record<string, unknown>).status !== 'error'
        );
      }).length;
      const rejectedCount = submitCalls.length - successCount;

      const producerResult = {
        candidateCount: needsCandidates ? successCount : 0,
        rejectedCount: needsCandidates ? rejectedCount : 0,
        toolCalls: runtimeToolCalls,
        reply: produceResult?.reply || analysisText,
        tokenUsage: combinedTokenUsage,
      };

      candidateResults.created += producerResult.candidateCount;
      dimensionCandidates[dimId] = { analysisReport, producerResult };

      // ── Memory Update ──
      const ac = memoryCoordinator.getActiveContext(analystScopeId);
      const distilled = ac
        ? ac.distill()
        : { keyFindings: [], totalObservations: 0, toolCallSummary: [] };
      sessionStore.storeDimensionReport(dimId, {
        analysisText: analysisReport.analysisText,
        findings:
          analysisReport.findings.length > 0 ? analysisReport.findings : distilled.keyFindings,
        referencedFiles: analysisReport.referencedFiles || [],
        candidatesSummary: [],
        workingMemoryDistilled: distilled,
      });

      logger.info(
        `[Insight-v3] Dimension "${dimId}": analysis=${analysisReport.analysisText.length} chars, ` +
          `files=${analysisReport.referencedFiles.length}, findings=${(analysisReport.findings || distilled.keyFindings).length}, ` +
          `toolCalls=${runtimeToolCalls.length}, degraded=${runResult?.degraded || false} (${Date.now() - dimStartTime}ms)`
      );

      // ── Token 用量持久化 (fire-and-forget) ──
      try {
        const tokenStore = ctx.container?.get?.('tokenUsageStore');
        if (tokenStore) {
          const aiProv = runtime.aiProvider;
          tokenStore.record({
            source: 'system',
            dimension: dimId,
            provider: aiProv?.name || null,
            model: aiProv?.model || null,
            inputTokens: combinedTokenUsage.input || 0,
            outputTokens: combinedTokenUsage.output || 0,
            durationMs: Date.now() - dimStartTime,
            toolCalls: runtimeToolCalls.length,
            sessionId: sessionId || null,
          });
          try {
            const realtime = ctx.container?.get?.('realtimeService');
            realtime?.broadcastTokenUsageUpdated?.();
          } catch {
            /* optional */
          }
        }
      } catch {
        /* token logging should never break execution */
      }

      // ── v5.1: analysisText 过短补强 ──
      if (needsCandidates && analysisReport.analysisText.length < 100) {
        const findings = analysisReport.findings || [];
        if (findings.length >= 3) {
          const dimLabel = dimConfig.label || dimId;
          const synthesized = [
            `## ${dimLabel}`,
            '',
            analysisReport.analysisText.trim(),
            '',
            '### 关键发现',
            '',
            ...findings.slice(0, 10).map((f: DimensionFinding | string, i: number) => {
              const text = typeof f === 'string' ? f : f.finding;
              return `${i + 1}. ${text}`;
            }),
          ];
          const memDistilled = distilled;
          if (memDistilled?.toolCallSummary?.length > 0) {
            synthesized.push('', '### 探索记录', '');
            for (const s of memDistilled.toolCallSummary.slice(0, 10)) {
              synthesized.push(`- ${s}`);
            }
          }
          const originalLen = analysisReport.analysisText.length;
          analysisReport.analysisText = synthesized.join('\n');
          logger.info(
            `[Insight-v3] analysisText 补强 "${dimId}": ${originalLen} → ${analysisReport.analysisText.length} chars ` +
              `(from ${findings.length} findings)`
          );
        }
      }

      // ── DimensionDigest ──
      const digest = parseDimensionDigest(producerResult.reply) || {
        summary: `v3 分析: ${analysisReport.analysisText.substring(0, 200)}...`,
        candidateCount: producerResult.candidateCount,
        keyFindings: [] as string[],
        crossRefs: {},
        gaps: [] as string[],
      };
      dimContext.addDimensionDigest(
        dimId,
        digest as Parameters<typeof dimContext.addDimensionDigest>[1]
      );
      sessionStore.addDimensionDigest(
        dimId,
        digest as Parameters<typeof sessionStore.addDimensionDigest>[1]
      );

      // 候选摘要记录到 DimensionContext + SessionStore
      for (const tc of producerResult.toolCalls || []) {
        const tool = tc.tool || tc.name;
        if (tool === 'submit_knowledge' || tool === 'submit_with_check') {
          const args = tc.params || tc.args || {};
          const candidateSummary = {
            title: String(args.title || ''),
            subTopic: String(args.category || ''),
            summary: String(args.summary || ''),
          };
          dimContext.addSubmittedCandidate(
            dimId,
            candidateSummary as Parameters<typeof dimContext.addSubmittedCandidate>[1]
          );
          sessionStore.addSubmittedCandidate(
            dimId,
            candidateSummary as Parameters<typeof sessionStore.addSubmittedCandidate>[1]
          );
        }
      }

      emitter.emitDimensionComplete(dimId, {
        type: needsCandidates ? 'candidate' : 'skill',
        extracted: producerResult.candidateCount,
        created: producerResult.candidateCount,
        skillPending: dimConfig.skillWorthy && producerResult.candidateCount === 0,
        status: 'v3-pipeline-complete',
        degraded: runResult?.degraded || false,
        durationMs: Date.now() - dimStartTime,
        toolCallCount: runtimeToolCalls.length,
        source: 'enhanced-pipeline-strategy',
      });

      const dimTokenUsage = combinedTokenUsage;
      const dimResult = {
        candidateCount: producerResult.candidateCount,
        rejectedCount: producerResult.rejectedCount || 0,
        analysisChars: analysisReport.analysisText.length,
        referencedFiles: analysisReport.referencedFiles.length,
        durationMs: Date.now() - dimStartTime,
        toolCallCount: runtimeToolCalls.length,
        tokenUsage: dimTokenUsage,
        analysisText: analysisReport.analysisText,
        referencedFilesList: analysisReport.referencedFiles || [],
      };

      dimensionStats[dimId] = dimResult;

      // P3: 保存 checkpoint — 仅当有实质分析内容时（避免 degraded/空结果污染后续 run）
      if (analysisReport.analysisText.length >= 50) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- digest shape compatible at runtime
        await saveDimensionCheckpoint(
          projectRoot,
          sessionId,
          dimId,
          dimResult,
          digest as unknown as Parameters<typeof saveDimensionCheckpoint>[4]
        );
      } else {
        logger.warn(
          `[Insight-v3] ⚠ 跳过 checkpoint 保存: "${dimId}" analysisText 过短 (${analysisReport.analysisText.length} chars)`
        );
      }

      return dimResult;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[Insight-v3] Dimension "${dimId}" failed: ${errMsg}`);
      candidateResults.errors.push({ dimId, error: errMsg });
      emitter.emitDimensionComplete(dimId, { type: 'error', reason: errMsg });
      return { candidateCount: 0, error: errMsg };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Step 3: 执行 (并行 or 串行)
  // ═══════════════════════════════════════════════════════════
  const t0 = Date.now();

  // tierHints: Enhancement Pack 维度通过 tierHint 字段声明首选 Tier
  const tierHints: Record<string, number> = {};
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
      shouldAbort: () => !!(taskManager && !taskManager.isSessionValid(sessionId)),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- DimensionStat structurally compatible with scheduler's DimensionResult
      onTierComplete: (tierIndex, tierResults) => {
        const tierStats = [...tierResults.values()];
        const totalCandidates = tierStats.reduce((s, r) => s + (r.candidateCount || 0), 0);
        logger.info(
          `[Insight-v3] Tier ${tierIndex + 1} complete: ${tierResults.size} dimensions, ${totalCandidates} candidates`
        );

        // v4.0: Tier 级 Reflection — 综合本 Tier 所有维度的发现
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- SessionStore structurally compatible
          const reflection = buildTierReflection(
            tierIndex,
            tierResults as Parameters<typeof buildTierReflection>[1],
            sessionStore as Parameters<typeof buildTierReflection>[2]
          );
          sessionStore.addTierReflection(
            tierIndex,
            reflection as Parameters<typeof sessionStore.addTierReflection>[1]
          );
          logger.info(
            `[Insight-v3] Tier ${tierIndex + 1} reflection: ` +
              `${reflection.topFindings.length} top findings, ` +
              `${reflection.crossDimensionPatterns.length} patterns`
          );
        } catch (refErr: unknown) {
          logger.warn(
            `[Insight-v3] Tier ${tierIndex + 1} reflection failed: ${refErr instanceof Error ? refErr.message : String(refErr)}`
          );
        }
      },
    });

    logger.info(
      `[Insight-v3] All tiers complete: ${results.size} dimensions in ${Date.now() - t0}ms`
    );
    // v4.0: 记录 SessionStore 统计
    const emStats = sessionStore.getStats() as Record<string, any>;
    logger.info(
      `[Insight-v3] Memory stats: ${emStats.completedDimensions} dims, ` +
        `${emStats.totalFindings} findings, ${emStats.referencedFiles} files, ` +
        `${emStats.crossReferences} cross-refs, ${emStats.tierReflections} reflections`
    );
    if (emStats.cacheStats) {
      logger.info(
        `[Insight-v3] Cache stats: ${emStats.cacheStats.hitRate} hit rate, ` +
          `${emStats.cacheStats.searchCacheSize} searches, ${emStats.cacheStats.fileCacheSize} files`
      );
    }
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
    logger.info(`[Insight-v3] Serial execution complete in ${Date.now() - t0}ms`);
  }

  // ═══════════════════════════════════════════════════════════
  // Step 4: Project Skill 生成 (skillWorthy 维度)
  //
  // v3: 直接使用 Analyst 的分析文本作为 Skill 内容
  // 使用 shared/skill-generator.js 统一质量门控和内容构建
  // ═══════════════════════════════════════════════════════════
  const skillResults: SkillResults = { created: 0, failed: 0, skills: [], errors: [] };

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

        // 从 SessionStore 获取结构化发现，供 Skill 生成使用
        const dimReport = sessionStore.getDimensionReport(dim.id);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SessionStore Finding type varies
        const keyFindings = ((dimReport?.findings || []) as Array<Record<string, any>>)
          .sort((a, b) => (b.importance || 5) - (a.importance || 5))
          .slice(0, 10)
          .map((f) => String(f.finding || ''));

        // 当 analysisText 过短（如 force-exit 时 AI 仅输出 JSON digest 被清洗后）
        // 从 distilled findings 合成补充文本，避免 Skill 质量门控拦截
        let effectiveText = analysisText;
        if (analysisText.trim().length < 100 && keyFindings.length > 0) {
          const distilled = dimReport?.workingMemoryDistilled;
          const synthesized = [
            `## ${dim.label || dim.id}`,
            '',
            analysisText.trim(),
            '',
            '## 关键发现',
            '',
            ...keyFindings.map((f: string, i: number) => `${i + 1}. ${f}`),
          ];
          if ((distilled?.toolCallSummary?.length ?? 0) > 0) {
            synthesized.push('', '## 探索记录', '');
            for (const s of distilled!.toolCallSummary!.slice(0, 10)) {
              synthesized.push(`- ${s}`);
            }
          }
          effectiveText = synthesized.join('\n');
          logger.info(
            `[Insight-v3] Skill "${dim.id}": analysisText too short (${analysisText.trim().length} chars), ` +
              `synthesized from ${keyFindings.length} findings → ${effectiveText.length} chars`
          );
        }

        const result = await generateSkill(
          ctx,
          dim,
          effectiveText,
          referencedFiles,
          keyFindings,
          'bootstrap-v3'
        );

        if (result.success) {
          skillResults.created++;
          skillResults.skills.push(result.skillName);

          emitter.emitDimensionComplete(dim.id, {
            type: 'skill',
            skillName: result.skillName,
            sourceCount: referencedFiles.length,
          });
        } else {
          skillResults.failed++;
          skillResults.errors.push({ dimId: dim.id, error: result.error ?? 'unknown' });
          emitter.emitDimensionFailed(dim.id, new Error(result.error));
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn(`[Insight-v3] Skill generation failed for "${dim.id}": ${errMsg}`);
        skillResults.failed++;
        skillResults.errors.push({ dimId: dim.id, error: errMsg });
        emitter.emitDimensionFailed(dim.id, err instanceof Error ? err : new Error(errMsg));
      }
    }
  } catch (e: unknown) {
    logger.warn(
      `[Insight-v3] Skill generation module import failed: ${e instanceof Error ? e.message : String(e)}`
    );
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
      const allCandidates: Array<{ title: unknown; relations: unknown }> = [];
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
        const relResult = ceg.populateFromCandidateRelations(
          allCandidates as unknown as Parameters<typeof ceg.populateFromCandidateRelations>[0]
        );
        logger.info(
          `[Insight-v3] Code Entity Graph relations: ${relResult.edgesCreated} edges from ${allCandidates.length} candidates (${relResult.durationMs}ms)`
        );
      }
    }
  } catch (cegErr: unknown) {
    logger.warn(
      `[Insight-v3] Code Entity Graph relations failed (non-blocking): ${cegErr instanceof Error ? cegErr.message : String(cegErr)}`
    );
  }

  // ═══════════════════════════════════════════════════════════
  // Step 5: Episodic → Semantic 固化 (Phase C)
  //
  // 将 EpisodicMemory 中的发现和洞察提炼为持久化的语义记忆，
  // 存入 SQLite semantic_memories 表，供二次冷启动和日常对话使用。
  // ═══════════════════════════════════════════════════════════
  let consolidationResult: ConsolidationResult | null = null;
  try {
    const db = ctx.container.get('database');
    if (db) {
      const semanticMemory = new PersistentMemory(db, { logger });
      const consolidator = new EpisodicConsolidator(semanticMemory, { logger });

      consolidationResult = consolidator.consolidate(sessionStore, {
        bootstrapSession: sessionId,
        clearPrevious: true, // 全量冷启动: 先清除旧的 bootstrap 记忆
      } as Record<string, unknown>);

      const smStats = semanticMemory.getStats();
      logger.info(
        `[Insight-v3] Semantic Memory consolidation: ` +
          `+${consolidationResult.total.added} ADD, ` +
          `~${consolidationResult.total.updated} UPDATE, ` +
          `⊕${consolidationResult.total.merged} MERGE | ` +
          `Total: ${smStats.total} memories (avg importance: ${smStats.avgImportance})`
      );
    } else {
      logger.warn('[Insight-v3] Database not available — skipping Semantic Memory consolidation');
    }
  } catch (consolidateErr: unknown) {
    logger.warn(
      `[Insight-v3] Semantic Memory consolidation failed (non-blocking): ${consolidateErr instanceof Error ? consolidateErr.message : String(consolidateErr)}`
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
      `[Insight-v3] ═══ Pipeline complete ═══`,
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
    const report: BootstrapReport = {
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
    logger.info(`[Insight-v3] 📊 Bootstrap report saved to .autosnippet/bootstrap-report.json`);
  } catch (reportErr: unknown) {
    logger.warn(
      `[Insight-v3] Bootstrap report generation failed: ${reportErr instanceof Error ? reportErr.message : String(reportErr)}`
    );
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
        episodicMemory: sessionStore as unknown as Parameters<
          typeof ib.saveSnapshot
        >[0]['episodicMemory'],
        meta: {
          durationMs: totalTimeMs,
          candidateCount: candidateResults.created,
          primaryLang: primaryLang || projectInfo.lang,
        },
        plan: isIncremental ? incrementalPlan : null,
      });
      logger.info(`[Insight-v3] 📸 Snapshot saved: ${snapshotId}`);
    }
  } catch (snapErr: unknown) {
    logger.warn(
      `[Insight-v3] Snapshot save failed (non-blocking): ${snapErr instanceof Error ? snapErr.message : String(snapErr)}`
    );
  }

  // 释放文件缓存
  allFiles = null;
  ctx.container.singletons._fileCache = null;

  // ── Cursor Delivery: 生成 4 通道交付物料 ──
  try {
    const { getServiceContainer } = await import('../../../../../injection/ServiceContainer.js');
    const container = getServiceContainer();
    if (container.services.cursorDeliveryPipeline) {
      const pipeline = container.get('cursorDeliveryPipeline');
      const deliveryResult = await pipeline.deliver();
      logger.info(
        `[Insight-v3] 🚀 Cursor Delivery complete — ` +
          `A: ${deliveryResult.channelA.rulesCount} rules, ` +
          `B: ${deliveryResult.channelB.topicCount} topics, ` +
          `C: ${deliveryResult.channelC.synced} skills, ` +
          `D: ${deliveryResult.channelD?.documentsCount || 0} documents, ` +
          `F: ${deliveryResult.channelF?.filesWritten || 0} agent files`
      );
    }
  } catch (deliveryErr: unknown) {
    logger.warn(
      `[Insight-v3] Cursor Delivery failed (non-blocking): ${deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr)}`
    );
  }

  // ── Repo Wiki: 自动生成项目文档 Wiki ──
  try {
    const { getServiceContainer: getWikiContainer } = await import(
      '../../../../../injection/ServiceContainer.js'
    );
    const wikiContainer = getWikiContainer();
    const { WikiGenerator } = await import('../../../../../service/wiki/WikiGenerator.js');

    // 同步 wiki 路由的任务状态，让前端轮询 /wiki/status 能看到进度
    let patchWikiTask: ((data: Record<string, unknown>) => void) | null = null;
    let realtimeService: {
      broadcastEvent?(event: string, data: Record<string, unknown>): void;
    } | null = null;
    try {
      const wikiRoute = await import('../../../../../http/routes/wiki.js');
      patchWikiTask = wikiRoute.patchWikiTask;
    } catch {
      /* ok */
    }
    try {
      realtimeService = (wikiContainer.singletons?.realtimeService || null) as {
        broadcastEvent?(event: string, data: Record<string, unknown>): void;
      } | null;
    } catch {
      /* ok */
    }

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

    let moduleService: unknown = null,
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
      onProgress: (phase: string, progress: number, message: string) => {
        // 同步到 wiki 路由的任务状态
        patchWikiTask?.({ phase, progress, message });
        // 通过 Socket.io 推送进度
        if (realtimeService) {
          try {
            realtimeService.broadcastEvent?.('wiki:progress', {
              phase,
              progress,
              message,
              timestamp: Date.now(),
            });
          } catch {
            /* non-critical */
          }
        }
      },
      options: { language: process.env.ASD_WIKI_LANG || 'zh' },
    } as ConstructorParameters<typeof WikiGenerator>[0]);
    const wikiResult = (await wiki.generate()) as Record<string, unknown>;
    if (wikiResult.success) {
      logger.info(
        `[Insight-v3] 📖 Wiki generated — ${wikiResult.filesGenerated} files, ` +
          `AI: ${wikiResult.aiComposed || 0}, Synced: ${wikiResult.syncedDocs || 0}, ` +
          `Dedup removed: ${(wikiResult.dedup as Record<string, unknown>)?.removed ? ((wikiResult.dedup as Record<string, unknown>).removed as unknown[]).length : 0}`
      );
    }

    // 标记任务完成
    patchWikiTask?.({
      status: wikiResult.success ? 'done' : 'error',
      finishedAt: Date.now(),
      result: wikiResult,
      error: wikiResult.success ? null : (wikiResult.error as string) || 'Unknown error',
      progress: 100,
    });
    if (realtimeService) {
      try {
        realtimeService.broadcastEvent?.('wiki:completed', {
          success: wikiResult.success,
          filesGenerated: wikiResult.filesGenerated,
          duration: wikiResult.duration,
        });
      } catch {
        /* non-critical */
      }
    }
  } catch (wikiErr: unknown) {
    const wikiErrMsg = wikiErr instanceof Error ? wikiErr.message : String(wikiErr);
    logger.warn(`[Insight-v3] Wiki generation failed (non-blocking): ${wikiErrMsg}`);
    try {
      const wikiRoute = await import('../../../../../http/routes/wiki.js');
      wikiRoute.patchWikiTask?.({
        status: 'error',
        finishedAt: Date.now(),
        error: wikiErrMsg,
      });
    } catch {
      /* ok */
    }
  }
}

/**
 * 清除增量 Bootstrap 快照 — 供 bootstrapKnowledge 在手动冷启动时调用
 * @param {string} projectRoot
 * @param {object} ctx - { container, logger }
 */
async function clearSnapshotsImpl(
  projectRoot: string,
  ctx: {
    container: OrchestratorContainer;
    logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  }
) {
  try {
    const db = ctx.container.get('database');
    if (db) {
      const { BootstrapSnapshot } = await import('./BootstrapSnapshot.js');
      const snap = new BootstrapSnapshot(db, { logger: ctx.logger });
      snap.clearProject(projectRoot);
      ctx.logger.info('[Bootstrap] Cleared incremental snapshots — forcing full rebuild');
    }
  } catch (err: unknown) {
    ctx.logger.warn(
      `[Bootstrap] clearSnapshots failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export { clearCheckpoints };
export { clearSnapshotsImpl as clearSnapshots };
export default fillDimensionsV3;
