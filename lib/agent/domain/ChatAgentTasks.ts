/**
 * ChatAgentTasks — Agent 预定义任务方法
 *
 * 每个任务接收 context 对象: { invokeToolEnvelope, aiProvider, container, logger }
 * - invokeToolEnvelope(toolName, params) — 通过 ToolRouter 执行并返回标准 envelope
 * - aiProvider — AI Provider 实例
 * - container — ServiceContainer
 * - logger — Logger 实例
 */

import type { ToolResultEnvelope } from '../core/ToolResultEnvelope.js';
import { type AgentService, runRelationDiscovery } from '../service/index.js';

// ── Local Type Definitions ──

/** AI provider interface subset used by task functions */
interface TaskAiProvider {
  chat(prompt: string, opts?: Record<string, unknown>): Promise<string>;
  chatWithStructuredOutput(prompt: string, opts?: Record<string, unknown>): Promise<unknown>;
}

/** Task execution context provided by the ChatAgent framework */
interface TaskContext {
  invokeToolEnvelope(
    toolName: string,
    params: Record<string, unknown>
  ): Promise<ToolResultEnvelope>;
  aiProvider?: TaskAiProvider;
  container: { get(name: string): unknown };
  logger?: unknown;
}

/** Candidate input shape for check-and-submit */
interface CandidateInput {
  title?: string;
  code?: string;
  [key: string]: unknown;
}

/** Duplicate search result entry */
interface DuplicateEntry {
  title?: string;
  similarity: number;
  [key: string]: unknown;
}

