/**
 * ChatAgentTasks — ChatAgent 预定义任务方法（从 ChatAgent.js 提取）
 *
 * 每个任务接收 context 对象: { executeTool, aiProvider, container, logger }
 * - executeTool(toolName, params) — 执行指定工具
 * - aiProvider — AI Provider 实例
 * - container — ServiceContainer
 * - logger — Logger 实例
 */

/**
 * 任务: 提交前查重 + 质量预评
 * 1. check_duplicate → 若发现相似 ≥ 0.7 则建议合并
 * 2. 顺便返回质量评估建议
 */
export async function taskCheckAndSubmit(context, { candidate, projectRoot }) {
  const { executeTool, aiProvider } = context;

  // Step 1: 查重
  const duplicates = await executeTool('check_duplicate', {
    candidate,
    projectRoot,
    threshold: 0.5,
  });

  // Step 2: 如果有高相似度，使用 AI 分析是否真正重复
  const highSim = (duplicates.similar || []).filter((d) => d.similarity >= 0.7);
  let aiVerdict = null;
  if (highSim.length > 0 && aiProvider) {
    const verdictPrompt = `以下新候选代码与已有 Recipe 高度相似，请判断是否真正重复。

新候选:
- Title: ${candidate.title || '(未命名)'}
- Code: ${(candidate.code || '').substring(0, 1000)}

相似 Recipe:
${highSim.map((s) => `- ${s.title} (相似度: ${s.similarity})`).join('\n')}

请回答: DUPLICATE（真正重复）/ SIMILAR（相似但不同，建议保留并标注关系）/ UNIQUE（误判，可放心提交）
只回答一个词。`;
    try {
      const raw = await aiProvider.chat(verdictPrompt, { temperature: 0, maxTokens: 20 });
      aiVerdict = (raw || '').trim().toUpperCase().split(/\s/)[0];
    } catch {
      /* ignore */
    }
  }

  return {
    duplicates: duplicates.similar || [],
    highSimilarity: highSim,
    aiVerdict,
    recommendation:
      highSim.length === 0
        ? 'safe_to_submit'
        : aiVerdict === 'DUPLICATE'
          ? 'block_duplicate'
          : 'review_suggested',
  };
}

/**
 * 任务: 批量发现 Recipe 间的知识图谱关系
 * 遍历所有 Recipe，两两分析可能的关系
 */
export async function taskDiscoverAllRelations(context, { batchSize = 20 } = {}) {
  const { executeTool, aiProvider, container, logger } = context;

  const knowledgeService = container.get('knowledgeService');
  if (!knowledgeService) {
    throw new Error('KnowledgeService 不可用');
  }

  if (!aiProvider) {
    throw new Error('AI Provider 未配置，请先设置 API Key');
  }

  // 获取所有活跃知识条目
  const { items = [], data = [] } = await knowledgeService.list(
    { lifecycle: 'active' },
    { page: 1, pageSize: 500 }
  );
  const recipes = items.length > 0 ? items : data;
  if (recipes.length < 2) {
    return {
      discovered: 0,
      totalPairs: 0,
      message: `只有 ${recipes.length} 条 Recipe，至少需要 2 条`,
    };
  }

  // 按 batch 分组分析
  const pairs = [];
  for (let i = 0; i < recipes.length; i++) {
    for (let j = i + 1; j < recipes.length; j++) {
      pairs.push([recipes[i], recipes[j]]);
    }
  }

  let discovered = 0;
  const results = [];
  let batchErrors = 0;

  // 分批处理，单批失败不终止整体
  for (let b = 0; b < pairs.length; b += batchSize) {
    const batch = pairs.slice(b, b + batchSize);
    try {
      const result = await executeTool('discover_relations', {
        recipePairs: batch.map(([a, b]) => ({
          a: {
            id: a.id,
            title: a.title,
            category: a.category,
            language: a.language,
            code: String(a.content || a.code || '').substring(0, 500),
          },
          b: {
            id: b.id,
            title: b.title,
            category: b.category,
            language: b.language,
            code: String(b.content || b.code || '').substring(0, 500),
          },
        })),
      });

      if (result.error) {
        batchErrors++;
        logger.warn(
          `[DiscoverRelations] Batch ${Math.floor(b / batchSize) + 1} error: ${result.error}`
        );
        continue;
      }
      if (result.relations) {
        discovered += result.relations.length;
        results.push(...result.relations);
      }
    } catch (err) {
      batchErrors++;
      logger.warn(
        `[DiscoverRelations] Batch ${Math.floor(b / batchSize) + 1} threw: ${err.message}`
      );
    }
  }

  return {
    discovered,
    totalPairs: pairs.length,
    totalBatches: Math.ceil(pairs.length / batchSize),
    batchErrors,
    relations: results,
  };
}

