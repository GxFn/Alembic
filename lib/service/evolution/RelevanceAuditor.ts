/**
 * RelevanceAuditor — 基于代码证据验证 Recipe 当前相关性
 *
 * Rescan 时主动触发，检查每个保留 Recipe 的代码证据是否仍然存在。
 * 分级判定由 EvolutionPolicy.classifyRelevance() 集中管理。
 *
 * @module service/evolution/RelevanceAuditor
 */

import { EvolutionPolicy } from '../../domain/evolution/EvolutionPolicy.js';
import type KnowledgeRepositoryImpl from '../../repository/knowledge/KnowledgeRepository.impl.js';
import type { EvolutionGateway } from './EvolutionGateway.js';

// ── 类型定义 ──────────────────────────────────────────────────

/** Logger 接口 */
interface AuditorLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/** 知识条目快照 (来自 CleanupService.snapshotRecipes) */
export interface RecipeSnapshotEntry {
  id: string;
  title: string;
  trigger: string;
  category: string;
  dimensionId?: string;
  sourceFile?: string;
  lifecycle: string;
}

/** 从 DB 读取的完整 Recipe 数据 */
interface FullRecipeRow {
  id: string;
  title: string;
  trigger: string;
  category: string;
  content: string;
  doClause: string | null;
  coreCode: string | null;
}

/** Phase 1-4 分析数据 */
export interface AnalysisData {
  /** 项目所有文件的相对路径 */
  fileList: string[];
  /** AST 解析的代码实体 (类名/函数名/协议名等) */
  codeEntities: Array<{ name: string; kind?: string; file?: string }>;
  /** 依赖关系图 */
  dependencyGraph: Array<{ from: string; to: string }>;
}

/** 单个 Recipe 的审计结果 */
export interface RelevanceAuditResult {
  recipeId: string;
  title: string;
  relevanceScore: number;
  verdict: 'healthy' | 'watch' | 'decay' | 'severe' | 'dead';
  evidence: {
    triggerStillMatches: boolean;
    symbolsAlive: number;
    depsIntact: boolean;
    codeFilesExist: number;
  };
  decayReasons: string[];
}

/** 审计汇总 */
export interface RelevanceAuditSummary {
  totalAudited: number;
  healthy: number;
  watch: number;
  decay: number;
  severe: number;
  dead: number;
  results: RelevanceAuditResult[];
  proposalsCreated: number;
  immediateDeprecated: number;
}

/** 证据维度权重 */
interface EvidenceWeights {
  triggerStillMatches: number;
  symbolsAlive: number;
  depsIntact: number;
  codeFilesExist: number;
}

// ── 常量 ────────────────────────────────────────────────────

/** 默认证据权重
 *
 * 注意：不包含 sourceFileExists。DB 中 sourceFile 存储的是 Recipe md 文件路径
 * （如 Alembic/candidates/xxx.md），不是源代码路径。
 * 真正的源代码来源在 reasoning.sources 中，由 codeFilesExist 维度检查。
 */
const DEFAULT_WEIGHTS: EvidenceWeights = {
  triggerStillMatches: 0.2,
  symbolsAlive: 0.3,
  depsIntact: 0.15,
  codeFilesExist: 0.35,
};

/**
 * 按 category 覆盖权重 — 架构/规范类侧重触发模式和来源文件
 */
const CATEGORY_WEIGHT_OVERRIDES: Record<string, Partial<EvidenceWeights>> = {
  architecture: {
    symbolsAlive: 0.05,
    depsIntact: 0.05,
    triggerStillMatches: 0.45,
    codeFilesExist: 0.45,
  },
  'coding-standards': {
    symbolsAlive: 0.05,
    depsIntact: 0.05,
    triggerStillMatches: 0.45,
    codeFilesExist: 0.45,
  },
  'agent-guidelines': {
    symbolsAlive: 0.0,
    depsIntact: 0.0,
    triggerStillMatches: 0.5,
    codeFilesExist: 0.5,
  },
};

// ── RelevanceAuditor ──────────────────────────────────

export class RelevanceAuditor {
  readonly #knowledgeRepo: KnowledgeRepositoryImpl;
  readonly #gateway: EvolutionGateway;
  readonly #logger: AuditorLogger;

