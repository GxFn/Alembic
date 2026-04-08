/**
 * RecipeProductionGateway — 统一 Recipe 生产入口
 *
 * 所有 Recipe 创建（Agent Tool / MCP / IDE Agent / Batch Import）
 * 通过此 Gateway 的统一管道，保证前置校验一致：
 *
 *   1. Schema Validation (UnifiedValidator)
 *   2. Similarity Check — 去重检测（可选跳过）
 *   3. Consolidation Scan — 融合/重组建议（可选）
 *   4. KnowledgeService.create() — 包含 ConfidenceRouter → staging / pending
 *   5. Quality Scoring — 质量评分
 *   6. Supersede Proposal — 创建替代提案
 *   7. Audit — 统一审计
 *
 * @see docs/copilot/recipe-lifecycle-management.md §6
 */

import { UnifiedValidator } from '#domain/knowledge/UnifiedValidator.js';

/** Lightweight log interface — avoids importing static-only Logger class. */
interface GatewayLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/* ═══════════════════ Types ═══════════════════ */

export type GatewaySource = 'agent-tool' | 'mcp-external' | 'ide-agent' | 'batch-import';

export interface CreateRecipeItem {
  title?: string;
  description?: string;
  content?: { markdown?: string; pattern?: string; rationale?: string; [key: string]: unknown };
  trigger?: string;
  kind?: string;
  topicHint?: string;
  whenClause?: string;
  doClause?: string;
  dontClause?: string;
  coreCode?: string;
  sourceRefs?: string[];
  tags?: string[];
  reasoning?: { whyStandard?: string; sources?: string[]; confidence?: number };
  headers?: string[];
  usageGuide?: string;
  scope?: string;
  complexity?: string;
  sourceFile?: string;
  knowledgeType?: string;
  language?: string;
  category?: string;
  source?: string;
  [key: string]: unknown;
}

export interface CreateRecipeRequest {
  source: GatewaySource;
  items: CreateRecipeItem[];
  options?: {
    /** 跳过相似度检测（仅 batch-import 可用） */
    skipSimilarityCheck?: boolean;
    /** 跳过 ConsolidationAdvisor 分析 */
    skipConsolidation?: boolean;
    /** 被替代的旧 Recipe ID */
    supersedes?: string;
    /** 相似度阈值，默认 0.7 */
    similarityThreshold?: number;
    /** 已提交标题集（批量去重用） */
    existingTitles?: Set<string>;
    /** 已提交指纹集（批量去重用） */
    existingFingerprints?: Set<string>;
    /** UnifiedValidator 跳过系统注入字段列表 */
    systemInjectedFields?: string[];
    /** 跳过唯一性校验 */
    skipUniqueness?: boolean;
    /** 操作用户 ID */
    userId?: string;
  };
}

export interface CreatedRecipeInfo {
  id: string;
  title: string;
  lifecycle: string;
  /** Raw saved entry from KnowledgeService.create() */
  raw: Record<string, unknown>;
}

export interface RejectedRecipeInfo {
  index: number;
  title: string;
  reason: string;
  errors: string[];
  warnings: string[];
}

export interface MergedRecipeInfo {
  index: number;
  proposalId: string;
  type: string;
  targetRecipeId: string;
  targetTitle: string;
  status: string;
  expiresAt: number;
  message: string;
}

export interface BlockedRecipeInfo {
  index: number;
  title: string;
  consolidation: unknown;
}

export interface SimilarRecipeInfo {
  index: number;
  title: string;
  similarTo: { file: string; title: string; similarity: number }[];
}

export interface CreateRecipeResult {
  created: CreatedRecipeInfo[];
  rejected: RejectedRecipeInfo[];
  merged: MergedRecipeInfo[];
  blocked: BlockedRecipeInfo[];
  duplicates: SimilarRecipeInfo[];
  supersedeProposal: { proposalId: string } | null;
}

/* ═══════════════════ Dependencies ═══════════════════ */

interface GatewayKnowledgeService {
  create(
    data: Record<string, unknown>,
    context: { userId: string }
  ): Promise<{
    id: string;
    title: string;
    lifecycle: string;
    kind?: string;
    [key: string]: unknown;
  }>;
  updateQuality(id: string, context: { userId: string }): Promise<unknown>;
}

interface GatewayConsolidationAdvisor {
  analyzeBatch(candidates: Array<{ title: string; category?: string; [key: string]: unknown }>): {
    items: Array<{
      index: number;
      advice: {
        action: string;
        confidence: number;
        reason: string;
        targetRecipe?: { id: string; title: string; similarity: number };
        reorganizeTargets?: { id: string; title: string; similarity: number }[];
        coveredBy?: { id: string; title: string; similarity: number }[];
        mergeDirection?: { addedDimensions: string[]; summary: string };
      };
    }>;
  };
}

