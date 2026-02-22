/**
 * composite.js — 组合工具 + 元工具 (6)
 *
 * 34. analyze_code       Guard + Recipe 搜索组合
 * 35. knowledge_overview 知识库全貌一次获取
 * 36. submit_with_check  查重 + 提交组合
 * ──  get_tool_details   元工具: 查询工具 Schema
 * ──  plan_task          元工具: 任务规划
 * ──  review_my_output   元工具: 自我质量审查
 */

import { findSimilarRecipes } from '../../candidate/SimilarityService.js';
import { checkDimensionType, DIMENSION_DISPLAY_GROUP } from './_shared.js';

// ────────────────────────────────────────────────────────────
// 34. analyze_code — 组合工具 (Guard + Recipe 搜索)
// ────────────────────────────────────────────────────────────
export const analyzeCode = {
  name: 'analyze_code',
  description:
    '综合分析一段代码：Guard 规范检查 + 相关 Recipe 搜索。一次调用完成完整分析，减少多轮工具调用。',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '待分析的源码' },
      language: { type: 'string', description: '编程语言 (swift/objc/javascript 等)' },
      filePath: { type: 'string', description: '文件路径（可选，用于上下文）' },
    },
    required: ['code'],
  },
  handler: async (params, ctx) => {
    const { code, language, filePath } = params;
    const results = {};

    // 并行执行 Guard 检查 + Recipe 搜索
    const [guardResult, searchResult] = await Promise.all([
      (async () => {
        try {
          const engine = ctx.container.get('guardCheckEngine');
          const violations = engine.checkCode(code, language || 'unknown', { scope: 'file' });
          return { violationCount: violations.length, violations };
        } catch {
          try {
            const guardService = ctx.container.get('guardService');
            const matches = await guardService.checkCode(code, { language });
            return { violationCount: matches.length, violations: matches };
          } catch {
            return { violationCount: 0, violations: [] };
          }
        }
      })(),
      (async () => {
        try {
          const searchEngine = ctx.container.get('searchEngine');
          // 取代码首段作为搜索词
          const query = code.substring(0, 200).replace(/\n/g, ' ');
          const rawResults = await searchEngine.search(query, { limit: 5 });
          return { results: rawResults || [], total: rawResults?.length || 0 };
        } catch {
          return { results: [], total: 0 };
        }
      })(),
    ]);

    results.guard = guardResult;
    results.relatedRecipes = searchResult;
    results.filePath = filePath || '(inline)';

    const hasFindings = guardResult.violationCount > 0 || searchResult.total > 0;
    results._meta = {
      confidence: hasFindings ? 'high' : 'low',
      hint: hasFindings
        ? `已完成 Guard 检查（${guardResult.violationCount} 个违规）+ Recipe 搜索（${searchResult.total} 条匹配）。`
        : '未发现 Guard 违规，也未找到相关 Recipe。可能需要先冷启动知识库。',
    };

    return results;
  },
};

// ────────────────────────────────────────────────────────────
// 35. knowledge_overview — 组合工具 (一次获取全部类型的 Recipe 统计)
// ────────────────────────────────────────────────────────────
export const knowledgeOverview = {
  name: 'knowledge_overview',
  description:
    '一次性获取知识库全貌：各类型 Recipe 分布 + 候选状态 + 知识图谱概况 + 质量概览。比分别调用 get_project_stats + search_recipes 更高效。',
  parameters: {
    type: 'object',
    properties: {
      includeTopRecipes: { type: 'boolean', description: '是否包含热门 Recipe 列表，默认 true' },
      limit: { type: 'number', description: '每类返回数量，默认 5' },
    },
  },
  handler: async (params, ctx) => {
    const { includeTopRecipes = true, limit = 5 } = params;
    const result = {};

    // 并行获取统计 + 可选的热门列表
    const [statsResult, feedbackResult] = await Promise.all([
      (async () => {
        try {
          const knowledgeService = ctx.container.get('knowledgeService');
          return knowledgeService.getStats();
        } catch {
          return null;
        }
      })(),
      (async () => {
        if (!includeTopRecipes) {
          return null;
        }
        try {
          const feedbackCollector = ctx.container.get('feedbackCollector');
          return feedbackCollector.getTopRecipes(limit);
        } catch {
          return null;
        }
      })(),
    ]);

    if (statsResult) {
      result.knowledge = statsResult;
    }

    // 知识图谱统计
    try {
      const kgService = ctx.container.get('knowledgeGraphService');
      result.knowledgeGraph = kgService.getStats();
    } catch {
      /* KG not available */
    }

    if (feedbackResult) {
      result.topRecipes = feedbackResult;
    }

    const recipeCount = result.recipes?.total || result.recipes?.count || 0;
    result._meta = {
      confidence: recipeCount > 0 ? 'high' : 'none',
      hint: recipeCount === 0 ? '知识库为空，建议先执行冷启动（bootstrap_knowledge）。' : null,
    };

    return result;
  },
};

