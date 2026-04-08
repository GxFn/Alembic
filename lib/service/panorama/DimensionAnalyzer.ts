/**
 * DimensionAnalyzer — 多维度知识健康分析
 *
 * **v2: 从统一维度注册表 (DimensionRegistry) 派生维度**
 *
 * 灵感来源:
 *   - ISO/IEC 25010 质量模型 (8 大特性: 可靠性、安全性、可维护性…)
 *   - ThoughtWorks Tech Radar (Adopt/Trial/Assess/Hold 四环)
 *   - 雷达图/蛛网图可视化模型
 *
 * 核心思路: 按「知识维度」衡量项目在各工程方向上的规范成熟度。
 * 某维度 Recipe 为 0 → 该方向完全空白，标示为 gap。
 *
 * @module DimensionAnalyzer
 */

import type { UnifiedDimension } from '#domain/dimension/index.js';
import { classifyRecipeToDimension, DIMENSION_REGISTRY } from '#domain/dimension/index.js';
import type { CeDbLike, HealthDimension, HealthRadar, KnowledgeGap } from './PanoramaTypes.js';

/* ═══ 维度定义 — 从统一注册表派生 ═══════════════════════ */

/**
 * Panorama 使用全量维度注册表进行健康评估。
 * 所有维度（含语言/框架条件维度）都参与评估 —
 * 若该语言未激活但有 Recipe → 仍计入(只是不生成 gap 建议)。
 */
const DIMENSION_DEFS: readonly UnifiedDimension[] = DIMENSION_REGISTRY;

/* ═══ DimensionAnalyzer Class ═════════════════════════════ */

export class DimensionAnalyzer {
  readonly #db: CeDbLike;

  constructor(db: CeDbLike) {
    this.#db = db;
  }

  /**
   * 分析项目知识健康雷达
   *
   * @param moduleRoles — 项目中存在的模块角色 (用于 gap 优先级推断)
   */
  analyze(moduleRoles: string[]): { radar: HealthRadar; gaps: KnowledgeGap[] } {
    // 1. 从 DB 获取所有活跃 recipe 的维度分类信息
    const recipes = this.#fetchRecipeMetadata();

    // 2. 将每条 recipe 映射到维度
    const dimensionCounts = new Map<string, { count: number; titles: string[] }>();
    for (const def of DIMENSION_DEFS) {
      dimensionCounts.set(def.id, { count: 0, titles: [] });
    }

    let totalRecipes = 0;
    for (const recipe of recipes) {
      totalRecipes++;
      const dimId = this.#classifyRecipe(recipe);
      if (dimId) {
        const entry = dimensionCounts.get(dimId)!;
        entry.count++;
        if (entry.titles.length < 3) {
          entry.titles.push(recipe.title);
        }
      }
    }

    // 3. 计算各维度得分与状态
    const dimensions: HealthDimension[] = DIMENSION_DEFS.map((def) => {
      const entry = dimensionCounts.get(def.id)!;
      return this.#scoreDimension(def, entry.count, entry.titles);
    });

    // 4. 加权平均健康分
    let weightedSum = 0;
    let weightTotal = 0;
    for (let i = 0; i < DIMENSION_DEFS.length; i++) {
      weightedSum += dimensions[i].score * DIMENSION_DEFS[i].weight;
      weightTotal += DIMENSION_DEFS[i].weight;
    }
    const overallScore = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : 0;

    // 5. 统计覆盖
    const coveredDimensions = dimensions.filter((d) => d.recipeCount > 0).length;
    const totalDimensions = dimensions.length;

    const radar: HealthRadar = {
      dimensions,
      overallScore,
      totalRecipes,
      coveredDimensions,
      totalDimensions,
      dimensionCoverage: totalDimensions > 0 ? coveredDimensions / totalDimensions : 0,
    };

    // 6. 生成维度空白 (gaps)
    const roleSet = new Set(moduleRoles);
    const gaps = this.#detectDimensionGaps(dimensions, roleSet);

    return { radar, gaps };
  }

