/**
 * AgentTaskHandlers — predefined task flows for /api/v1/ai/agent/task.
 *
 * These handlers are not chat runtime logic. They orchestrate direct ToolRouter
 * calls and, for relation discovery, delegate to AgentService.run().
 */

import type { ToolResultEnvelope } from '#tools/core/ToolResultEnvelope.js';
import { type AgentService, runRelationDiscovery } from '../service/index.js';

interface TaskAiProvider {
  chat(prompt: string, opts?: Record<string, unknown>): Promise<string>;
  chatWithStructuredOutput(prompt: string, opts?: Record<string, unknown>): Promise<unknown>;
}

interface TaskContext {
  invokeToolEnvelope(
    toolName: string,
    params: Record<string, unknown>
  ): Promise<ToolResultEnvelope>;
  aiProvider?: TaskAiProvider;
  container: { get(name: string): unknown };
  logger?: unknown;
}

interface CandidateInput {
  title?: string;
  code?: string;
  [key: string]: unknown;
}

interface DuplicateEntry {
  title?: string;
  similarity: number;
  [key: string]: unknown;
}

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

interface KnowledgeServiceLike {
  list(
    filter: Record<string, unknown>,
    pagination: { page: number; pageSize: number }
  ): Promise<{ items?: KnowledgeItem[]; data?: KnowledgeItem[] }>;
}

interface GuardViolation {
  severity?: string;
  message?: string;
  ruleName?: string;
  line?: number;
  matches?: Array<{ line?: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

export async function taskCheckAndSubmit(
  context: TaskContext,
  { candidate, projectRoot }: { candidate: CandidateInput; projectRoot?: string }
) {
  const { aiProvider } = context;

  const duplicates = await invokeTaskTool<{ similar?: DuplicateEntry[] }>(
    context,
    'check_duplicate',
    {
      candidate,
      projectRoot,
      threshold: 0.5,
    }
  );

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
      /* optional AI verdict */
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

export async function taskDiscoverAllRelations(context: TaskContext, { batchSize = 20 } = {}) {
  const { container } = context;
  const agentService = container.get('agentService') as AgentService;

  const aiManager = (container as unknown as { singletons?: Record<string, unknown> }).singletons
    ?._aiProviderManager as { isMock?: boolean } | undefined;
  if (aiManager?.isMock) {
    return { discovered: 0, message: 'AI Provider 未配置（Mock 模式），跳过关系发现。' };
  }

  return runRelationDiscovery({ agentService, batchSize });
}

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

  const needEnrich = candidates.filter((candidate: KnowledgeItem) => {
    const metadata = candidate.metadata || {};
    return !metadata.rationale || !metadata.knowledgeType || !metadata.complexity;
  });

  if (needEnrich.length === 0) {
    return { enriched: 0, message: 'All candidates already enriched' };
  }

  return invokeTaskTool(context, 'enrich_candidate', {
    candidateIds: needEnrich.map((candidate: KnowledgeItem) => candidate.id).slice(0, 20),
  });
}

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

export async function taskGuardFullScan(
  context: TaskContext,
  { code, language, filePath }: { code?: string; language?: string; filePath?: string } = {}
) {
  const { aiProvider } = context;
  if (!code) {
    return { error: 'code is required' };
  }

  const checkResult = await invokeTaskTool<{
    violationCount: number;
    violations?: GuardViolation[];
  }>(context, 'guard_check_code', {
    code,
    language: language || 'unknown',
    scope: 'project',
  });

  let suggestions: unknown = null;
  if (checkResult.violationCount > 0 && aiProvider) {
    try {
      const violationSummary = (checkResult.violations || [])
        .slice(0, 5)
        .map(
          (violation: GuardViolation) =>
            `- [${violation.severity}] ${violation.message || violation.ruleName} (line ${violation.line || violation.matches?.[0]?.line || '?'})`
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
      /* AI suggestions are optional */
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
