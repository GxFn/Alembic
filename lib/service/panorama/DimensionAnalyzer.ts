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
import {
  DIMENSION_REGISTRY,
  resolveActiveDimensions,
  resolveRecipeDimensionId,
} from '#domain/dimension/index.js';
import { LanguageService } from '#shared/LanguageService.js';
import { COUNTABLE_LIFECYCLES } from '../../domain/knowledge/Lifecycle.js';
import type { BootstrapRepositoryImpl } from '../../repository/bootstrap/BootstrapRepository.js';
import type { CodeEntityRepositoryImpl } from '../../repository/code/CodeEntityRepository.js';
import type { KnowledgeRepositoryImpl } from '../../repository/knowledge/KnowledgeRepository.impl.js';
import type { HealthDimension, HealthRadar, KnowledgeGap } from './PanoramaTypes.js';

/* ═══ DimensionAnalyzer Class ═════════════════════════════ */

export class DimensionAnalyzer {
  readonly #bootstrapRepo: BootstrapRepositoryImpl;
  readonly #entityRepo: CodeEntityRepositoryImpl;
  readonly #knowledgeRepo: KnowledgeRepositoryImpl;
  readonly #projectRoot: string;

  constructor(
    bootstrapRepo: BootstrapRepositoryImpl,
    entityRepo: CodeEntityRepositoryImpl,
    knowledgeRepo: KnowledgeRepositoryImpl,
    projectRoot: string
  ) {
    this.#bootstrapRepo = bootstrapRepo;
    this.#entityRepo = entityRepo;
    this.#knowledgeRepo = knowledgeRepo;
    this.#projectRoot = projectRoot;
  }

  /**
   * 分析项目知识健康雷达
   *
   * @param moduleRoles — 项目中存在的模块角色 (用于 gap 优先级推断)
   */
  async analyze(moduleRoles: string[]): Promise<{ radar: HealthRadar; gaps: KnowledgeGap[] }> {
    // 0. 按项目语言过滤活跃维度（排除无关语言/框架维度）
    const activeDims = await this.#resolveActiveDims();

    // 1. 从 DB 获取所有活跃 recipe 的维度分类信息
    const recipes = await this.#fetchRecipeMetadata();

    // 2. 将每条 recipe 映射到维度
    const dimensionCounts = new Map<string, { count: number; titles: string[] }>();
    for (const def of activeDims) {
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
    const dimensions: HealthDimension[] = activeDims.map((def) => {
      const entry = dimensionCounts.get(def.id)!;
      return this.#scoreDimension(def, entry.count, entry.titles);
    });

    // 4. 加权平均健康分
    let weightedSum = 0;
    let weightTotal = 0;
    for (let i = 0; i < activeDims.length; i++) {
      weightedSum += dimensions[i].score * activeDims[i].weight;
      weightTotal += activeDims[i].weight;
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
    const gaps = this.#detectDimensionGaps(dimensions, activeDims, roleSet);

    return { radar, gaps };
  }

  /* ─── 按项目语言解析活跃维度 ───────────────────── */

  async #resolveActiveDims(): Promise<readonly UnifiedDimension[]> {
    // 1. 优先从 bootstrap_snapshots 获取 primary_lang
    try {
      const primaryLang = await this.#bootstrapRepo.getLatestPrimaryLang(this.#projectRoot);
      if (primaryLang) {
        return resolveActiveDimensions(primaryLang);
      }
    } catch {
      // 无 bootstrap 数据 → 继续尝试从 code_entities 推断
    }

    // 2. 从 code_entities 文件扩展名推断主语言
    const inferredLang = await this.#inferLanguageFromEntities();
    if (inferredLang) {
      return resolveActiveDimensions(inferredLang);
    }

    return DIMENSION_REGISTRY;
  }

  /**
   * 从 code_entities 文件扩展名统计推断项目主语言
   *
   * 当无 bootstrap_snapshots 时使用（如仅执行了 scan 但未 bootstrap 的项目）
   */
  async #inferLanguageFromEntities(): Promise<string | null> {
    try {
      const filePaths = await this.#entityRepo.findDistinctFilePaths(this.#projectRoot, 2000);

      if (filePaths.length === 0) {
        return null;
      }

      const langCounts = new Map<string, number>();
      for (const fp of filePaths) {
        if (!fp) {
          continue;
        }
        const dotIdx = fp.lastIndexOf('.');
        if (dotIdx < 0) {
          continue;
        }
        const ext = fp.slice(dotIdx).toLowerCase();
        const lang = LanguageService.langFromExt(ext);
        if (lang !== 'unknown') {
          langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
        }
      }

      // .h 文件可能属于 Swift/ObjC 项目 — 如果同时存在 .swift 文件则优先 swift
      if (langCounts.has('swift') && langCounts.has('objectivec')) {
        const swiftCount = langCounts.get('swift')!;
        const objcCount = langCounts.get('objectivec')!;
        if (swiftCount >= objcCount * 0.2) {
          return 'swift';
        }
      }

      // 选最多的语言
      let bestLang = '';
      let bestCount = 0;
      for (const [lang, _count] of langCounts) {
        if (_count > bestCount) {
          bestLang = lang;
          bestCount = _count;
        }
      }

      return bestLang || null;
    } catch {
      return null;
    }
  }

  /* ─── 从 DB 获取 recipe 元数据 ─────────────────── */

  async #fetchRecipeMetadata(): Promise<RecipeMetadata[]> {
    try {
      return await this.#knowledgeRepo.findRecipeMetadata(COUNTABLE_LIFECYCLES);
    } catch {
      return [];
    }
  }

  /* ─── Recipe → 维度分类 ────────────────────────── */

  /**
   * 将 recipe 分类到最匹配的维度
   *
   * 委托给统一 RecipeDimension resolver；兼容旧 category / knowledgeType 维度写法。
   */
  #classifyRecipe(recipe: RecipeMetadata): string | null {
    return resolveRecipeDimensionId(recipe);
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

  #detectDimensionGaps(
    dimensions: HealthDimension[],
    activeDims: readonly UnifiedDimension[],
    moduleRoles: Set<string>
  ): KnowledgeGap[] {
    const gaps: KnowledgeGap[] = [];

    for (let i = 0; i < dimensions.length; i++) {
      const dim = dimensions[i];
      const def = activeDims[i];

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
  dimensionId: string;
  category: string;
  knowledgeType: string;
  topicHint: string;
  kind: string;
}