  /* ─── 从 DB 获取 recipe 元数据 ─────────────────── */

  #fetchRecipeMetadata(): RecipeMetadata[] {
    try {
      const rows = this.#db
        .prepare(
          `SELECT title, category, topicHint, kind
           FROM knowledge_entries
           WHERE lifecycle IN ('active', 'pending')`
        )
        .all() as Array<Record<string, unknown>>;

      return rows.map((r) => ({
        title: String(r.title ?? ''),
        category: String(r.category ?? ''),
        topicHint: String(r.topicHint ?? ''),
        kind: String(r.kind ?? ''),
      }));
    } catch {
      return [];
    }
  }

  /* ─── Recipe → 维度分类 ────────────────────────── */

  /**
   * 将 recipe 分类到最匹配的维度
   *
   * 委托给 DimensionRegistry.classifyRecipeToDimension()
   */
  #classifyRecipe(recipe: RecipeMetadata): string | null {
    return classifyRecipeToDimension(recipe.topicHint, recipe.category);
  }

  /* ─── 维度评分 ─────────────────────────────────── */

  #scoreDimension(def: UnifiedDimension, recipeCount: number, titles: string[]): HealthDimension {
    // 得分: 每条 recipe 贡献 20 分, 上限 100
    const score = Math.min(100, recipeCount * 20);

    // 状态阈值
    let status: HealthDimension['status'];
    if (recipeCount === 0) {
      status = 'missing';
    } else if (recipeCount === 1) {
      status = 'weak';
    } else if (recipeCount <= 4) {
      status = 'adequate';
    } else {
      status = 'strong';
    }

    // 雷达环级 (对应 Tech Radar)
    let level: HealthDimension['level'];
    if (score >= 80) {
      level = 'adopt';
    } else if (score >= 40) {
      level = 'trial';
    } else if (score > 0) {
      level = 'assess';
    } else {
      level = 'hold';
    }

    return {
      id: def.id,
      name: def.label,
      description: def.qualityDescription,
      recipeCount,
      score,
      status,
      level,
      topRecipes: titles,
    };
  }

  /* ─── 维度空白检测 ─────────────────────────────── */

  #detectDimensionGaps(dimensions: HealthDimension[], moduleRoles: Set<string>): KnowledgeGap[] {
    const gaps: KnowledgeGap[] = [];

    for (let i = 0; i < dimensions.length; i++) {
      const dim = dimensions[i];
      const def = DIMENSION_DEFS[i];

      if (dim.status !== 'missing' && dim.status !== 'weak') {
        continue;
      }

      // 优先级推断: 维度权重 × 是否有关联模块角色
      const hasRelatedModules =
        def.relatedRoles.length === 0 || def.relatedRoles.some((r) => moduleRoles.has(r));

      let priority: KnowledgeGap['priority'];
      if (dim.status === 'missing' && def.weight >= 0.9) {
        priority = 'high';
      } else if (dim.status === 'missing' && hasRelatedModules) {
        priority = 'high';
      } else if (dim.status === 'missing') {
        priority = 'medium';
      } else {
        // weak
        priority = hasRelatedModules && def.weight >= 0.9 ? 'medium' : 'low';
      }

      const affectedRoles = def.relatedRoles.filter((r) => moduleRoles.has(r));

      gaps.push({
        dimension: def.id,
        dimensionName: def.label,
        recipeCount: dim.recipeCount,
        status: dim.status,
        priority,
        suggestedTopics: [...def.suggestedTopics],
        affectedRoles,
      });
    }

    // 按优先级排序
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    return gaps.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  }
}

/* ─── Internal types ──────────────────────────────────── */

interface RecipeMetadata {
  title: string;
  category: string;
  topicHint: string;
  kind: string;
}