// ────────────────────────────────────────────────────────────
// 36. submit_with_check — 组合工具 (查重 + 提交)
// ────────────────────────────────────────────────────────────
export const submitWithCheck = {
  name: 'submit_with_check',
  description:
    '安全提交候选：先执行查重检测，无重复则自动提交。一次调用完成 check_duplicate + submit_knowledge。',
  parameters: {
    type: 'object',
    properties: {
      content: {
        type: 'object',
        description:
          '{ markdown: "项目特写 Markdown", pattern: "核心代码 3-8 行，必须语法完整（括号配对、不能以 } 开头或 { 结尾）" }',
      },
      title: { type: 'string', description: '候选标题' },
      description: { type: 'string', description: '中文简述 ≤80 字' },
      trigger: { type: 'string', description: '@前缀 kebab-case 唯一标识符' },
      kind: { type: 'string', enum: ['rule', 'pattern', 'fact'] },
      topicHint: {
        type: 'string',
        enum: ['networking', 'ui', 'data', 'architecture', 'conventions'],
      },
      whenClause: { type: 'string', description: '触发场景英文' },
      doClause: { type: 'string', description: '正向指令英文' },
      dontClause: { type: 'string', description: '反向约束英文' },
      tags: { type: 'array', items: { type: 'string' } },
      reasoning: { type: 'object', description: '{ whyStandard, sources, confidence }' },
      threshold: { type: 'number', description: '相似度阈值，默认 0.7' },
    },
    required: ['content', 'title', 'trigger', 'kind', 'doClause'],
  },
  handler: async (params, ctx) => {
    const projectRoot = ctx.projectRoot;

    // ── Bootstrap 维度类型校验 ──
    const dimMeta = ctx._dimensionMeta;
    if (dimMeta && ctx.source === 'system') {
      const rejected = checkDimensionType(dimMeta, params, ctx.logger);
      if (rejected) {
        return rejected;
      }

      if (!params.tags) {
        params.tags = [];
      }
      if (!params.tags.includes(dimMeta.id)) {
        params.tags.push(dimMeta.id);
      }
      if (!params.tags.includes('bootstrap')) {
        params.tags.push('bootstrap');
      }
    }

    // Step 1: 查重
    const threshold = params.threshold || 0.7;
    const contentObj2 =
      params.content && typeof params.content === 'object'
        ? params.content
        : { markdown: '', pattern: '' };
    const cand = {
      title: params.title || '',
      summary: params.description || '',
      code: contentObj2.markdown || contentObj2.pattern || '',
    };
    const similar = findSimilarRecipes(projectRoot, cand, { threshold: 0.5, topK: 5 });
    const hasDuplicate = similar.some((s) => s.similarity >= threshold);

    if (hasDuplicate) {
      return {
        submitted: false,
        reason: 'duplicate_blocked',
        similar,
        highestSimilarity: similar[0]?.similarity || 0,
        _meta: {
          confidence: 'high',
          hint: `发现高度相似 Recipe（相似度 ${(similar[0]?.similarity * 100).toFixed(0)}%），已阻止提交。`,
        },
      };
    }

    // Step 2: 提交 — 委托给 submit_knowledge handler
    try {
      const knowledgeService = ctx.container.get('knowledgeService');
      const reasoning = params.reasoning || {
        whyStandard: '',
        sources: ['agent'],
        confidence: 0.7,
      };

      const systemFields = {
        language: ctx._projectLanguage || '',
        category: dimMeta ? DIMENSION_DISPLAY_GROUP[dimMeta.id] || dimMeta.id : 'general',
        knowledgeType: dimMeta?.allowedKnowledgeTypes?.[0] || 'code-pattern',
        source: ctx.source === 'system' ? 'bootstrap' : 'agent',
      };

      const data = {
        ...systemFields,
        title: params.title || '',
        description: params.description || '',
        tags: params.tags || [],
        trigger: params.trigger || '',
        kind: params.kind || 'pattern',
        topicHint: params.topicHint || '',
        whenClause: params.whenClause || '',
        doClause: params.doClause || '',
        dontClause: params.dontClause || '',
        coreCode: contentObj2.pattern || '',
        content: contentObj2,
        reasoning,
      };

      const created = await knowledgeService.create(data, { userId: 'agent' });

      return {
        submitted: true,
        entry: typeof created.toJSON === 'function' ? created.toJSON() : created,
        similar: similar.length > 0 ? similar : [],
        _meta: {
          confidence: 'high',
          hint:
            similar.length > 0
              ? `已提交，但有 ${similar.length} 个低相似度匹配。`
              : '已提交，无重复风险。',
        },
      };
    } catch (err) {
      return { submitted: false, reason: 'submit_error', error: err.message };
    }
  },
};

