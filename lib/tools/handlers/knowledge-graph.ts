/**
 * knowledge-graph.js — 知识图谱类工具 (2)
 *
 * 10. check_duplicate     候选查重
 * 12. add_graph_edge      手动添加图谱边
 *
 * 注意: discover_relations 已删除。
 * 关系发现由 Agent LLM 直接推理完成，利用通用工具（search_knowledge, query_code_graph 等）。
 */

import { findSimilarRecipes } from '#service/candidate/SimilarityService.js';
import {
  requireKnowledgeGraphMutationService,
  requireKnowledgeService,
  resolveKnowledgeServicesFromContext,
} from '#tools/core/ToolKnowledgeServices.js';
import type { ToolHandlerContext } from './_shared.js';

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
  handler: async (params: Record<string, unknown>, ctx: ToolHandlerContext) => {
    let cand = params.candidate as
      | {
          title: string;
          summary?: string;
          description?: string;
          code: string;
          [key: string]: unknown;
        }
      | undefined;
    const dataRoot = (params.projectRoot as string) || ctx.dataRoot || ctx.projectRoot;
    const threshold = (params.threshold as number) ?? 0.5;

    // 如果提供 candidateId，从数据库读取条目信息
    if (!cand && params.candidateId) {
      try {
        const knowledgeService = requireKnowledgeService(resolveKnowledgeServicesFromContext(ctx));
        const found = await knowledgeService.get(params.candidateId as string);
        if (found) {
          const json = hasToJSON(found) ? found.toJSON() : toRecord(found);
          cand = {
            title: typeof json.title === 'string' ? json.title : '',
            summary: typeof json.description === 'string' ? json.description : '',
            code: extractPattern(json.content),
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

    const similar = findSimilarRecipes(dataRoot, cand, {
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
  handler: async (params: Record<string, unknown>, ctx: ToolHandlerContext) => {
    const kgService = requireKnowledgeGraphMutationService(
      resolveKnowledgeServicesFromContext(ctx)
    );
    return kgService.addEdge(
      params.fromId as string,
      params.fromType as string,
      params.toId as string,
      params.toType as string,
      params.relation as string,
      { weight: (params.weight as number) || 1.0, source: 'manual' }
    );
  },
};

function hasToJSON(value: unknown): value is { toJSON(): Record<string, unknown> } {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  );
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function extractPattern(content: unknown): string {
  if (!content || typeof content !== 'object') {
    return '';
  }
  const pattern = (content as { pattern?: unknown }).pattern;
  return typeof pattern === 'string' ? pattern : '';
}
