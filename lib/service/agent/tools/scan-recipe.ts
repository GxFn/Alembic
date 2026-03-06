/**
 * scan-recipe.js — 扫描专用 Recipe 收集工具
 *
 * 与冷启动 submit_knowledge 使用完全相同的字段 schema，
 * 但不入库 — 仅做本地验证 + 内存收集。
 *
 * 扫描 Produce 阶段 LLM 调用此工具逐个提交 Recipe，
 * 执行完成后由 AgentFactory.scanKnowledge() 从 toolCalls 中提取。
 *
 * 设计原因:
 *   - 冷启动 Producer 通过 submit_knowledge 工具逐个提交候选（工具驱动）
 *   - 扫描 Produce 之前是纯 JSON 文本输出，LLM 容易 hallucinate 错误工具调用
 *   - 统一为工具驱动模式：相同 schema → 相同字段质量 → 相同下游消费
 *
 * @module scan-recipe
 */

// ── collect_scan_recipe ──────────────────────────────────────

export const collectScanRecipe = {
  name: 'collect_scan_recipe',
  description:
    '提交一条扫描发现的知识候选（Recipe）。每个独立的代码模式/设计模式/最佳实践应单独调用此工具提交。\n' +
    '所有必填字段必须在单次调用中一次性提供。\n' +
    '⚠️ content 必须是对象: { "pattern": "代码片段", "markdown": "项目特写正文≥200字", "rationale": "设计原理" }\n' +
    '⚠️ reasoning 必须是对象: { "whyStandard": "原因", "sources": ["file.ts"], "confidence": 0.85 }',
  parameters: {
    type: 'object',
    properties: {
      // ── 基本信息 ──
      title: { type: 'string', description: '中文标题（≤20字，使用项目真实类名）' },
      language: { type: 'string', description: '编程语言（小写）' },
      description: { type: 'string', description: '中文简述 ≤80 字，引用真实类名' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },

      // ── 内容（V3 content 子对象） ──
      content: {
        type: 'object',
        description:
          '{ markdown: "项目特写 Markdown(≥200字)", pattern: "核心代码 3-8 行", rationale: "设计原理(必填)" }',
        properties: {
          pattern: { type: 'string', description: '核心代码片段' },
          markdown: { type: 'string', description: 'Markdown 正文（≥200字符）' },
          rationale: { type: 'string', description: '设计原理说明（必填）' },
        },
        required: ['rationale'],
      },

      // ── Cursor 交付（必填）──
      kind: {
        type: 'string',
        enum: ['rule', 'pattern', 'fact'],
        description: 'rule=规则 | pattern=模板 | fact=参考',
      },
      category: {
        type: 'string',
        description: '分类: View / Service / Tool / Model / Network / Storage / UI / Utility',
      },
      trigger: { type: 'string', description: '触发关键词（@前缀，kebab-case）' },
      doClause: { type: 'string', description: '正向指令（英文祈使句 ≤60 tokens）' },
      dontClause: { type: 'string', description: '反向约束（描述禁止的做法）' },
      whenClause: { type: 'string', description: '触发场景（描述何时适用）' },
      coreCode: { type: 'string', description: '精华代码骨架（3-8行，语法完整）' },

      // ── 结构化字段 ──
      headers: {
        type: 'array',
        items: { type: 'string' },
        description: '完整 import/include 语句数组',
      },
      usageGuide: { type: 'string', description: '使用指南（何时/如何使用）' },
      knowledgeType: {
        type: 'string',
        description:
          'code-pattern / architecture / best-practice / code-standard / data-flow / solution 等',
      },

      // ── 推理 ──
      reasoning: {
        type: 'object',
        description: '{ whyStandard: "原因", sources: ["file.ts"], confidence: 0.85 }',
        properties: {
          whyStandard: { type: 'string', description: '为什么这是标准做法（必填）' },
          sources: {
            type: 'array',
            items: { type: 'string' },
            description: '参考的文件路径数组（必填）',
          },
          confidence: { type: 'number', description: '置信度 0.0-1.0' },
        },
        required: ['whyStandard', 'sources'],
      },

      // ── 可选 ──
      complexity: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
      scope: { type: 'string', enum: ['universal', 'project-specific', 'target-specific'] },
    },
    required: [
      'title',
      'language',
      'content',
      'kind',
      'doClause',
      'dontClause',
      'whenClause',
      'coreCode',
      'category',
      'trigger',
      'description',
      'headers',
      'usageGuide',
      'knowledgeType',
      'reasoning',
    ],
  },

  /**
   * Handler — 本地验证 + 内存收集（不入库）
   *
   * 验证通过后返回 { status: 'collected', recipe: {...} }，
   * AgentFactory.scanKnowledge() 从 toolCalls 结果中提取 recipes。
   */
  handler: async (params, _ctx) => {
    // ── 基本验证 ──
    const errors = [];

    if (!params.title || params.title.trim().length === 0) {
      errors.push('title 不能为空');
    }
    if (!params.content || typeof params.content !== 'object') {
      errors.push('content 必须是对象');
    } else if (!params.content.rationale) {
      errors.push('content.rationale (设计原理) 是必填字段');
    }
    if (!params.reasoning || typeof params.reasoning !== 'object') {
      errors.push('reasoning 必须是对象');
    } else {
      if (!params.reasoning.whyStandard) {
        errors.push('reasoning.whyStandard 是必填字段');
      }
      if (!Array.isArray(params.reasoning.sources) || params.reasoning.sources.length === 0) {
        errors.push('reasoning.sources 必须是非空数组');
      }
    }
    if (!params.kind || !['rule', 'pattern', 'fact'].includes(params.kind)) {
      errors.push('kind 必须是 rule / pattern / fact 之一');
    }
    if (!params.trigger || !params.trigger.startsWith('@')) {
      errors.push('trigger 必须以 @ 开头');
    }
    if (!params.coreCode || params.coreCode.trim().length < 10) {
      errors.push('coreCode 必须提供有意义的代码骨架（≥10字符）');
    }
    if (!params.doClause) {
      errors.push('doClause (正向指令) 是必填字段');
    }

    if (errors.length > 0) {
      return {
        status: 'rejected',
        error: errors.join('\n'),
        hint: '请根据错误信息调整内容后重新提交。',
      };
    }

    // ── 构建标准化 Recipe 对象 ──
    const contentObj = params.content || {};
    const reasoning = params.reasoning || {};

    const recipe = {
      title: params.title.trim(),
      language: params.language || '',
      description: params.description || '',
      tags: params.tags || [],
      content: {
        pattern: contentObj.pattern || '',
        markdown: contentObj.markdown || '',
        rationale: contentObj.rationale || '',
      },
      kind: params.kind,
      category: params.category || 'Utility',
      trigger: params.trigger,
      doClause: params.doClause || '',
      dontClause: params.dontClause || '',
      whenClause: params.whenClause || '',
      coreCode: params.coreCode || '',
      headers: params.headers || [],
      usageGuide: params.usageGuide || '',
      knowledgeType: params.knowledgeType || 'code-pattern',
      reasoning: {
        whyStandard: reasoning.whyStandard || '',
        sources: reasoning.sources || [],
        confidence: reasoning.confidence ?? 0.8,
      },
      complexity: params.complexity || 'intermediate',
      scope: params.scope || 'project-specific',
    };

    return {
      status: 'collected',
      title: recipe.title,
      recipe,
    };
  },
};

export default collectScanRecipe;