  constructor(opts: {
    knowledgeRepo: KnowledgeRepositoryImpl;
    evolutionGateway: EvolutionGateway;
    logger?: AuditorLogger;
  }) {
    this.#knowledgeRepo = opts.knowledgeRepo;
    this.#gateway = opts.evolutionGateway;
    this.#logger = opts.logger || { info() {}, warn() {} };
  }

  /**
   * 审计所有保留 Recipe 的代码证据
   */
  async audit(
    recipes: RecipeSnapshotEntry[],
    analysisData: AnalysisData
  ): Promise<RelevanceAuditSummary> {
    const summary: RelevanceAuditSummary = {
      totalAudited: 0,
      healthy: 0,
      watch: 0,
      decay: 0,
      severe: 0,
      dead: 0,
      results: [],
      proposalsCreated: 0,
      immediateDeprecated: 0,
    };

    // 预处理：构建快速查找集合
    const fileSet = new Set(analysisData.fileList.map((f) => f.toLowerCase()));
    const entityNames = new Set(analysisData.codeEntities.map((e) => e.name.toLowerCase()));
    const depModules = new Set<string>();
    for (const edge of analysisData.dependencyGraph) {
      depModules.add(edge.from.toLowerCase());
      depModules.add(edge.to.toLowerCase());
    }

    for (const recipe of recipes) {
      const fullRecipe = await this.#loadFullRecipe(recipe.id);
      if (!fullRecipe) {
        continue;
      }

      const result = await this.#computeRelevanceScore(fullRecipe, {
        fileSet,
        entityNames,
        depModules,
        fileList: analysisData.fileList,
      });

      summary.totalAudited++;
      summary[result.verdict]++;
      summary.results.push(result);

