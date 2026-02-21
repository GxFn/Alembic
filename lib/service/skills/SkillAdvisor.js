/**
 * SkillAdvisor — 基于使用模式的 Skill 推荐引擎
 *
 * 分析项目使用行为并推荐创建 Skill：
 *   1. Guard 违规模式 — 同类违规反复出现 → 编码规范 Skill
 *   2. Memory 偏好积累 — 用户偏好超过阈值 → 约定总结 Skill
 *   3. Recipe 分布缺口 — 某类 Recipe 高频使用但无对应 Skill
 *   4. 搜索 miss — 高频搜索但低命中 → 知识盲区 Skill
 *
 * 设计原则：
 *   - 只做分析和推荐，不自动创建（由 Agent 决策执行 create_skill）
 *   - 静默降级：任何数据源读取失败不影响其他维度
 *   - 零 AI 调用 — 纯规则分析，确保即时返回
 *   - 推荐结果包含 draft 草稿（name + description + rationale），
 *     Agent 可直接调用 create_skill 创建
 */

import fs from 'node:fs';
import path from 'node:path';
import { getProjectSkillsPath } from '../../infrastructure/config/Paths.js';

export class SkillAdvisor {
  #projectRoot;
  #db;

  /**
   * @param {string} projectRoot — 用户项目根目录
   * @param {object} [opts]
   * @param {object} [opts.database] — better-sqlite3 实例（可选）
   */
  constructor(projectRoot, { database } = {}) {
    this.#projectRoot = projectRoot;
    this.#db = database || null;
  }

  /**
   * 生成 Skill 推荐列表
   *
   * @returns {{
   *   suggestions: Array<{
   *     name: string,
   *     description: string,
   *     rationale: string,
   *     source: string,
   *     priority: 'high' | 'medium' | 'low',
   *     signals: object
   *   }>,
   *   analysisContext: object
   * }}
   */
  suggest() {
    const existingSkills = this.#listExistingProjectSkills();
    const suggestions = [];
    const analysisContext = {};

    // ── 维度 1: Guard 违规模式 ──
    try {
      const guardInsights = this.#analyzeGuardPatterns();
      analysisContext.guard = guardInsights.summary;
      suggestions.push(...guardInsights.suggestions.filter((s) => !existingSkills.has(s.name)));
    } catch {
      /* silent */
    }

    // ── 维度 2: Memory 偏好积累 ──
    try {
      const memoryInsights = this.#analyzeMemoryPatterns();
      analysisContext.memory = memoryInsights.summary;
      suggestions.push(...memoryInsights.suggestions.filter((s) => !existingSkills.has(s.name)));
    } catch {
      /* silent */
    }

    // ── 维度 3: Recipe 分布与使用 ──
    try {
      const recipeInsights = this.#analyzeRecipePatterns();
      analysisContext.recipes = recipeInsights.summary;
      suggestions.push(...recipeInsights.suggestions.filter((s) => !existingSkills.has(s.name)));
    } catch {
      /* silent */
    }

    // ── 维度 4: 候选积压 ──
    try {
      const candidateInsights = this.#analyzeCandidatePatterns();
      analysisContext.candidates = candidateInsights.summary;
      suggestions.push(...candidateInsights.suggestions.filter((s) => !existingSkills.has(s.name)));
    } catch {
      /* silent */
    }

    // 按优先级排序：high > medium > low
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    suggestions.sort((a, b) => (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2));

    return {
      suggestions,
      existingProjectSkills: [...existingSkills],
      analysisContext,
      hint:
        suggestions.length > 0
          ? `发现 ${suggestions.length} 个 Skill 创建建议。你可以使用 autosnippet_skill({ operation: "create" }) 直接创建，也可以根据 rationale 自行判断是否需要。`
          : '当前项目使用模式暂无明确的 Skill 创建建议。继续使用后会积累更多信号。',
    };
  }

  // ═══════════════════════════════════════════════════════
  //  维度 1: Guard 违规模式分析
  // ═══════════════════════════════════════════════════════

