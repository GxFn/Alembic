/**
 * ai-analysis.js — AI 分析类工具 (2)
 *
 * 9. enrich_candidate            结构补齐
 * 9b. refine_bootstrap_candidates 内容润色
 *
 * 注意: summarize_code / extract_recipes 已删除。
 * 代码摘要和 Recipe 提取由 Agent LLM 直接推理完成，不再需要专用工具。
 */

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
  handler: async (params: any, ctx: any) => {
    if (!ctx.aiProvider) {
      return { error: 'AI provider not available' };
    }
    // V3: 使用 MCP handler enrichCandidates 的逻辑
    const { enrichCandidates: enrichFn } = await import(
      '../../../external/mcp/handlers/candidate.js'
    );
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
  handler: async (params: any, ctx: any) => {
    if (!ctx.aiProvider) {
      return { error: 'AI provider not available' };
    }
    // V3: 委托给 bootstrap handler 的 refine 逻辑
    const { bootstrapRefine } = await import(
      '../../../external/mcp/handlers/bootstrap-internal.js'
    );
    const result = await bootstrapRefine(ctx, {
      candidateIds: params.candidateIds,
      userPrompt: params.userPrompt,
      dryRun: params.dryRun,
    });
    return result?.data || result;
  },
};
