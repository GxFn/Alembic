/**
 * MCP Handlers — 候选校验 & 字段诊断 (V3: 使用 knowledgeService)
 * validateCandidate, checkDuplicate
 *
 * 注意: submitSingle, submitBatch, submitDrafts 已移至 V3 knowledge handlers
 *       (alembic_submit_knowledge / submit_knowledge_batch / knowledge_lifecycle)
 */

import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import { envelope } from '../tool-schema/envelope.js';
import type {
  CandidateInput,
  CheckDuplicateArgs,
  McpContext,
  ValidateCandidateArgs,
} from '../tool-schema/types.js';

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
    meta: { tool: 'alembic_validate_candidate' },
  });
}

export async function checkDuplicate(ctx: McpContext, args: CheckDuplicateArgs) {
  // SimilarityService 直接读磁盘 .md 文件，不依赖 Repository
  const { findSimilarRecipes } = await import('@alembic/core/service/candidate');
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
    meta: { tool: 'alembic_check_duplicate' },
  });
}

// enrichCandidates (alembic_enrich_candidates) was deleted in the Train B DCR
// wave: P0 all-delete verdict, zero external consumers (route-negative +
// tool-registry negative proofs in the Train B evidence).
