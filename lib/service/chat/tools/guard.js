/**
 * guard.js — Guard 安全类工具 (6)
 *
 * 7b. list_guard_rules    列出 Guard 规则
 * 8b. get_recommendations 获取推荐 Recipe
 * 12. ai_translate        AI 翻译
 * 13. guard_check_code    Guard 检查代码
 * 14. query_violations    查询违规历史
 * 15. generate_guard_rule AI 生成 Guard 规则
 */

// ────────────────────────────────────────────────────────────
// 7b. list_guard_rules
// ────────────────────────────────────────────────────────────
export const listGuardRules = {
  name: 'list_guard_rules',
  description: '列出所有 Guard 规则（boundary-constraint 类型的 Recipe）。支持按语言/状态过滤。',
  parameters: {
    type: 'object',
    properties: {
      language: { type: 'string', description: '按语言过滤 (swift/objc 等)' },
      includeBuiltIn: { type: 'boolean', description: '是否包含内置规则，默认 true' },
      limit: { type: 'number', description: '返回数量上限，默认 50' },
    },
  },
  handler: async (params, ctx) => {
    const { language, includeBuiltIn = true, limit = 50 } = params;
    const results = [];

    // 数据库自定义规则
    try {
      const guardService = ctx.container.get('guardService');
      const dbRules = await guardService.listRules({}, { page: 1, pageSize: limit });
      results.push(...(dbRules.data || dbRules.items || []));
    } catch {
      /* not available */
    }

    // 内置规则
    if (includeBuiltIn) {
      try {
        const guardCheckEngine = ctx.container.get('guardCheckEngine');
        const builtIn = guardCheckEngine
          .getRules(language || null)
          .filter((r) => r.source === 'built-in');
        results.push(...builtIn);
      } catch {
        /* not available */
      }
    }

    return { total: results.length, rules: results.slice(0, limit) };
  },
};

// ────────────────────────────────────────────────────────────
// 8b. get_recommendations
// ────────────────────────────────────────────────────────────
export const getRecommendations = {
  name: 'get_recommendations',
  description: '获取推荐的 Recipe 列表（基于使用频率和质量排序）。',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: '返回数量，默认 10' },
    },
  },
  handler: async (params, ctx) => {
    const knowledgeService = ctx.container.get('knowledgeService');
    // V3: 推荐 = 活跃条目按使用量排序
    return knowledgeService.list(
      { lifecycle: 'active' },
      { page: 1, pageSize: params.limit || 10 }
    );
  },
};

// ────────────────────────────────────────────────────────────
// 12. ai_translate
// ────────────────────────────────────────────────────────────
export const aiTranslate = {
  name: 'ai_translate',
  description: 'AI 翻译 — 将中文 summary/usageGuide 翻译为英文。',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '中文摘要' },
      usageGuide: { type: 'string', description: '中文使用指南' },
    },
  },
  handler: async (params, ctx) => {
    if (!ctx.aiProvider) {
      return { error: 'AI provider not available' };
    }
    const { summary, usageGuide } = params;
    if (!summary && !usageGuide) {
      return { summaryEn: '', usageGuideEn: '' };
    }

    const systemPrompt =
      'You are a technical translator. Translate from Chinese to English. Keep technical terms unchanged. Return ONLY valid JSON: { "summaryEn": "...", "usageGuideEn": "..." }.';
    const parts = [];
    if (summary) {
      parts.push(`summary: ${summary}`);
    }
    if (usageGuide) {
      parts.push(`usageGuide: ${usageGuide}`);
    }

    const parsed = await ctx.aiProvider.chatWithStructuredOutput(parts.join('\n'), {
      systemPrompt,
      temperature: 0.2,
    });
    return parsed || { summaryEn: summary || '', usageGuideEn: usageGuide || '' };
  },
};

