import type { EvolutionCandidateReason } from '../../../service/evolution/RecipeImpactPlanner.js';
import type { ToolCallEntry } from '../../runtime/AgentRuntimeTypes.js';
import type { AgentService } from '../../service/AgentService.js';

export interface EvolutionAuditRecipe {
  id: string;
  title: string;
  trigger: string;
  content?: { markdown?: string; rationale?: string; coreCode?: string };
  sourceRefs?: string[];
  auditHint?: {
    relevanceScore: number;
    verdict: string;
    evidence: {
      triggerStillMatches: boolean;
      symbolsAlive: number;
      depsIntact: boolean;
      codeFilesExist: number;
    };
    decayReasons: string[];
  } | null;
  /** diff-based 影响证据（增量 rescan 管线提供） */
  impactEvidence?: {
    reason: EvolutionCandidateReason;
    affectedFiles: string[];
    impactScore: number;
    matchedTokens: string[];
  };
}

export interface EvolutionAuditProjectOverview {
  primaryLang: string;
  fileCount: number;
  modules: string[];
}

export interface EvolutionAuditResult {
  proposed: number;
  deprecated: number;
  skipped: number;
  iterations: number;
  toolCalls: number;
  reply: string;
}

export async function runEvolutionAudit({
  agentService,
  recipes,
  projectOverview,
  dimensionId = 'all',
  dimensionLabel = '全量进化审计',
  proposalSource,
}: {
  agentService: AgentService;
  recipes: EvolutionAuditRecipe[];
  projectOverview: EvolutionAuditProjectOverview;
  dimensionId?: string;
  dimensionLabel?: string;
  /** 传给 evolution-tools 的 source 字段（通过 sharedState 透传） */
  proposalSource?: string;
}): Promise<EvolutionAuditResult> {
  if (recipes.length === 0) {
    return { proposed: 0, deprecated: 0, skipped: 0, toolCalls: 0, iterations: 0, reply: '' };
  }

  const sharedState: Record<string, unknown> = {};
  if (proposalSource) {
    sharedState.evolutionProposalSource = proposalSource;
  }

  const strategyContext = {
    existingRecipes: recipes,
    dimensionId,
    dimensionLabel,
    projectOverview,
    sharedState,
  };
  const result = await agentService.run({
    profile: { id: 'evolution-audit' },
    params: { recipes, projectOverview, dimensionId, dimensionLabel },
    message: {
      role: 'internal',
      content: `请验证 ${recipes.length} 条 Recipe 的源码真实性并提交进化决策。`,
      metadata: { task: 'evolution-audit', dimensionId, dimensionLabel },
    },
    context: {
      source: 'system-workflow',
      runtimeSource: 'system',
      strategyContext,
    },
    presentation: { responseShape: 'system-task-result' },
  });

  const audit = projectEvolutionAuditResult({
    reply: result.reply,
    toolCalls: result.toolCalls,
    iterations: result.usage.iterations,
  });
  const decisionIds = collectEvolutionDecisionIds(
    result.toolCalls,
    recipes.map((r) => r.id)
  );
  if (decisionIds.size < recipes.length) {
    const pending = recipes.map((r) => r.id).filter((id) => !decisionIds.has(id));
    throw new Error(
      `Evolution audit incomplete: decisions ${decisionIds.size}/${recipes.length}; pending=${pending.join(', ')}`
    );
  }
  return audit;
}

export function projectEvolutionAuditResult({
  reply,
  toolCalls,
  iterations,
}: {
  reply: string;
  toolCalls: ToolCallEntry[];
  iterations: number;
}): EvolutionAuditResult {
  return {
    proposed: countProposalOutcomes(toolCalls),
    deprecated: countImmediateDeprecations(toolCalls),
    skipped: countManageOps(toolCalls, 'skip_evolution'),
    iterations,
    toolCalls: toolCalls.length,
    reply: reply || '',
  };
}