// ═══════════════════════════════════════════════════════
//  元工具: Lazy Tool Schema 按需加载
// ═══════════════════════════════════════════════════════

/**
 * get_tool_details — 查询工具的完整参数 schema
 *
 * 与 Cline .clinerules 按需加载类似:
 * System Prompt 只包含工具名+一行描述，LLM 需要调用某个工具前
 * 先通过此元工具获取完整参数定义，避免 prompt 过长浪费 token。
 */
export const getToolDetails = {
  name: 'get_tool_details',
  description: '查询指定工具的完整参数 Schema。在调用不熟悉的工具之前，先用此工具获取参数详情。',
  parameters: {
    type: 'object',
    properties: {
      toolName: {
        type: 'string',
        description: '要查询的工具名称（snake_case）',
      },
    },
    required: ['toolName'],
  },
  handler: async ({ toolName }, context) => {
    const registry = context.container?.get('toolRegistry');
    if (!registry) {
      return { error: 'ToolRegistry not available' };
    }

    const schemas = registry.getToolSchemas();
    const found = schemas.find((t) => t.name === toolName);
    if (!found) {
      const allNames = schemas.map((t) => t.name);
      return {
        error: `Tool "${toolName}" not found`,
        availableTools: allNames,
      };
    }

    return {
      name: found.name,
      description: found.description,
      parameters: found.parameters,
    };
  },
};

// ─── 元工具: 任务规划 ───────────────────────────────────
export const planTask = {
  name: 'plan_task',
  description:
    '分析当前任务并制定结构化执行计划。在开始复杂任务前调用此工具可提高执行效率和决策质量。输出将记录到日志供审计,但不会改变实际执行流程。',
  parameters: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: '执行步骤列表',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number', description: '步骤序号' },
            action: { type: 'string', description: '具体动作描述' },
            tool: { type: 'string', description: '计划使用的工具名' },
            depends_on: { type: 'array', items: { type: 'number' }, description: '依赖的步骤 ID' },
          },
          required: ['id', 'action'],
        },
      },
      strategy: {
        type: 'string',
        description: '执行策略说明(如: 先搜索补充示例再批量提交)',
      },
      estimated_iterations: {
        type: 'number',
        description: '预估需要的迭代轮数',
      },
    },
    required: ['steps', 'strategy'],
  },
  handler: async (params, context) => {
    const plan = {
      steps: params.steps || [],
      strategy: params.strategy || '',
      estimatedIterations: params.estimated_iterations || params.steps?.length || 1,
    };
    context.logger?.info('[plan_task] execution plan', plan);
    return {
      status: 'plan_recorded',
      stepCount: plan.steps.length,
      strategy: plan.strategy,
      message: `执行计划已记录 (${plan.steps.length} 步, 预估 ${plan.estimatedIterations} 轮迭代)。开始按计划执行。`,
    };
  },
};