interface GatewayProposalRepository {
  create(data: Record<string, unknown>): {
    id: string;
    status: string;
    expiresAt: number;
    [key: string]: unknown;
  } | null;
}

type GatewaySimilarityFn = (
  projectRoot: string,
  candidate: { title: string; summary: string; code: string },
  opts: { threshold: number; topK: number }
) => { file: string; title: string; similarity: number }[];

export interface GatewayDeps {
  knowledgeService: GatewayKnowledgeService;
  projectRoot: string;
  logger?: GatewayLogger;
  /** ConsolidationAdvisor（可选 — MCP 路径使用） */
  consolidationAdvisor?: GatewayConsolidationAdvisor | null;
  /** ProposalRepository（可选 — supersede 提案需要） */
  proposalRepository?: GatewayProposalRepository | null;
  /** 相似度检测函数（可选 — 默认导入 SimilarityService） */
  findSimilarRecipes?: GatewaySimilarityFn | null;
}

/* ═══════════════════ Gateway ═══════════════════ */

export class RecipeProductionGateway {
  readonly #knowledgeService: GatewayKnowledgeService;
  readonly #projectRoot: string;
  readonly #logger?: GatewayLogger;
  readonly #consolidationAdvisor: GatewayConsolidationAdvisor | null;
  readonly #proposalRepo: GatewayProposalRepository | null;
  readonly #findSimilarRecipes: GatewaySimilarityFn | null;

  constructor(deps: GatewayDeps) {
    this.#knowledgeService = deps.knowledgeService;
    this.#projectRoot = deps.projectRoot;
    this.#logger = deps.logger;
    this.#consolidationAdvisor = deps.consolidationAdvisor ?? null;
    this.#proposalRepo = deps.proposalRepository ?? null;
    this.#findSimilarRecipes = deps.findSimilarRecipes ?? null;
  }

  /**
   * 统一创建入口
   *
   * Pipeline:
   *   1. Schema Validation (UnifiedValidator)
   *   2. Similarity Check (除非 skipSimilarityCheck)
   *   3. Consolidation Scan (除非 skipConsolidation)
   *   4. KnowledgeService.create() — ConfidenceRouter → staging / pending
   *   5. Quality Scoring
   *   6. Supersede Proposal 创建 (if supersedes)
   */
  async create(request: CreateRecipeRequest): Promise<CreateRecipeResult> {
    const { source, items, options = {} } = request;
    const userId = options.userId || this.#sourceToUserId(source);

    const result: CreateRecipeResult = {
      created: [],
      rejected: [],
      merged: [],
      blocked: [],
      duplicates: [],
      supersedeProposal: null,
    };

    if (items.length === 0) {
      return result;
    }

    // ── Step 1: Schema Validation ──
    const validator = new UnifiedValidator({
      existingTitles: options.existingTitles,
      existingFingerprints: options.existingFingerprints,
    });

    const validItems: { index: number; item: CreateRecipeItem }[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const validation = validator.validate(item as Record<string, unknown>, {
        systemInjectedFields: options.systemInjectedFields,
        skipUniqueness: options.skipUniqueness,
      });

      if (!validation.pass) {
        result.rejected.push({
          index: i,
          title: item.title || '(untitled)',
          reason: 'validation_failed',
          errors: validation.errors,
          warnings: validation.warnings,
        });
        this.#logger?.info(
          `[Gateway] ✗ validation rejected item ${i}: ${validation.errors.join('; ')}`
        );
      } else {
        validItems.push({ index: i, item });
        // 记录已提交标题/指纹以防批量内重复
        validator.recordSubmission(
          item.title,
          (item.content as Record<string, unknown> | undefined)?.pattern as string | undefined
        );
      }
    }

    // ── Step 2: Similarity Check ──
    let afterSimilarityItems = validItems;

    if (!options.skipSimilarityCheck && this.#findSimilarRecipes) {
      const threshold = options.similarityThreshold ?? 0.7;
      afterSimilarityItems = [];

      for (const entry of validItems) {
        const { item, index } = entry;
        const contentObj =
          item.content && typeof item.content === 'object' ? item.content : { markdown: '' };
        const cand = {
          title: item.title || '',
          summary: item.description || '',
          code: (contentObj.markdown as string) || (contentObj.pattern as string) || '',
        };

        const similar = this.#findSimilarRecipes(this.#projectRoot, cand, {
          threshold: 0.5,
          topK: 5,
        });
        const hasDuplicate = similar.some((s) => s.similarity >= threshold);