/** Knowledge item from knowledge service list() */
interface KnowledgeItem {
  id: string;
  title?: string;
  metadata?: {
    rationale?: string;
    knowledgeType?: string;
    complexity?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Knowledge service interface for list operations */
interface KnowledgeServiceLike {
  list(
    filter: Record<string, unknown>,
    pagination: { page: number; pageSize: number }
  ): Promise<{ items?: KnowledgeItem[]; data?: KnowledgeItem[] }>;
}

/** Guard violation entry */
interface GuardViolation {
  severity?: string;
  message?: string;
  ruleName?: string;
  line?: number;
  matches?: Array<{ line?: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

/**
 * 任务: 提交前查重 + 质量预评
 * 1. check_duplicate → 若发现相似 ≥ 0.7 则建议合并
 * 2. 顺便返回质量评估建议
 */
export async function taskCheckAndSubmit(
  context: TaskContext,
  { candidate, projectRoot }: { candidate: CandidateInput; projectRoot?: string }
) {
  const { aiProvider } = context;

  // Step 1: 查重
  const duplicates = await invokeTaskTool<{ similar?: DuplicateEntry[] }>(
    context,
    'check_duplicate',
    {
      candidate,
      projectRoot,
      threshold: 0.5,
    }
  );

  // Step 2: 如果有高相似度，使用 AI 分析是否真正重复
  const highSim = (duplicates.similar || []).filter((d: DuplicateEntry) => d.similarity >= 0.7);
  let aiVerdict: string | null = null;
  if (highSim.length > 0 && aiProvider) {
    const verdictPrompt = `以下新候选代码与已有 Recipe 高度相似，请判断是否真正重复。

新候选:
- Title: ${candidate.title || '(未命名)'}
- Code: ${(candidate.code || '').substring(0, 1000)}

相似 Recipe:
${highSim.map((s: DuplicateEntry) => `- ${s.title} (相似度: ${s.similarity})`).join('\n')}

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
 * 委托给 AgentService.run(relation-discovery) (独立 Explore → Synthesize 管线)
 */
export async function taskDiscoverAllRelations(context: TaskContext, { batchSize = 20 } = {}) {
  const { container } = context;
  const agentService = container.get('agentService') as AgentService;

  // Mock 模式下跳过 AI 关系发现
  const aiManager = (container as unknown as { singletons?: Record<string, unknown> }).singletons
    ?._aiProviderManager as { isMock?: boolean } | undefined;
  if (aiManager?.isMock) {
    return { discovered: 0, message: 'AI Provider 未配置（Mock 模式），跳过关系发现。' };
  }

  return runRelationDiscovery({ agentService, batchSize });
}

/** 任务: 批量 AI 补全候选语义字段 */
export async function taskFullEnrich(
  context: TaskContext,
  { status = 'pending', maxCount = 50 } = {}
) {
  const { container } = context;

  const knowledgeService = container.get('knowledgeService') as KnowledgeServiceLike;

  const { items = [], data = [] } = await knowledgeService.list(
    { lifecycle: status },
    { page: 1, pageSize: maxCount }
  );
  const candidates = items.length > 0 ? items : data;
  if (candidates.length === 0) {
    return { enriched: 0, message: 'No candidates to enrich' };
  }

  // 筛选缺失语义字段的候选
  const needEnrich = candidates.filter((c: KnowledgeItem) => {
    const m = c.metadata || {};
    return !m.rationale || !m.knowledgeType || !m.complexity;
  });

  if (needEnrich.length === 0) {
    return { enriched: 0, message: 'All candidates already enriched' };
  }

  const result = await invokeTaskTool(context, 'enrich_candidate', {
    candidateIds: needEnrich.map((c: KnowledgeItem) => c.id).slice(0, 20),
  });

  return result;
}

/**
 * 任务: 批量质量审计全部 Recipe
 * 对活跃 Recipe 逐个评分，返回低于阈值的列表
 */
export async function taskQualityAudit(
  context: TaskContext,
  { threshold = 0.6, maxCount = 100 } = {}
) {
  const { container } = context;

  const knowledgeService = container.get('knowledgeService') as KnowledgeServiceLike;

  const { items = [], data = [] } = await knowledgeService.list(
    { lifecycle: 'active' },
    { page: 1, pageSize: maxCount }
  );
  const recipes = items.length > 0 ? items : data;
  if (recipes.length === 0) {
    return { total: 0, lowQuality: [], message: 'No active recipes' };
  }

  const lowQuality: {
    id: string;
    title: string | undefined;
    score: number;
    grade: string;
    dimensions: unknown;
  }[] = [];
  const gradeDistribution = { A: 0, B: 0, C: 0, D: 0, F: 0 };

  for (const recipe of recipes) {
    const scoreResult = await invokeTaskTool<{
      score: number;
      grade: string;
      dimensions: unknown;
    }>(context, 'quality_score', { recipe });
    if (scoreResult.grade) {
      (gradeDistribution as Record<string, number>)[scoreResult.grade] =
        ((gradeDistribution as Record<string, number>)[scoreResult.grade] || 0) + 1;
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
export async function taskGuardFullScan(
  context: TaskContext,
  { code, language, filePath }: { code?: string; language?: string; filePath?: string } = {}
) {
  const { aiProvider } = context;

  if (!code) {
    return { error: 'code is required' };
  }

  // Step 1: 静态检查
  const checkResult = await invokeTaskTool<{
    violationCount: number;
    violations?: GuardViolation[];
  }>(context, 'guard_check_code', {
    code,
    language: language || 'unknown',
    scope: 'project',
  });

  // Step 2: 如果有违规且 AI 可用，生成修复建议
  let suggestions: unknown = null;
  if (checkResult.violationCount > 0 && aiProvider) {
    try {
      const violationSummary = (checkResult.violations || [])
        .slice(0, 5)
        .map(
          (v: GuardViolation) =>
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

async function invokeTaskTool<T = Record<string, unknown>>(
  context: TaskContext,
  toolName: string,
  params: Record<string, unknown>
): Promise<T> {
  return projectTaskToolEnvelope(await context.invokeToolEnvelope(toolName, params)) as T;
}

function projectTaskToolEnvelope(envelope: ToolResultEnvelope): unknown {
  if (envelope.structuredContent !== undefined) {
    return envelope.structuredContent;
  }
  return envelope.ok ? { success: true, message: envelope.text } : { error: envelope.text };
}
