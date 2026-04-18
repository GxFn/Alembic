/**
 * MCP Handlers — 候选校验 & 字段诊断 (V3: 使用 knowledgeService)
 * validateCandidate, checkDuplicate, enrichCandidates
 *
 * 注意: submitSingle, submitBatch, submitDrafts 已移至 V3 knowledge handlers
 *       (asd_submit_knowledge / submit_knowledge_batch / knowledge_lifecycle)
 */

import { resolveDataRoot, resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import { envelope } from '../envelope.js';
import type {
  CandidateInput,
  CheckDuplicateArgs,
  EnrichCandidatesArgs,
  EnrichResultEntry,
  McpContext,
  ValidateCandidateArgs,
} from './types.js';

// ─── 校验 & 去重 ───────────────────────────────────────────

export async function validateCandidate(ctx: McpContext, args: ValidateCandidateArgs) {
  // Cast to CandidateInput — Agent input is runtime-dynamic, validation checks shape
  const c = (args.candidate || {}) as CandidateInput;
  const errors: string[] = [];
  const warnings: string[] = [];
  const suggestions: { field: string; value: string }[] = [];

  // Layer 1: 核心必填
  if (!c.title?.trim()) {
    errors.push('缺少 title');
  }
  if (!c.code?.trim() && args.strict) {
    errors.push('strict 模式下需要 code');
  }
  if (!c.language) {
    warnings.push('缺少 language');
  }

  // Layer 2: 分类
  if (!c.category) {
    warnings.push('缺少 category');
  }
  if (!c.knowledgeType) {
    warnings.push('缺少 knowledgeType（code-pattern/architecture/best-practice/...）');
  }
  if (!c.complexity) {
    suggestions.push({ field: 'complexity', value: 'intermediate' });
  }

  // Layer 3: 描述文档
  if (!c.trigger?.trim()) {
    warnings.push('缺少 trigger（建议 @ 开头）');
  }
  if (c.trigger && !c.trigger.startsWith('@')) {
    suggestions.push({ field: 'trigger', value: `@${c.trigger.replace(/^@+/, '')}` });
  }
  if (!c.summary?.trim() && !c.description?.trim()) {
    warnings.push('缺少 summary 或 description');
  }
  if (!c.usageGuide?.trim()) {
    warnings.push('缺少 usageGuide');
  }

  // Layer 4: 结构化内容
  if (!c.rationale) {
    warnings.push('缺少 rationale（设计原理）');
  }
  if (!Array.isArray(c.headers) || c.headers.length === 0) {
    warnings.push('缺少 headers（import 声明）');
  }
  if (!c.steps && !c.codeChanges) {
    suggestions.push({ field: 'steps', value: '[{title, description, code}]' });
  }

  // Layer 5: 约束与关系
  if (!c.constraints) {
    suggestions.push({
      field: 'constraints',
      value: '{boundaries[], preconditions[], sideEffects[], guards[]}',
    });
  }

  // Reasoning 推理依据
  if (!c.reasoning) {
    errors.push('缺少 reasoning（推理依据 — whyStandard + sources + confidence）');
  } else {
    if (!c.reasoning.whyStandard?.trim()) {
      errors.push('reasoning.whyStandard 不能为空');
    }
    if (!Array.isArray(c.reasoning.sources) || c.reasoning.sources.length === 0) {
      errors.push('reasoning.sources 至少包含一项来源');
    }
    if (
      typeof c.reasoning.confidence !== 'number' ||
      c.reasoning.confidence < 0 ||
      c.reasoning.confidence > 1
    ) {
      warnings.push('reasoning.confidence 应为 0-1 的数字');
    }
  }

  const ok = errors.length === 0;
  return envelope({
    success: ok,
    data: { ok, errors, warnings, suggestions },
    meta: { tool: 'asd_validate_candidate' },
  });
}

export async function checkDuplicate(ctx: McpContext, args: CheckDuplicateArgs) {
  // SimilarityService 直接读磁盘 .md 文件，不依赖 Repository
  const { findSimilarRecipes } = await import('#service/candidate/SimilarityService.js');
  const dataRoot = resolveDataRoot(ctx.container as never) || resolveProjectRoot(ctx.container);
  const candidate = (args.candidate ?? {}) as {
    title: string;
    code: string;
    summary?: string;
    [key: string]: unknown;
  };
  const similar = findSimilarRecipes(dataRoot, candidate, {
    threshold: args.threshold ?? 0.7,
    topK: args.topK ?? 5,
  });
  return envelope({
    success: true,
    data: { similar },
    meta: { tool: 'asd_check_duplicate' },
  });
}

// ─── 语义字段缺失诊断（无 AI 依赖） ──────────────────────────

export async function enrichCandidates(ctx: McpContext, args: EnrichCandidatesArgs) {
  const ids = args.candidateIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('candidateIds array is required and must not be empty');
  }
  if (ids.length > 20) {
    throw new Error('Max 20 candidates per enrichment call');
  }

  const knowledgeService = ctx.container.get('knowledgeService');
  if (!knowledgeService) {
    throw new Error('KnowledgeService not available');
  }

  const SEMANTIC_KEYS = [
    'content.rationale',
    'knowledgeType',
    'complexity',
    'scope',
    'content.steps',
    'constraints',
  ];
  const RECIPE_READY_KEYS = [
    {
      key: 'category',
      check: (v: unknown) =>
        typeof v === 'string' &&
        ['View', 'Service', 'Tool', 'Model', 'Network', 'Storage', 'UI', 'Utility'].includes(v),
      hint: 'category 必须为 8 标准值之一',
    },
    {
      key: 'trigger',
      check: (v: unknown) => typeof v === 'string' && v.startsWith('@'),
      hint: 'trigger 必须以 @ 开头',
    },
    { key: 'description', check: (v: unknown) => !!v, hint: '知识条目描述' },
    {
      key: 'headers',
      check: (v: unknown) => Array.isArray(v) && v.length > 0,
      hint: '完整 import 语句数组',
    },
  ];

  const results: EnrichResultEntry[] = [];
  let needsEnrichment = 0;
  let needsRecipeFields = 0;
  for (const id of ids) {
    try {
      const entry = await knowledgeService.get(id);
      if (!entry) {
        results.push({ id, found: false, missingFields: [], recipeReadyMissing: [] });
        continue;
      }
      const json = typeof entry.toJSON === 'function' ? entry.toJSON() : entry;

      // 语义字段检查
      const missing: string[] = [];
      for (const keyPath of SEMANTIC_KEYS) {
        const parts = keyPath.split('.');
        let val = json;
        for (const p of parts) {
          val = val?.[p];
        }
        if (
          val === undefined ||
          val === null ||
          val === '' ||
          (typeof val === 'string' && val.trim() === '') ||
          (Array.isArray(val) && val.length === 0) ||
          (typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length === 0)
        ) {
          missing.push(keyPath);
        }
      }

      // Recipe-Ready 字段检查
      const recipeReadyMissing: { field: string; hint: string }[] = [];
      for (const { key, check, hint } of RECIPE_READY_KEYS) {
        const val = json[key];
        if (!check(val)) {
          recipeReadyMissing.push({ field: key, hint });
        }
      }

      results.push({
        id,
        found: true,
        title: json.title || '',
        language: json.language,
        lifecycle: json.lifecycle,
        kind: json.kind,
        missingFields: missing,
        recipeReadyMissing,
        complete: missing.length === 0 && recipeReadyMissing.length === 0,
      });
      if (missing.length > 0) {
        needsEnrichment++;
      }
      if (recipeReadyMissing.length > 0) {
        needsRecipeFields++;
      }
    } catch (err: unknown) {
      results.push({
        id,
        found: false,
        error: err instanceof Error ? err.message : String(err),
        missingFields: [],
        recipeReadyMissing: [],
      });
    }
  }

  return envelope({
    success: true,
    data: {
      total: ids.length,
      needsEnrichment,
      needsRecipeFields,
      fullyComplete: ids.length - Math.max(needsEnrichment, needsRecipeFields),
      entries: results,
      hint:
        needsEnrichment > 0 || needsRecipeFields > 0
          ? '请 Agent 根据 missingFields（语义）和 recipeReadyMissing（必填）自行补全后重新提交'
          : '所有条目字段完整',
    },
    meta: { tool: 'asd_enrich_candidates' },
  });
}