        if (hasDuplicate) {
          result.duplicates.push({
            index,
            title: item.title || '(untitled)',
            similarTo: similar,
          });
          this.#logger?.info(
            `[Gateway] ✗ duplicate blocked item ${index}: similarity ${similar[0]?.similarity}`
          );
        } else {
          afterSimilarityItems.push(entry);
        }
      }
    }

    // ── Step 3: Consolidation Scan ──
    let submittableItems = afterSimilarityItems;

    if (
      !options.skipConsolidation &&
      this.#consolidationAdvisor &&
      afterSimilarityItems.length > 0
    ) {
      submittableItems = [];
      try {
        const candidates = afterSimilarityItems.map((e) => ({
          title: e.item.title || '',
          category:
            e.item.category || ((e.item as Record<string, unknown>)._category as string) || '',
          ...e.item,
        }));

        const batchAdvice = this.#consolidationAdvisor.analyzeBatch(candidates);

        for (let ai = 0; ai < batchAdvice.items.length; ai++) {
          const { advice } = batchAdvice.items[ai];
          const validEntry = afterSimilarityItems[ai];
          if (!validEntry) {
            continue;
          }

          if (advice.action === 'create') {
            submittableItems.push(validEntry);
          } else if (this.#proposalRepo) {
            const proposal = this.#createProposalFromAdvice(advice, validEntry.item);
            if (proposal) {
              result.merged.push({
                index: validEntry.index,
                proposalId: proposal.proposalId,
                type: proposal.type,
                targetRecipeId: proposal.targetRecipeId,
                targetTitle: proposal.targetTitle,
                status: proposal.status,
                expiresAt: proposal.expiresAt,
                message: proposal.message,
              });
            } else {
              // Proposal 创建失败 → blocked
              result.blocked.push({
                index: validEntry.index,
                title: validEntry.item.title || '(untitled)',
                consolidation: advice,
              });
            }
          } else {
            // 无 ProposalRepository → blocked
            result.blocked.push({
              index: validEntry.index,
              title: validEntry.item.title || '(untitled)',
              consolidation: advice,
            });
          }
        }
      } catch (err: unknown) {
        this.#logger?.warn(
          `[Gateway] ConsolidationAdvisor error, falling back to direct submit: ${err instanceof Error ? err.message : String(err)}`
        );
        submittableItems = afterSimilarityItems;
      }
    }

    // ── Step 4: Create via KnowledgeService ──
    const createdIds: string[] = [];

    for (const { item } of submittableItems) {
      try {
        const data = this.#prepareCreateData(item, source, userId);
        const saved = await this.#knowledgeService.create(data, { userId });

        result.created.push({
          id: saved.id,
          title: saved.title,
          lifecycle: saved.lifecycle,
          raw: saved as Record<string, unknown>,
        });
        createdIds.push(saved.id);

        // ── Step 5: Quality Scoring (best effort) ──
        try {
          await this.#knowledgeService.updateQuality(saved.id, { userId });
        } catch {
          /* best effort — 不阻塞创建流程 */
        }
      } catch (err: unknown) {
        result.rejected.push({
          index: items.indexOf(item),
          title: item.title || '(untitled)',
          reason: 'create_failed',
          errors: [err instanceof Error ? err.message : String(err)],
          warnings: [],
        });
        this.#logger?.warn(
          `[Gateway] ✗ create failed for "${item.title}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // ── Step 6: Supersede Proposal ──
    if (options.supersedes && createdIds.length > 0) {
      try {
        // 直接使用 ProposalRepository（Gateway 不依赖 ServiceContainer）
        if (this.#proposalRepo) {
          const proposal = this.#proposalRepo.create({
            type: 'supersede',
            targetRecipeId: options.supersedes,
            relatedRecipeIds: createdIds,
            confidence: 0.9,
            source: source === 'mcp-external' ? 'ide-agent' : 'ide-agent',
            description: `Supersede proposal: ${createdIds.length} new recipe(s) replace ${options.supersedes}`,
            evidence: [{ snapshotAt: Date.now(), newRecipeIds: createdIds }],
          });
          if (proposal) {
            result.supersedeProposal = { proposalId: proposal.id };
          }
        }
      } catch (err: unknown) {
        this.#logger?.warn(
          `[Gateway] Supersede proposal creation failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    this.#logger?.info(
      `[Gateway] create complete: ${result.created.length} created, ${result.rejected.length} rejected, ${result.merged.length} merged, ${result.duplicates.length} duplicates | source=${source}`
    );

    return result;
  }

  /* ═══════════════════ Private ═══════════════════ */

  #sourceToUserId(source: GatewaySource): string {
    switch (source) {
      case 'agent-tool':
        return 'agent';
      case 'mcp-external':
        return 'mcp';
      case 'ide-agent':
        return 'ide-agent';
      case 'batch-import':
        return 'batch-import';
    }
  }

  #prepareCreateData(
    item: CreateRecipeItem,
    source: GatewaySource,
    _userId: string
  ): Record<string, unknown> {
    const contentObj =
      item.content && typeof item.content === 'object'
        ? item.content
        : { markdown: '', pattern: '' };

    const reasoning = item.reasoning || {
      whyStandard: '',
      sources: ['agent'],
      confidence: 0.7,
    };
    if (Array.isArray(reasoning.sources) && reasoning.sources.length === 0) {
      reasoning.sources = ['agent'];
    }

    return {
      language: item.language || '',
      category: item.category || (item as Record<string, unknown>)._category || 'general',
      knowledgeType: item.knowledgeType || 'code-pattern',
      source: item.source || this.#sourceLabel(source),
      title: item.title || '',
      description: item.description || '',
      tags: item.tags || [],
      trigger: item.trigger || '',
      kind: item.kind || 'pattern',
      topicHint: item.topicHint || '',
      whenClause: item.whenClause || '',
      doClause: item.doClause || '',
      dontClause: item.dontClause || '',
      coreCode: item.coreCode || (contentObj.pattern as string) || '',
      sourceRefs: item.sourceRefs || [],
      content: contentObj,
      reasoning,
      headers: item.headers || [],
      usageGuide: item.usageGuide || '',
      scope: item.scope || '',
      complexity: item.complexity || '',
      sourceFile: '',
      agentNotes: (item as Record<string, unknown>).agentNotes || null,
      aiInsight: reasoning.whyStandard || item.description || null,
    };
  }

  #sourceLabel(source: GatewaySource): string {
    switch (source) {
      case 'agent-tool':
        return 'agent';
      case 'mcp-external':
        return 'mcp';
      case 'ide-agent':
        return 'ide-agent';
      case 'batch-import':
        return 'batch-import';
    }
  }

  #createProposalFromAdvice(
    advice: {
      action: string;
      confidence: number;
      reason: string;
      targetRecipe?: { id: string; title: string; similarity: number };
      reorganizeTargets?: { id: string; title: string; similarity: number }[];
      coveredBy?: { id: string; title: string; similarity: number }[];
      mergeDirection?: { addedDimensions: string[]; summary: string };
    },
    item: CreateRecipeItem
  ): {
    proposalId: string;
    type: string;
    targetRecipeId: string;
    targetTitle: string;
    status: string;
    expiresAt: number;
    message: string;
  } | null {
    if (!this.#proposalRepo) {
      return null;
    }

    const evidence = [
      {
        snapshotAt: Date.now(),
        candidateTitle: item.title,
        candidateCategory: item.category,
        analysisReason: advice.reason,
        mergeDirection: advice.mergeDirection,
      },
    ];

    if (advice.action === 'merge' && advice.targetRecipe) {
      const proposal = this.#proposalRepo.create({
        type: 'merge',
        targetRecipeId: advice.targetRecipe.id,
        confidence: advice.confidence,
        source: 'ide-agent',
        description: advice.reason,
        evidence,
      });
      if (!proposal) {
        return null;
      }
      return {
        proposalId: proposal.id,
        type: 'merge',
        targetRecipeId: advice.targetRecipe.id,
        targetTitle: advice.targetRecipe.title,
        status: proposal.status,
        expiresAt: proposal.expiresAt,
        message: `已为「${advice.targetRecipe.title}」创建融合提案，${proposal.status === 'observing' ? '观察窗口 72h 后自动执行' : '等待开发者确认'}。`,
      };
    }

    if (advice.action === 'reorganize' && advice.reorganizeTargets?.length) {
      const target = advice.reorganizeTargets[0];
      const proposal = this.#proposalRepo.create({
        type: 'reorganize',
        targetRecipeId: target.id,
        relatedRecipeIds: advice.reorganizeTargets.slice(1).map((t) => t.id),
        confidence: advice.confidence,
        source: 'ide-agent',
        description: advice.reason,
        evidence,
      });
      if (!proposal) {
        return null;
      }
      return {
        proposalId: proposal.id,
        type: 'reorganize',
        targetRecipeId: target.id,
        targetTitle: target.title,
        status: proposal.status,
        expiresAt: proposal.expiresAt,
        message: `已为 ${advice.reorganizeTargets.length} 条 Recipe 创建重组提案，需开发者在 Dashboard 确认。`,
      };
    }

    if (advice.action === 'insufficient' && advice.coveredBy?.length) {
      const target = advice.coveredBy[0];
      const proposal = this.#proposalRepo.create({
        type: 'enhance',
        targetRecipeId: target.id,
        confidence: advice.confidence,
        source: 'ide-agent',
        description: advice.reason,
        evidence,
      });
      if (!proposal) {
        return null;
      }
      return {
        proposalId: proposal.id,
        type: 'enhance',
        targetRecipeId: target.id,
        targetTitle: target.title,
        status: proposal.status,
        expiresAt: proposal.expiresAt,
        message: `候选独立价值不足，已创建增强提案建议补充到「${target.title}」。`,
      };
    }

    return null;
  }
}