// ────────────────────────────────────────────────────────────
// 13. guard_check_code
// ────────────────────────────────────────────────────────────
export const guardCheckCode = {
  name: 'guard_check_code',
  description: '对代码运行 Guard 规则检查，返回违规列表（支持内置规则 + 数据库自定义规则）。',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '待检查的源代码' },
      language: { type: 'string', description: '编程语言 (swift/objc/javascript 等)' },
      scope: { type: 'string', description: '检查范围 (file/target/project)，默认 file' },
    },
    required: ['code'],
  },
  handler: async (params, ctx) => {
    const { code, language, scope = 'file' } = params;

    // 优先用 GuardCheckEngine（内置 + DB 规则）
    try {
      const engine = ctx.container.get('guardCheckEngine');
      const violations = engine.checkCode(code, language || 'unknown', { scope });
      // reasoning 已由 GuardCheckEngine.checkCode() 内置附加
      return { violationCount: violations.length, violations };
    } catch {
      /* not available */
    }

    // 降级到 GuardService.checkCode（仅 DB 规则）
    try {
      const guardService = ctx.container.get('guardService');
      const matches = await guardService.checkCode(code, { language });
      return { violationCount: matches.length, violations: matches };
    } catch (err) {
      return { error: err.message };
    }
  },
};

// ────────────────────────────────────────────────────────────
// 14. query_violations
// ────────────────────────────────────────────────────────────
export const queryViolations = {
  name: 'query_violations',
  description: '查询 Guard 违规历史记录和统计。',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '按文件路径过滤' },
      limit: { type: 'number', description: '返回数量，默认 20' },
      statsOnly: { type: 'boolean', description: '仅返回统计数据，默认 false' },
    },
  },
  handler: async (params, ctx) => {
    const { file, limit = 20, statsOnly = false } = params;
    const store = ctx.container.get('violationsStore');

    if (statsOnly) {
      return store.getStats();
    }

    if (file) {
      return { runs: store.getRunsByFile(file) };
    }

    return store.list({}, { page: 1, limit });
  },
};

// ────────────────────────────────────────────────────────────
// 15. generate_guard_rule
// ────────────────────────────────────────────────────────────
export const generateGuardRule = {
  name: 'generate_guard_rule',
  description: 'AI 生成 Guard 规则 — 描述你想阻止的代码模式，AI 自动生成正则表达式和规则定义。',
  parameters: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: '规则描述（例如 "禁止在主线程使用同步网络请求"）',
      },
      language: { type: 'string', description: '目标语言 (swift/objc 等)' },
      severity: { type: 'string', description: '严重程度 (error/warning/info)，默认 warning' },
      autoCreate: { type: 'boolean', description: '是否自动创建到数据库，默认 false' },
    },
    required: ['description'],
  },
  handler: async (params, ctx) => {
    if (!ctx.aiProvider) {
      return { error: 'AI provider not available' };
    }
    const { description, language = 'swift', severity = 'warning', autoCreate = false } = params;

    const prompt = `Generate a Guard rule for this requirement:
Description: ${description}
Language: ${language}
Severity: ${severity}

Return ONLY valid JSON:
{
  "name": "rule-name-kebab-case",
  "description": "One-line description in English",
  "description_cn": "一行中文描述",
  "pattern": "regex pattern for matching the problematic code",
  "languages": ["${language}"],
  "severity": "${severity}",
  "testCases": {
    "shouldMatch": ["code example that should trigger"],
    "shouldNotMatch": ["code example that should NOT trigger"]
  }
}`;

    const rule = await ctx.aiProvider.chatWithStructuredOutput(prompt, { temperature: 0.2 });
    if (!rule) {
      return { error: 'Failed to parse AI response' };
    }

    // 验证正则表达式
    try {
      new RegExp(rule.pattern);
    } catch (e) {
      return { error: `Invalid regex pattern: ${e.message}`, rule };
    }

    // 自动创建
    if (autoCreate && rule.name && rule.pattern) {
      try {
        const guardService = ctx.container.get('guardService');
        const created = await guardService.createRule(
          {
            name: rule.name,
            description: rule.description || description,
            pattern: rule.pattern,
            languages: rule.languages || [language],
            severity: rule.severity || severity,
          },
          { userId: 'agent' }
        );
        return { rule, created: true, recipeId: created.id };
      } catch (err) {
        return { rule, created: false, error: err.message };
      }
    }

    return { rule, created: false };
  },
};
