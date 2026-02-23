/**
 * ai-analysis.js — AI 分析类工具 (4)
 *
 * 7. summarize_code              AI 代码摘要
 * 8. extract_recipes             从源码批量提取 Recipe
 * 9. enrich_candidate            结构补齐
 * 9b. refine_bootstrap_candidates 内容润色
 */

// ────────────────────────────────────────────────────────────
// 7. summarize_code
// ────────────────────────────────────────────────────────────
export const summarizeCode = {
  name: 'summarize_code',
  description: 'AI 代码摘要 — 分析代码片段并生成结构化摘要（包含功能描述、关键 API、使用建议）。',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '代码内容' },
      language: { type: 'string', description: '编程语言' },
    },
    required: ['code'],
  },
  handler: async (params, ctx) => {
    if (!ctx.aiProvider) {
      return { error: 'AI provider not available' };
    }
    return ctx.aiProvider.summarize(params.code, params.language);
  },
};

// ────────────────────────────────────────────────────────────
// 8. extract_recipes
// ────────────────────────────────────────────────────────────
export const extractRecipes = {
  name: 'extract_recipes',
  description:
    '从源码文件中批量提取可复用的 Recipe 结构（代码标准、设计模式、最佳实践）。支持自动 provider fallback。',
  parameters: {
    type: 'object',
    properties: {
      targetName: { type: 'string', description: 'SPM Target / 模块名称' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, content: { type: 'string' } },
        },
        description: '文件数组 [{name, content}]',
      },
    },
    required: ['targetName', 'files'],
  },
  handler: async (params, ctx) => {
    if (!ctx.aiProvider) {
      return { error: 'AI provider not available' };
    }
    const { targetName, files, comprehensive } = params;

    // 加载语言参考 Skill（如有），注入到 AI 提取 prompt
    let skillReference = null;
    try {
      const { loadBootstrapSkills } = await import('../../external/mcp/handlers/bootstrap-internal.js');
      const langProfile = ctx.aiProvider._detectLanguageProfile?.(files);
      const primaryLang = langProfile?.primaryLanguage;
      if (primaryLang) {
        const skillCtx = loadBootstrapSkills(primaryLang);
        skillReference = skillCtx.languageSkill ? skillCtx.languageSkill.substring(0, 2000) : null;
      }
    } catch {
      /* Skills not available, proceed without */
    }

    // AST 代码结构分析（如可用），注入到 AI 提取 prompt
    let astContext = null;
    try {
      const { analyzeProject, generateContextForAgent, isAvailable } = await import(
        '../../../core/AstAnalyzer.js'
      );
      if (isAvailable()) {
        const sourceFiles = files
          .filter((f) => /\.(m|mm|h|swift|js|ts|jsx|tsx)$/.test(f.name || ''))
          .map((f) => ({ path: f.name, source: f.content }));
        if (sourceFiles.length > 0) {
          const langProfile2 = ctx.aiProvider._detectLanguageProfile?.(files);
          const lang = langProfile2?.primaryLanguage === 'swift' ? 'swift' : 'objc';
          const summary = analyzeProject(sourceFiles, lang);
          astContext = generateContextForAgent(summary);
        }
      }
    } catch {
      /* AST not available, proceed without */
    }

    const extractOpts = {};
    if (skillReference) {
      extractOpts.skillReference = skillReference;
    }
    if (astContext) {
      extractOpts.astContext = astContext;
    }
    if (comprehensive) {
      extractOpts.comprehensive = true;
    }
    // 传递用户语言偏好，让 AI 输出匹配用户语言
    if (ctx.lang && ctx.lang !== 'en') {
      extractOpts.lang = ctx.lang;
    }

    // 首选：使用当前 aiProvider
    let recipes;
    let fallbackUsed;
    try {
      recipes = await ctx.aiProvider.extractRecipes(targetName, files, extractOpts);
    } catch (primaryErr) {
      // 尝试 fallback（如果 AiFactory 可用）
      let recovered = false;
      try {
        const aiFactory = ctx.container?.singletons?._aiFactory;
        if (aiFactory?.isGeoOrProviderError?.(primaryErr)) {
          const currentProvider = (process.env.ASD_AI_PROVIDER || 'google').toLowerCase();
          const fallbacks = aiFactory.getAvailableFallbacks(currentProvider);
          for (const fbName of fallbacks) {
            try {
              const fbProvider = aiFactory.createProvider({ provider: fbName });
              recipes = await fbProvider.extractRecipes(targetName, files, extractOpts);
              fallbackUsed = fbName;
              recovered = true;
              break;
            } catch {
              /* next fallback */
            }
          }
        }
      } catch {
        /* AiFactory not available */
      }
      if (!recovered) {
        throw primaryErr;
      }
    }

    if (!Array.isArray(recipes)) {
      recipes = [];
    }
    if (recipes.length === 0) {
      ctx.logger?.warn?.(
        `[extract_recipes] AI returned 0 recipes for ${targetName} (${files.length} files)`
      );
    }

    // ── V3 直透：AI 已输出完整 V3 结构，仅做来源标记 + 程序化评分/标签 ──
    let qualityScorer = null;
    let recipeExtractor = null;
    try {
      qualityScorer = ctx.container?.get?.('qualityScorer');
    } catch {
      /* not available */
    }
    try {
      recipeExtractor = ctx.container?.get?.('recipeExtractor');
    } catch {
      /* not available */
    }

    for (const recipe of recipes) {
      // 来源 & 生命周期（非 AI 职责）
      recipe.source = recipe.source || 'ai-scan';
      recipe.lifecycle = recipe.lifecycle || 'pending';

      // RecipeExtractor 语义标签增强（程序化补充，不替代 AI tags）
      const codeText = recipe.content?.pattern || '';
      if (recipeExtractor && codeText) {
        try {
          const extracted = recipeExtractor.extractFromContent(
            codeText,
            `${recipe.title || 'unknown'}.${recipe.language || 'unknown'}`,
            ''
          );
          if (extracted.semanticTags?.length > 0) {
            recipe.tags = [...new Set([...(recipe.tags || []), ...extracted.semanticTags])];
          }
          if (
            (!recipe.category || recipe.category === 'Utility') &&
            extracted.category &&
            extracted.category !== 'general'
          ) {
            recipe.category = extracted.category;
          }
        } catch {
          /* best effort */
        }
      }

      // QualityScorer 评分 → quality 结构化
      if (qualityScorer) {
        try {
          const scoreResult = qualityScorer.score(recipe);
          recipe.quality = {
            completeness: 0,
            adaptation: 0,
            documentation: 0,
            overall: scoreResult.score ?? 0,
            grade: scoreResult.grade || '',
          };
        } catch {
          /* best effort */
        }
      }
    }

    const result = { targetName, extracted: recipes.length, recipes };
    if (fallbackUsed) {
      result.fallbackUsed = fallbackUsed;
    }
    return result;
  },
};