/** V2: knowledge.manage(operation: X, id) 统计；V1 compat: 独立工具名 fallback */
function countManageOps(toolCalls: ToolCallEntry[], operation: string) {
  let count = 0;
  for (const tc of toolCalls) {
    if (!isSuccessfulManageCall(tc)) {
      continue;
    }
    const tool = tc.tool || tc.name;
    if (tool === 'knowledge') {
      const action = tc.args?.action as string | undefined;
      const params = (tc.args?.params as Record<string, unknown>) || tc.args || {};
      const id = params.id || params.recipeId;
      if (action === 'manage' && id && params.operation === operation) {
        count++;
      }
    }
    // V1 compat
    const v1Map: Record<string, string> = {
      evolve: 'propose_evolution',
      deprecate: 'confirm_deprecation',
      skip_evolution: 'skip_evolution',
    };
    if (tool === v1Map[operation]) {
      count++;
    }
  }
  return count;
}

function isSuccessfulManageCall(tc: ToolCallEntry) {
  if (tc.envelope?.ok === false) {
    return false;
  }
  const result = tc.result as Record<string, unknown> | null;
  if (result && typeof result === 'object' && typeof result.error === 'string') {
    return false;
  }
  return true;
}

function countProposalOutcomes(toolCalls: ToolCallEntry[]) {
  let count = 0;
  for (const tc of toolCalls) {
    if (!isSuccessfulManageCall(tc) || !isKnowledgeManageCall(tc)) {
      continue;
    }
    const { status, outcome } = readEvolutionToolResult(tc);
    if (outcome) {
      if (outcome === 'proposal-created' || outcome === 'proposal-upgraded') {
        count++;
      }
      continue;
    }
    if (
      status === 'evolution_proposed' ||
      status === 'evolution_proposal_upgraded' ||
      status === 'deprecation_proposed'
    ) {
      count++;
    }
  }
  return count;
}

function countImmediateDeprecations(toolCalls: ToolCallEntry[]) {
  let count = 0;
  for (const tc of toolCalls) {
    if (!isSuccessfulManageCall(tc) || !isKnowledgeManageCall(tc)) {
      continue;
    }
    const { status, outcome } = readEvolutionToolResult(tc);
    if (outcome) {
      if (outcome === 'immediately-executed') {
        count++;
      }
      continue;
    }
    if (status === 'deprecated') {
      count++;
    }
  }
  return count;
}

function isKnowledgeManageCall(tc: ToolCallEntry) {
  const tool = tc.tool || tc.name;
  const args = tc.args || {};
  const params = (args.params as Record<string, unknown>) || args;
  const operation = params.operation as string | undefined;
  return (
    tool === 'knowledge' &&
    args.action === 'manage' &&
    (operation === 'evolve' || operation === 'deprecate' || operation === 'skip_evolution')
  );
}

function readEvolutionToolResult(tc: ToolCallEntry) {
  const result = asRecord(tc.result);
  const data = asRecord(result?.data);
  const source = data || result || {};
  return {
    status: typeof source.status === 'string' ? source.status : '',
    outcome: typeof source.outcome === 'string' ? source.outcome : '',
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function collectEvolutionDecisionIds(
  toolCalls: ToolCallEntry[],
  expectedIds: string[] = []
): Set<string> {
  const ids = new Set<string>();
  const expected = new Set(expectedIds);
  const mark = (id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) {
      return;
    }
    if (expected.size > 0 && !expected.has(id)) {
      return;
    }
    ids.add(id);
  };

  for (const tc of toolCalls) {
    if (!isSuccessfulManageCall(tc)) {
      continue;
    }
    const tool = tc.tool || tc.name;
    const args = tc.args || {};
    if (tool === 'knowledge') {
      const action = args.action as string | undefined;
      const params = (args.params as Record<string, unknown>) || args;
      const operation = params.operation as string | undefined;
      const id = params.id || params.recipeId;
      if (
        action === 'manage' &&
        id &&
        (operation === 'evolve' || operation === 'deprecate' || operation === 'skip_evolution')
      ) {
        mark(id);
      }
      const supersedes = args.supersedes || params.supersedes;
      if ((action === 'submit' || supersedes) && supersedes) {
        mark(supersedes);
      }
    }

    if (tool === 'propose_evolution' && args.recipeId) {
      mark(args.recipeId);
    }
    if (tool === 'confirm_deprecation' && args.recipeId) {
      mark(args.recipeId);
    }
    if (tool === 'skip_evolution' && args.recipeId) {
      mark(args.recipeId);
    }
  }

  return ids;
}