/**
 * 任务: 批量 AI 补全候选语义字段
 */
export async function taskFullEnrich(context, { status = 'pending', maxCount = 50 } = {}) {
  const { executeTool, container } = context;

  const knowledgeService = container.get('knowledgeService');

  const { items = [], data = [] } = await knowledgeService.list(
    { lifecycle: status },
    { page: 1, pageSize: maxCount }
  );
  const candidates = items.length > 0 ? items : data;
  if (candidates.length === 0) {
    return { enriched: 0, message: 'No candidates to enrich' };
  }

  // 筛选缺失语义字段的候选
  const needEnrich = candidates.filter((c) => {
    const m = c.metadata || {};
    return !m.rationale || !m.knowledgeType || !m.complexity;
  });

  if (needEnrich.length === 0) {
    return { enriched: 0, message: 'All candidates already enriched' };
  }

  const result = await executeTool('enrich_candidate', {
    candidateIds: needEnrich.map((c) => c.id).slice(0, 20),
  });

  return result;
}

/**
 * 任务: 批量质量审计全部 Recipe
 * 对活跃 Recipe 逐个评分，返回低于阈值的列表
 */
export async function taskQualityAudit(context, { threshold = 0.6, maxCount = 100 } = {}) {
  const { executeTool, container } = context;

  const knowledgeService = container.get('knowledgeService');

  const { items = [], data = [] } = await knowledgeService.list(
    { lifecycle: 'active' },
    { page: 1, pageSize: maxCount }
  );
  const recipes = items.length > 0 ? items : data;
  if (recipes.length === 0) {
    return { total: 0, lowQuality: [], message: 'No active recipes' };
  }

  const lowQuality = [];
  const gradeDistribution = { A: 0, B: 0, C: 0, D: 0, F: 0 };

  for (const recipe of recipes) {
    const scoreResult = await executeTool('quality_score', { recipe });
    if (scoreResult.grade) {
      gradeDistribution[scoreResult.grade] = (gradeDistribution[scoreResult.grade] || 0) + 1;
    }
    if (scoreResult.score < threshold) {
      lowQuality.push({
        id: recipe.id,
        title: recipe.title,
        score: scoreResult.score,
        grade: scoreResult.grade,
        dimensions: scoreResult.dimensions,
      });
    }
  }

  lowQuality.sort((a, b) => a.score - b.score);

  return {
    total: recipes.length,
    threshold,
    gradeDistribution,
    lowQualityCount: lowQuality.length,
    lowQuality,
  };
}

/**
 * 任务: Guard 完整扫描
 * 对代码运行全部 Guard 规则 + 生成修复建议
 */
export async function taskGuardFullScan(context, { code, language, filePath } = {}) {
  const { executeTool, aiProvider } = context;

  if (!code) {
    return { error: 'code is required' };
  }

  // Step 1: 静态检查
  const checkResult = await executeTool('guard_check_code', {
    code,
    language: language || 'unknown',
    scope: 'project',
  });

  // Step 2: 如果有违规且 AI 可用，生成修复建议
  let suggestions = null;
  if (checkResult.violationCount > 0 && aiProvider) {
    try {
      const violationSummary = (checkResult.violations || [])
        .slice(0, 5)
        .map(
          (v) =>
            `- [${v.severity}] ${v.message || v.ruleName} (line ${v.line || v.matches?.[0]?.line || '?'})`
        )
        .join('\n');

      const prompt = `以下代码存在 Guard 规则违规。请为每个违规提供修复建议。

违规列表:
${violationSummary}

代码片段:
\`\`\`${language || ''}
${code.substring(0, 3000)}
\`\`\`

请用 JSON 数组格式返回建议: [{"violation": "...", "suggestion": "...", "fixExample": "..."}]`;

      suggestions =
        (await aiProvider.chatWithStructuredOutput(prompt, {
          openChar: '[',
          closeChar: ']',
          temperature: 0.3,
        })) || [];
    } catch {
      /* AI suggestions optional */
    }
  }

  return {
    filePath: filePath || '(inline)',
    language,
    violationCount: checkResult.violationCount,
    violations: checkResult.violations,
    suggestions,
  };
}
