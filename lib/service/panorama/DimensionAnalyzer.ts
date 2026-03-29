/**
 * DimensionAnalyzer — 多维度知识健康分析
 *
 * 灵感来源:
 *   - ISO/IEC 25010 质量模型 (8 大特性: 可靠性、安全性、可维护性…)
 *   - ThoughtWorks Tech Radar (Adopt/Trial/Assess/Hold 四环)
 *   - 雷达图/蛛网图可视化模型
 *
 * 核心思路: 不再按「模块 × 文件数」衡量覆盖，
 * 而是按「知识维度」衡量项目在各工程方向上的规范成熟度。
 * 某维度 Recipe 为 0 → 该方向完全空白，标示为 gap。
 *
 * @module DimensionAnalyzer
 */

import type { CeDbLike, HealthDimension, HealthRadar, KnowledgeGap } from './PanoramaTypes.js';

/* ═══ 维度定义 ════════════════════════════════════════════ */

interface DimensionDef {
  id: string;
  name: string;
  description: string;
  /** 主匹配: knowledge_entries.topicHint */
  topics: string[];
  /** 次匹配: knowledge_entries.category */
  categories: string[];
  /** 维度权重 (用于加权平均健康分)。1.0 = 必选维度 */
  weight: number;
  /** 当该维度为 gap 时的建议主题 */
  suggestedTopics: string[];
  /** 关联模块角色 — 若项目存在这些角色的模块，gap 优先级升高 */
  relatedRoles: string[];
}

/**
 * 标准维度列表
 *
 * 覆盖主流软件工程关切方向，任何项目都应有所涉猎。
 * `topics` 与 `categories` 匹配 knowledge_entries 的字段。
 */
const DIMENSION_DEFS: readonly DimensionDef[] = [
  {
    id: 'architecture',
    name: '架构设计',
    description: '模块结构、分层策略、依赖管理、设计模式',
    topics: ['architecture', 'scaffold', 'workflow'],
    categories: ['architecture', 'project-profile'],
    weight: 1.0,
    suggestedTopics: ['module-boundary', 'dependency-rule', 'layer-strategy'],
    relatedRoles: ['core', 'foundation', 'app'],
  },
  {
    id: 'coding-standards',
    name: '编码规范',
    description: '命名约定、代码风格、文档注释、import 顺序',
    topics: ['conventions'],
    categories: ['code-standard'],
    weight: 0.8,
    suggestedTopics: ['naming-convention', 'code-style', 'documentation'],
    relatedRoles: [],
  },
  {
    id: 'error-handling',
    name: '错误处理',
    description: '异常模式、错误恢复、输入验证、防御性编程',
    topics: ['error-handling', 'constraints'],
    categories: [],
    weight: 1.0,
    suggestedTopics: ['exception-pattern', 'error-recovery', 'input-validation'],
    relatedRoles: ['service', 'networking', 'core'],
  },
  {
    id: 'concurrency',
    name: '并发与线程',
    description: '线程安全、异步模式、竞态条件防护、锁策略',
    topics: ['concurrency', 'async'],
    categories: [],
    weight: 0.9,
    suggestedTopics: ['thread-safety', 'async-pattern', 'race-condition'],
    relatedRoles: ['service', 'networking', 'storage'],
  },
  {
    id: 'data-management',
    name: '数据管理',
    description: '持久化、缓存、序列化、数据流向完整性',
    topics: ['data', 'data-flow', 'memory'],
    categories: ['event-and-data-flow'],
    weight: 0.8,
    suggestedTopics: ['persistence', 'caching', 'serialization', 'data-integrity'],
    relatedRoles: ['storage', 'model'],
  },
  {
    id: 'networking',
    name: '网络通信',
    description: 'API 契约、请求模式、重试策略、实时通信',
    topics: ['networking', 'real-time'],
    categories: [],
    weight: 0.7,
    suggestedTopics: ['api-contract', 'retry-strategy', 'request-pattern'],
    relatedRoles: ['networking'],
  },
  {
    id: 'ui-patterns',
    name: '界面模式',
    description: 'UI 组件规范、生命周期、导航、数据绑定',
    topics: ['ui', 'binding', 'pagination'],
    categories: [],
    weight: 0.7,
    suggestedTopics: ['component-pattern', 'lifecycle', 'navigation'],
    relatedRoles: ['ui', 'feature'],
  },
  {
    id: 'testing',
    name: '测试策略',
    description: '测试模式、Mock 策略、CI/CD 流程',
    topics: ['testing', 'test'],
    categories: [],
    weight: 0.9,
    suggestedTopics: ['unit-test', 'mock-strategy', 'ci-cd'],
    relatedRoles: [],
  },
  {
    id: 'security',
    name: '安全',
    description: '认证授权、输入校验、加密、权限控制',
    topics: ['security', 'auth'],
    categories: [],
    weight: 1.0,
    suggestedTopics: ['authentication', 'authorization', 'encryption'],
    relatedRoles: ['networking', 'service'],
  },
  {
    id: 'performance',
    name: '性能优化',
    description: '内存管理、懒加载、缓存策略、渲染优化',
    topics: ['performance', 'optimization'],
    categories: [],
    weight: 0.8,
    suggestedTopics: ['memory-management', 'lazy-loading', 'rendering'],
    relatedRoles: ['ui', 'storage'],
  },
  {
    id: 'observability',
    name: '可观测性',
    description: '日志规范、事件追踪、监控诊断',
    topics: ['logging', 'event', 'monitoring'],
    categories: [],
    weight: 0.7,
    suggestedTopics: ['logging-standard', 'event-tracking', 'diagnostics'],
    relatedRoles: ['service', 'core'],
  },
] as const;

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
   * 优先级: topicHint 精确匹配 → category 匹配 → null
   */
  #classifyRecipe(recipe: RecipeMetadata): string | null {
    // 1. topicHint 精确匹配
    if (recipe.topicHint) {
      for (const def of DIMENSION_DEFS) {
        if (def.topics.includes(recipe.topicHint)) {
          return def.id;
        }
      }
    }

    // 2. category 匹配
    if (recipe.category) {
      for (const def of DIMENSION_DEFS) {
        if (def.categories.includes(recipe.category)) {
          return def.id;
        }
      }
    }

    return null;
  }

  /* ─── 维度评分 ─────────────────────────────────── */

  #scoreDimension(def: DimensionDef, recipeCount: number, titles: string[]): HealthDimension {
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
      name: def.name,
      description: def.description,
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
        dimensionName: def.name,
        recipeCount: dim.recipeCount,
        status: dim.status,
        priority,
        suggestedTopics: def.suggestedTopics,
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