  #analyzeGuardPatterns() {
    const suggestions = [];
    if (!this.#db) {
      return { summary: 'DB 不可用', suggestions };
    }

    try {
      // 查询 Guard 违规记录（audit_logs 中 action LIKE 'guard%' + result='violation'）
      const rows = this.#db
        .prepare(`
        SELECT json_extract(operation_data, '$.ruleName') as ruleName,
               COUNT(*) as cnt
        FROM audit_logs
        WHERE action LIKE 'guard%'
          AND result = 'violation'
        GROUP BY ruleName
        HAVING cnt >= 3
        ORDER BY cnt DESC
        LIMIT 5
      `)
        .all();

      if (rows.length > 0) {
        const topRule = rows[0];
        suggestions.push({
          name: `project-guard-${_kebab(topRule.ruleName || 'common')}`,
          description: `项目编码规范 — 基于高频 Guard 违规「${topRule.ruleName}」（${topRule.cnt} 次）自动推荐`,
          rationale: `Guard 规则「${topRule.ruleName}」被违反 ${topRule.cnt} 次，说明团队可能不了解此规范。创建 Skill 可以让 AI 在编码时主动提醒，并提供正确写法参考。`,
          source: 'guard_violations',
          priority: topRule.cnt >= 10 ? 'high' : 'medium',
          signals: { ruleName: topRule.ruleName, violationCount: topRule.cnt, allRules: rows },
        });
      }

      return {
        summary: { violationRules: rows.length, topViolations: rows.slice(0, 3) },
        suggestions,
      };
    } catch {
      return { summary: 'Guard audit_log 查询失败', suggestions };
    }
  }

  // ═══════════════════════════════════════════════════════
  //  维度 2: Memory 偏好分析
  // ═══════════════════════════════════════════════════════

  #analyzeMemoryPatterns() {
    const suggestions = [];
    const memoryPath = path.join(this.#projectRoot, '.autosnippet', 'memory.jsonl');

    if (!fs.existsSync(memoryPath)) {
      return { summary: '无 Memory 记录', suggestions };
    }

    try {
      const raw = fs.readFileSync(memoryPath, 'utf-8').trim();
      if (!raw) {
        return { summary: '无 Memory 记录', suggestions };
      }

      const entries = raw
        .split('\n')
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      const preferences = entries.filter((e) => e.type === 'preference');

      if (preferences.length >= 5) {
        // 有足够多的偏好积累 → 建议归纳为 Skill
        const sample = preferences
          .slice(-5)
          .map((p) => p.content)
          .join('\n- ');
        suggestions.push({
          name: 'project-conventions',
          description: `项目约定总结 — 基于 ${preferences.length} 条团队偏好自动推荐`,
          rationale: `Memory 中已积累 ${preferences.length} 条用户偏好（如"我们不用…"、"以后都…"），建议归纳为一个 Skill 文档，让 AI 在每次对话中都能参考：\n- ${sample}`,
          source: 'memory_preferences',
          priority: preferences.length >= 10 ? 'high' : 'medium',
          signals: { totalPreferences: preferences.length, recentSamples: preferences.slice(-5) },
        });
      }

      return {
        summary: { totalEntries: entries.length, preferences: preferences.length },
        suggestions,
      };
    } catch {
      return { summary: 'Memory 读取失败', suggestions };
    }
  }

  // ═══════════════════════════════════════════════════════
  //  维度 3: Recipe 分布与使用热度
  // ═══════════════════════════════════════════════════════

  #analyzeRecipePatterns() {
    const suggestions = [];
    if (!this.#db) {
      return { summary: 'DB 不可用', suggestions };
    }

    try {
      // 按 category 分布
      const categories = this.#db
        .prepare(`
        SELECT category, COUNT(*) as cnt
        FROM knowledge_entries
        WHERE lifecycle = 'active' AND category IS NOT NULL AND category != ''
        GROUP BY category
        ORDER BY cnt DESC
      `)
        .all();

      // 按 language 分布
      const languages = this.#db
        .prepare(`
        SELECT language, COUNT(*) as cnt
        FROM knowledge_entries
        WHERE lifecycle = 'active' AND language IS NOT NULL AND language != ''
        GROUP BY language
        ORDER BY cnt DESC
      `)
        .all();

      // 高频使用但无自定义 Skill 的 category
      const topCategory = categories[0];
      if (topCategory && topCategory.cnt >= 10) {
        const catName = topCategory.category.toLowerCase();
        suggestions.push({
          name: `project-${_kebab(catName)}-patterns`,
          description: `${topCategory.category} 模式汇总 — 该类 Recipe 数量最多（${topCategory.cnt} 条），建议创建专属开发指南`,
          rationale: `项目中 ${topCategory.category} 类 Recipe 高达 ${topCategory.cnt} 条，占比最大。创建一个 Skill 汇总此类别的核心设计模式、常见用法和注意事项，让 AI 在处理相关代码时有更精准的参考。`,
          source: 'recipe_distribution',
          priority: 'low',
          signals: {
            category: topCategory.category,
            recipeCount: topCategory.cnt,
            allCategories: categories,
          },
        });
      }

      // 高使用量 Recipe 统计（V3: stats JSON 中的 adoptions + applications）
      let hotRecipes = [];
      try {
        hotRecipes = this.#db
          .prepare(`
          SELECT title, category,
                 (COALESCE(json_extract(stats, '$.adoptions'), 0) + COALESCE(json_extract(stats, '$.applications'), 0)) as total_usage
          FROM knowledge_entries
          WHERE lifecycle = 'active'
            AND (COALESCE(json_extract(stats, '$.adoptions'), 0) + COALESCE(json_extract(stats, '$.applications'), 0)) >= 5
          ORDER BY total_usage DESC
          LIMIT 10
        `)
          .all();
      } catch {
        /* 查询失败时降级为空 */
      }

      return {
        summary: { categories: categories.length, languages, hotRecipeCount: hotRecipes.length },
        suggestions,
      };
    } catch {
      return { summary: 'Recipe 查询失败', suggestions };
    }
  }

  // ═══════════════════════════════════════════════════════
  //  维度 4: 候选积压分析
  // ═══════════════════════════════════════════════════════

  #analyzeCandidatePatterns() {
    const suggestions = [];
    if (!this.#db) {
      return { summary: 'DB 不可用', suggestions };
    }

    try {
      // V3: candidates 已合并到 knowledge_entries，ifecycle='pending' 即为候选
      const stats = this.#db
        .prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN lifecycle='pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN lifecycle='deprecated' THEN 1 ELSE 0 END) as rejected
        FROM knowledge_entries
      `)
        .get();

      // 大量被拒绝 → 提示候选质量 Skill
      if (stats && stats.rejected >= 10) {
        suggestions.push({
          name: 'project-candidate-quality',
          description: `候选提交质量指南 — ${stats.rejected} 条候选被拒，建议创建提交标准 Skill`,
          rationale: `已有 ${stats.rejected} 条候选被驳回（总计 ${stats.total} 条）。创建一个 Skill 明确项目的候选提交标准（哪些代码值得提取、必填字段要求、质量标杆），可以减少返工。`,
          source: 'candidate_rejection',
          priority: stats.rejected >= 20 ? 'high' : 'medium',
          signals: { total: stats.total, pending: stats.pending, rejected: stats.rejected },
        });
      }

      return {
        summary: stats || {},
        suggestions,
      };
    } catch {
      return { summary: '候选查询失败', suggestions };
    }
  }

  // ═══════════════════════════════════════════════════════
  //  辅助方法
  // ═══════════════════════════════════════════════════════

  /**
   * 列出已有的项目级 Skill 名称集合（避免重复推荐）
   */
  #listExistingProjectSkills() {
    const names = new Set();
    const dir = getProjectSkillsPath(this.#projectRoot);
    try {
      fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .forEach((d) => names.add(d.name));
    } catch {
      /* no project skills */
    }
    return names;
  }
}

/**
 * 字符串转 kebab-case（简化版）
 */
function _kebab(str) {
  return (str || 'unknown')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .substring(0, 30);
}

export default SkillAdvisor;