      // 执行衰退状态转换
      if (result.verdict === 'dead' || result.verdict === 'severe' || result.verdict === 'decay') {
        const executed = await this.#executeDecay(result);
        if (result.verdict === 'dead') {
          summary.immediateDeprecated += executed ? 1 : 0;
        }
        if (executed) {
          summary.proposalsCreated++;
        }
      }
    }

    this.#logger.info('[RelevanceAuditor] Audit complete', {
      total: summary.totalAudited,
      healthy: summary.healthy,
      watch: summary.watch,
      decay: summary.decay,
      severe: summary.severe,
      dead: summary.dead,
    });

    return summary;
  }

  // ─── 内部方法 ─────────────────────────────────────────

  /** 从 DB 加载完整 Recipe 数据 */
  async #loadFullRecipe(id: string): Promise<FullRecipeRow | null> {
    try {
      const entry = await this.#knowledgeRepo.findById(id);
      if (!entry) {
        return null;
      }
      return {
        id: entry.id,
        title: entry.title,
        trigger: entry.trigger ?? '',
        category: entry.category ?? '',
        content: JSON.stringify(entry.content?.toJSON?.() ?? entry.content ?? {}),
        doClause: entry.doClause ?? null,
        coreCode: entry.coreCode ?? null,
      };
    } catch {
      return null;
    }
  }

  /** 计算单个 Recipe 的 relevanceScore */
  async #computeRelevanceScore(
    recipe: FullRecipeRow,
    ctx: {
      fileSet: Set<string>;
      entityNames: Set<string>;
      depModules: Set<string>;
      fileList: string[];
    }
  ): Promise<RelevanceAuditResult> {
    const category = recipe.category || '';
    const weights: EvidenceWeights = {
      ...DEFAULT_WEIGHTS,
      ...(CATEGORY_WEIGHT_OVERRIDES[category] || {}),
    };

    const decayReasons: string[] = [];

    // 1. trigger 模式匹配
    const triggerStillMatches = this.#checkTriggerMatch(recipe.trigger, ctx.fileList);
    if (!triggerStillMatches) {
      decayReasons.push(`触发条件 "${recipe.trigger}" 无匹配文件`);
    }

    // 2. 代码符号存活率
    const referencedSymbols = this.#extractReferencedSymbols(recipe);
    let symbolsAlive = 1.0;
    if (referencedSymbols.length > 0) {
      const aliveCount = referencedSymbols.filter((s) =>
        ctx.entityNames.has(s.toLowerCase())
      ).length;
      symbolsAlive = aliveCount / referencedSymbols.length;
      if (symbolsAlive < 0.5) {
        decayReasons.push(
          `引用符号存活 ${aliveCount}/${referencedSymbols.length} (${(symbolsAlive * 100).toFixed(0)}%)`
        );
      }
    }

    // 3. 依赖关系完整性
    const referencedModules = this.#extractModuleReferences(recipe);
    let depsIntact = true;
    if (referencedModules.length > 0) {
      const intactCount = referencedModules.filter((m) =>
        ctx.depModules.has(m.toLowerCase())
      ).length;
      depsIntact = intactCount >= referencedModules.length * 0.5;
      if (!depsIntact) {
        decayReasons.push(`模块依赖 ${intactCount}/${referencedModules.length} 存活`);
      }
    }

    // 4. 源代码文件存活率（来自 reasoning.sources + content.codeChanges）
    const codeFiles = await this.#extractCodeFiles(recipe);
    let codeFilesExist = 1.0;
    if (codeFiles.length > 0) {
      const existCount = codeFiles.filter((f) => ctx.fileSet.has(f.toLowerCase())).length;
      codeFilesExist = existCount / codeFiles.length;
      if (codeFilesExist < 0.5) {
        decayReasons.push(`codeChanges 文件存活 ${existCount}/${codeFiles.length}`);
      }
    }

    // 加权计算 relevanceScore
    const relevanceScore = Math.round(
      (triggerStillMatches ? 1 : 0) * weights.triggerStillMatches * 100 +
        symbolsAlive * weights.symbolsAlive * 100 +
        (depsIntact ? 1 : 0) * weights.depsIntact * 100 +
        codeFilesExist * weights.codeFilesExist * 100
    );

    // 分级判定——使用 EvolutionPolicy 集中管理
    const classification = EvolutionPolicy.classifyRelevance(relevanceScore);
    const verdict = classification.verdict;

    return {
      recipeId: recipe.id,
      title: recipe.title,
      relevanceScore,
      verdict,
      evidence: {
        triggerStillMatches,
        symbolsAlive,
        depsIntact,
        codeFilesExist,
      },
      decayReasons,
    };
  }

  /** 检查 trigger 模式是否仍有匹配文件 */
  #checkTriggerMatch(trigger: string, fileList: string[]): boolean {
    if (!trigger || trigger.trim() === '') {
      return true; // 无 trigger 视为匹配
    }

    const triggerLower = trigger.toLowerCase();

    // 检查 @trigger 格式 (如 @bilidili-api-response-model)
    // 这些是自定义 trigger，不与文件路径匹配，视为始终有效
    if (triggerLower.startsWith('@')) {
      return true;
    }

    // 检查文件扩展名匹配 (如 "When creating .swift files")
    const extMatch = triggerLower.match(/\.(swift|ts|tsx|js|jsx|py|java|kt|rb|go|rs|vue|svelte)\b/);
    if (extMatch) {
      const ext = extMatch[0];
      return fileList.some((f) => f.toLowerCase().endsWith(ext));
    }

    // 检查路径模式匹配 (如 "When modifying Packages/")
    const pathPatterns = trigger.match(/(?:[\w.-]+\/)+[\w.-]*/g) || [];
    if (pathPatterns.length > 0) {
      return pathPatterns.some((pattern) => {
        const p = pattern.toLowerCase();
        return fileList.some((f) => f.toLowerCase().includes(p));
      });
    }

    // 无法判断时视为匹配
    return true;
  }

  /** 从 Recipe content 中提取引用的符号 */
  #extractReferencedSymbols(recipe: FullRecipeRow): string[] {
    const symbols: string[] = [];

    // 从 content JSON 中提取
    try {
      const content = JSON.parse(recipe.content || '{}') as Record<string, unknown>;
      const pattern = (content.pattern as string) || '';
      const markdown = (content.markdown as string) || '';
      const text = `${pattern} ${markdown} ${recipe.doClause || ''} ${recipe.coreCode || ''}`;

      // 匹配 PascalCase 标识符 (类名/协议名)
      const identifiers = text.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) || [];
      // 去掉常见英文单词
      const COMMON_WORDS = new Set([
        'When',
        'Then',
        'The',
        'This',
        'That',
        'Use',
        'Not',
        'All',
        'For',
        'With',
        'From',
        'Each',
        'Must',
        'May',
        'Can',
        'Will',
        'Has',
        'Are',
        'New',
        'Set',
        'Get',
        'Add',
        'Run',
        'End',
        'Try',
        'Nil',
        'True',
        'False',
        'Void',
        'Self',
        'Type',
        'Error',
        'Result',
        'String',
        'Int',
        'Bool',
        'Array',
        'Dict',
        'Optional',
        'Protocol',
        'Class',
        'Struct',
        'Enum',
        'Import',
        'Return',
        'Override',
        'Private',
        'Public',
        'Internal',
        'Func',
        'Var',
        'Let',
        'Guard',
        'Async',
        'Await',
        'Throws',
        'Release',
        'Debug',
        'Swift',
        'Function',
        'Method',
        'Property',
        'Value',
        'Default',
        'Shared',
        'Static',
        'Final',
        'Weak',
        'Lazy',
      ]);
      for (const id of identifiers) {
        if (!COMMON_WORDS.has(id) && id.length >= 3) {
          symbols.push(id);
        }
      }
    } catch {
      /* invalid JSON */
    }

    // 去重
    return [...new Set(symbols)];
  }

  /** 从 Recipe 中提取模块/依赖引用 */
  #extractModuleReferences(recipe: FullRecipeRow): string[] {
    const modules: string[] = [];
    try {
      const content = JSON.parse(recipe.content || '{}') as Record<string, unknown>;
      const text = `${(content.markdown as string) || ''} ${(content.pattern as string) || ''} ${recipe.doClause || ''}`;

      // 匹配 import 语句中的模块名
      const importMatches = text.match(/import\s+(\w+)/g) || [];
      for (const m of importMatches) {
        const name = m.replace(/^import\s+/, '');
        if (name.length >= 2) {
          modules.push(name);
        }
      }
    } catch {
      /* invalid JSON */
    }
    return [...new Set(modules)];
  }

  /** 从 Recipe 中提取 codeChanges 引用的文件路径 */
  async #extractCodeFiles(recipe: FullRecipeRow): Promise<string[]> {
    const files: string[] = [];
    try {
      const content = JSON.parse(recipe.content || '{}') as Record<string, unknown>;
      const codeChanges = content.codeChanges as Array<{ file?: string }> | undefined;
      if (Array.isArray(codeChanges)) {
        for (const change of codeChanges) {
          if (change.file) {
            files.push(change.file);
          }
        }
      }
    } catch {
      /* invalid JSON */
    }

    // reasoning.sources 在 entry 的 reasoning 属性中
    try {
      const entry = await this.#knowledgeRepo.findById(recipe.id);
      if (entry?.reasoning) {
        const reasoning = (typeof entry.reasoning === 'object' ? entry.reasoning : {}) as {
          sources?: Array<string | { file?: string; path?: string }>;
        };
        if (Array.isArray(reasoning.sources)) {
          for (const src of reasoning.sources) {
            if (typeof src === 'string') {
              files.push(src);
            } else if (src?.file) {
              files.push(src.file);
            } else if (src?.path) {
              files.push(src.path);
            }
          }
        }
      }
    } catch {
      /* entry not found */
    }

    return [...new Set(files)];
  }

  /** 执行衰退状态转换 — 统一走 EvolutionGateway */
  async #executeDecay(result: RelevanceAuditResult): Promise<boolean> {
    try {
      const description = `[Rescan Relevance Audit] Score: ${result.relevanceScore}. ${result.decayReasons.join('; ')}`;
      const evidence = [{ relevanceScore: result.relevanceScore, evidence: result.evidence }];

      // dead → 高置信度 deprecate（Gateway 会立即执行）
      // severe/decay → 较低置信度 deprecate（Gateway 会创建观察窗口 Proposal）
      const { confidence } = EvolutionPolicy.classifyRelevance(result.relevanceScore);

      const gatewayResult = await this.#gateway.submit({
        recipeId: result.recipeId,
        action: 'deprecate',
        source: 'relevance-audit',
        confidence,
        description,
        evidence,
      });

      if (gatewayResult.outcome === 'error') {
        this.#logger.warn(
          `[RelevanceAuditor] Gateway rejected ${result.recipeId}: ${gatewayResult.error}`
        );
        return false;
      }

      this.#logger.info(
        `[RelevanceAuditor] ${result.verdict.toUpperCase()}: "${result.title}" → ${gatewayResult.outcome} (score: ${result.relevanceScore})`
      );
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#logger.warn(`[RelevanceAuditor] executeDecay failed for ${result.recipeId}: ${msg}`);
      return false;
    }
  }
}

/** @deprecated Use RelevanceAuditor instead */
export { RelevanceAuditor as RecipeRelevanceAuditor };
