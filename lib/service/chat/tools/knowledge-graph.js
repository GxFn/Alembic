/**
 * knowledge-graph.js — 知识图谱类工具 (3)
 *
 * 10. check_duplicate     候选查重
 * 11. discover_relations  AI 关系发现
 * 12. add_graph_edge      手动添加图谱边
 */

import { findSimilarRecipes } from '../../candidate/SimilarityService.js';

// ────────────────────────────────────────────────────────────
// 10. check_duplicate
// ────────────────────────────────────────────────────────────
export const checkDuplicate = {
  name: 'check_duplicate',
  description:
    '候选查重 — 检测候选代码是否与已有 Recipe 重复（基于标题/摘要/代码的 Jaccard 相似度）。',
  parameters: {
    type: 'object',
    properties: {
      candidate: { type: 'object', description: '候选对象 { title, summary, code, usageGuide }' },
      candidateId: { type: 'string', description: '或提供候选 ID，从数据库读取' },
      projectRoot: { type: 'string', description: '项目根目录（可选，默认当前项目）' },
      threshold: { type: 'number', description: '相似度阈值，默认 0.5' },
    },
  },
  handler: async (params, ctx) => {
    let cand = params.candidate;
    const projectRoot = params.projectRoot || ctx.projectRoot;
    const threshold = params.threshold ?? 0.5;

    // 如果提供 candidateId，从数据库读取条目信息
    if (!cand && params.candidateId) {
      try {
        const knowledgeService = ctx.container.get('knowledgeService');
        const found = await knowledgeService.get(params.candidateId);
        if (found) {
          const json = typeof found.toJSON === 'function' ? found.toJSON() : found;
          cand = {
            title: json.title || '',
            summary: json.description || '',
            code: json.content?.pattern || '',
            usageGuide: '',
          };
        }
      } catch {
        /* ignore */
      }
    }

    if (!cand) {
      return { similar: [], message: 'No candidate provided' };
    }

    const similar = findSimilarRecipes(projectRoot, cand, {
      threshold,
      topK: 10,
    });

    return {
      similar,
      hasDuplicate: similar.some((s) => s.similarity >= 0.7),
      highestSimilarity: similar.length > 0 ? similar[0].similarity : 0,
      _meta: {
        confidence: similar.length === 0 ? 'none' : similar[0].similarity >= 0.7 ? 'high' : 'low',
        hint:
          similar.length === 0
            ? '未发现相似 Recipe，可放心提交。'
            : similar[0].similarity >= 0.7
              ? '发现高度相似 Recipe，建议人工审核是否重复。'
              : '有低相似度匹配，大概率不是重复。',
      },
    };
  },
};

// ────────────────────────────────────────────────────────────
// 11. discover_relations
// ────────────────────────────────────────────────────────────
export const discoverRelations = {
  name: 'discover_relations',
  description:
    'AI 知识图谱关系发现 — 分析 Recipe 对之间的潜在关系（requires/extends/enforces/calls 等），并自动写入知识图谱。',
  parameters: {
    type: 'object',
    properties: {
      recipePairs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            a: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                category: { type: 'string' },
                code: { type: 'string' },
              },
            },
            b: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                category: { type: 'string' },
                code: { type: 'string' },
              },
            },
          },
        },
        description:
          'Recipe 对数组 [{ a: {id, title, category, code}, b: {id, title, category, code} }]',
      },
      dryRun: { type: 'boolean', description: '仅分析不写入，默认 false' },
    },
    required: ['recipePairs'],
  },
  handler: async (params, ctx) => {
    if (!ctx.aiProvider) {
      return { error: 'AI provider not available' };
    }

    const { recipePairs, dryRun = false } = params;
    if (!recipePairs || recipePairs.length === 0) {
      return { relations: [] };
    }

    // 构建 LLM prompt
    const pairsText = recipePairs
      .map(
        (p, i) => `
--- Pair #${i + 1} ---
Recipe A [${p.a.id}]: ${p.a.title} (${p.a.category}/${p.a.language || ''})
${p.a.code ? `Code: ${p.a.code.substring(0, 300)}` : ''}

Recipe B [${p.b.id}]: ${p.b.title} (${p.b.category}/${p.b.language || ''})
${p.b.code ? `Code: ${p.b.code.substring(0, 300)}` : ''}`
      )
      .join('\n');

    const prompt = `# Role
You are a Software Architect analyzing relationships between code recipes (knowledge units).

# Goal
For each Recipe pair below, determine if there is a meaningful relationship.

# Relationship Types
- requires: A needs B to function
- extends: A builds upon / enriches B
- enforces: A enforces rules defined in B
- depends_on: A depends on B
- inherits: A inherits from B (class/protocol)
- implements: A implements interface/protocol defined in B
- calls: A calls API defined in B
- prerequisite: B must be learned/applied before A
- none: No meaningful relationship

# Output
Return a JSON array. For each pair with a relationship (skip "none"):
{ "index": 0, "from_id": "...", "to_id": "...", "relation": "requires", "confidence": 0.85, "reason": "A uses the network client defined in B" }

Return ONLY a JSON array. No markdown, no extra text. Return [] if no relationships found.

# Recipe Pairs
${pairsText}`;

    const parsed = await ctx.aiProvider.chatWithStructuredOutput(prompt, {
      openChar: '[',
      closeChar: ']',
      temperature: 0.2,
    });
    const relations = Array.isArray(parsed) ? parsed : [];

    // 写入知识图谱（除非 dryRun）
    if (!dryRun && relations.length > 0) {
      try {
        const kgService = ctx.container.get('knowledgeGraphService');
        for (const rel of relations) {
          if (rel.from_id && rel.to_id && rel.relation && rel.relation !== 'none') {
            kgService.addEdge(rel.from_id, 'recipe', rel.to_id, 'recipe', rel.relation, {
              confidence: rel.confidence || 0.5,
              reason: rel.reason || '',
              source: 'ai-discovery',
            });
          }
        }
      } catch {
        /* KG not available */
      }
    }

    return {
      analyzed: recipePairs.length,
      relations: relations.filter((r) => r.relation !== 'none'),
      written: dryRun ? 0 : relations.filter((r) => r.relation !== 'none').length,
    };
  },
};

// ────────────────────────────────────────────────────────────
// 12. add_graph_edge
// ────────────────────────────────────────────────────────────
export const addGraphEdge = {
  name: 'add_graph_edge',
  description: '手动添加知识图谱关系边（从 A 到 B 的关系）。',
  parameters: {
    type: 'object',
    properties: {
      fromId: { type: 'string', description: '源节点 ID' },
      fromType: { type: 'string', description: '源节点类型 (recipe/candidate)' },
      toId: { type: 'string', description: '目标节点 ID' },
      toType: { type: 'string', description: '目标节点类型 (recipe/candidate)' },
      relation: {
        type: 'string',
        description:
          '关系类型 (requires/extends/enforces/depends_on/inherits/implements/calls/prerequisite)',
      },
      weight: { type: 'number', description: '权重 0-1，默认 1.0' },
    },
    required: ['fromId', 'fromType', 'toId', 'toType', 'relation'],
  },
  handler: async (params, ctx) => {
    const kgService = ctx.container.get('knowledgeGraphService');
    return kgService.addEdge(
      params.fromId,
      params.fromType,
      params.toId,
      params.toType,
      params.relation,
      { weight: params.weight || 1.0, source: 'manual' }
    );
  },
};