// ─── 元工具: 自我质量审查 ───────────────────────────────
export const reviewMyOutput = {
  name: 'review_my_output',
  description:
    '回查本次会话中已提交的候选,检查质量红线是否满足。包括: 项目特写风格、description 泛化措辞、代码示例来源标注、Cursor 交付字段完整性等。返回通过/问题列表。建议在提交完所有候选后调用一次进行自检。',
  parameters: {
    type: 'object',
    properties: {
      check_rules: {
        type: 'array',
        description: '要检查的质量规则(可选, 默认检查全部)',
        items: { type: 'string' },
      },
    },
  },
  handler: async (params, context) => {
    const submitted = (context._sessionToolCalls || []).filter(
      (tc) => tc.tool === 'submit_knowledge' || tc.tool === 'submit_with_check'
    );

    if (submitted.length === 0) {
      return { status: 'no_candidates', message: '本次会话尚未提交任何候选。' };
    }

    const issues = [];
    const checked = [];

    for (const tc of submitted) {
      const p = tc.params || {};
      const contentObj3 = p.content && typeof p.content === 'object' ? p.content : {};
      const markdown = contentObj3.markdown || '';
      const title = p.title || '';
      const description = p.description || '';
      const candidateIssues = [];

      // 检查 1: 项目特写后缀
      if (!title.includes('— 项目特写') && !markdown.includes('— 项目特写')) {
        candidateIssues.push('缺少 "— 项目特写" 后缀');
      }

      // 检查 2: 项目特写融合叙事质量 — 必须同时包含代码和描述性文字
      const hasCodeBlock = /```[\s\S]*?```/.test(markdown);
      if (!hasCodeBlock) {
        candidateIssues.push('特写缺少代码示例，应包含基本用法代码');
      }
      // 去掉代码块后，剩余描述性文字应足够
      const proseLength = markdown
        .replace(/```[\s\S]*?```/g, '')
        .replace(/[#>\-*`\n]/g, '')
        .trim().length;
      if (proseLength < 50) {
        candidateIssues.push('特写缺少项目特点描述，应融合基本用法和项目特点');
      }

      // 检查 3: description 泛化措辞
      if (/本模块|该文件|这个类|该项目/.test(description)) {
        candidateIssues.push('description 使用了泛化措辞,应引用具体类名和数字');
      }

      // 检查 4: description 过短
      if (description.length < 15) {
        candidateIssues.push(
          `description 过短 (${description.length} 字), 应≥15字并包含具体类名和数字`
        );
      }

      // 检查 5: content.markdown 过短（可能是空壳）
      if (markdown.length < 200) {
        candidateIssues.push(`content.markdown 文档过短 (${markdown.length} 字), 可能缺少实质内容`);
      }

      // 检查 6: 代码示例来源
      const hasSourceAnnotation = /\([^)]*\.\w+[^)]*:\d+\)|\([^)]*\.\w+[^)]*\)/.test(markdown);
      if (hasCodeBlock && !hasSourceAnnotation) {
        candidateIssues.push('代码示例可能缺少来源文件标注 (建议标注 "来源: FileName.m:行号")');
      }

      // 检查 7: Cursor 交付字段
      if (!p.trigger) {
        candidateIssues.push('缺少 trigger 字段');
      }
      if (!p.doClause) {
        candidateIssues.push('缺少 doClause 字段');
      }
      if (!p.kind) {
        candidateIssues.push('缺少 kind 字段');
      }

      if (candidateIssues.length > 0) {
        issues.push({ title, issues: candidateIssues });
      }
      checked.push({
        title,
        passed: candidateIssues.length === 0,
        issueCount: candidateIssues.length,
      });
    }

    if (issues.length === 0) {
      return {
        status: 'all_passed',
        checkedCount: submitted.length,
        message: `✅ ${submitted.length} 条候选全部通过质量检查。`,
      };
    }

    const issueLines = issues.flatMap(({ title, issues: iss }) =>
      iss.map((i) => `• "${title}": ${i}`)
    );

    return {
      status: 'issues_found',
      checkedCount: submitted.length,
      passedCount: submitted.length - issues.length,
      failedCount: issues.length,
      details: checked,
      message: `⚠️ ${issues.length}/${submitted.length} 条候选存在质量问题:\n${issueLines.join('\n')}\n\n请修正后重新提交。`,
    };
  },
};