// ────────────────────────────────────────────────────────────
// 9. enrich_candidate
// ────────────────────────────────────────────────────────────
export const enrichCandidate = {
  name: 'enrich_candidate',
  description:
    '① 结构补齐 — 自动填充缺失的结构性语义字段（rationale/knowledgeType/complexity/scope/steps/constraints）。批量处理，只填空不覆盖。建议在 refine_bootstrap_candidates 之前执行。',
  parameters: {
    type: 'object',
    properties: {
      candidateIds: {
        type: 'array',
        items: { type: 'string' },
        description: '候选 ID 列表 (最多 20 个)',
      },
    },
    required: ['candidateIds'],
  },
  handler: async (params, ctx) => {
    if (!ctx.aiProvider) {
      return { error: 'AI provider not available' };
    }
    // V3: 使用 MCP handler enrichCandidates 的逻辑
    const { enrichCandidates: enrichFn } = await import('../../external/mcp/handlers/candidate.js');
    const result = await enrichFn(ctx, { candidateIds: params.candidateIds });
    return result?.data || result;
  },
};

// ────────────────────────────────────────────────────────────
// 9b. refine_bootstrap_candidates (Phase 6)
// ────────────────────────────────────────────────────────────
export const refineBootstrapCandidates = {
  name: 'refine_bootstrap_candidates',
  description:
    '② 内容润色 — 逐条精炼 Bootstrap 候选的内容质量：改善 summary、补充架构 insight、推断 relations 关联、调整 confidence、丰富 tags。建议在 enrich_candidate 之后执行。',
  parameters: {
    type: 'object',
    properties: {
      candidateIds: {
        type: 'array',
        items: { type: 'string' },
        description: '指定候选 ID 列表（可选，默认全部 bootstrap 候选）',
      },
      userPrompt: {
        type: 'string',
        description: '用户自定义润色提示词，指导 AI 润色方向（如"侧重描述线程安全注意事项"）',
      },
      dryRun: { type: 'boolean', description: '仅预览 AI 润色结果，不写入数据库' },
    },
  },
  handler: async (params, ctx) => {
    if (!ctx.aiProvider) {
      return { error: 'AI provider not available' };
    }
    // V3: 委托给 bootstrap handler 的 refine 逻辑
    const { bootstrapRefine } = await import('../../external/mcp/handlers/bootstrap-internal.js');
    const result = await bootstrapRefine(ctx, {
      candidateIds: params.candidateIds,
      userPrompt: params.userPrompt,
      dryRun: params.dryRun,
    });
    return result?.data || result;
  },
};
