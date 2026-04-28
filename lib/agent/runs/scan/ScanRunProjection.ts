import type { AgentDiagnostics, ToolCallEntry } from '../../runtime/AgentRuntimeTypes.js';
import type { AgentRunResult } from '../../service/AgentRunContracts.js';

export interface ScanRecipe extends Record<string, unknown> {
  title?: string;
  description?: string;
  summary?: string;
  usageGuide?: string;
  category?: string;
  headers?: string[];
  tags?: string[];
  trigger?: string;
}

export interface ScanProjectionOptions {
  label?: string;
  task: 'extract' | 'summarize';
  result: AgentRunResult;
  fallback: (label: string) => Record<string, unknown>;
  onParseError?: (err: unknown) => void;
}

export interface ScanKnowledgeProjection extends Record<string, unknown> {
  error?: string;
}

interface ParseJsonWithDiagnosticsResult {
  value: Record<string, unknown>;
  usedFallback: boolean;
  error?: string;
}

interface PhaseSummary {
  reply?: string;
  toolCalls?: ToolCallEntry[];
}

export function projectScanRunResult({
  label,
  task,
  result,
  fallback,
  onParseError,
}: ScanProjectionOptions): ScanKnowledgeProjection {
  const recipes = extractCollectedRecipes(result.toolCalls || []);
  if (recipes.length > 0) {
    const diagnostics = buildScanDiagnostics({ label, task, result, recipesFound: recipes.length });
    if (task === 'summarize') {
      const first = recipes[0];
      return {
        title: first.title || '',
        summary: first.description || first.summary || '',
        usageGuide: first.usageGuide || '',
        category: first.category || '',
        headers: first.headers || [],
        tags: first.tags || [],
        trigger: first.trigger || '',
        recipes,
        extracted: recipes.length,
        diagnostics,
      };
    }
    return { targetName: label, extracted: recipes.length, recipes, diagnostics };
  }

  const phases = result.phases as Record<string, PhaseSummary> | undefined;
  const produceReply = phases?.produce?.reply || result.reply;
  const parsed = parseJsonResponseWithDiagnostics(
    produceReply,
    fallback(label || ''),
    onParseError
  );
  return {
    ...parsed.value,
    diagnostics: buildScanDiagnostics({
      label,
      task,
      result,
      recipesFound: 0,
      usedFallback: parsed.usedFallback,
      parseError: parsed.error || null,
    }),
  };
}

export function extractCollectedRecipes(toolCalls: ToolCallEntry[]): ScanRecipe[] {
  return toolCalls
    .filter((tc) => (tc.tool || tc.name) === 'collect_scan_recipe')
    .map((tc) => {
      const res = tc.result as Record<string, unknown> | null;
      if (res && typeof res === 'object' && res.status === 'collected' && res.recipe) {
        return res.recipe as ScanRecipe;
      }
      return null;
    })
    .filter((recipe): recipe is ScanRecipe => Boolean(recipe));
}

function parseJsonResponseWithDiagnostics(
  text: string | null | undefined,
  fallback: Record<string, unknown>,
  onParseError?: (err: unknown) => void
): ParseJsonWithDiagnosticsResult {
  if (!text) {
    return { value: fallback, usedFallback: true, error: 'empty_response' };
  }
  try {
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return { value: JSON.parse(codeBlockMatch[1].trim()), usedFallback: false };
    }
    const objMatch = text.match(/(\{[\s\S]*\})/);
    if (objMatch) {
      return { value: JSON.parse(objMatch[1].trim()), usedFallback: false };
    }
    return { value: JSON.parse(text.trim()), usedFallback: false };
  } catch (err: unknown) {
    onParseError?.(err);
    return {
      value: fallback,
      usedFallback: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildScanDiagnostics({
  label,
  task,
  result,
  recipesFound,
  usedFallback = false,
  parseError = null,
}: {
  label?: string;
  task: 'extract' | 'summarize';
  result: AgentRunResult;
  recipesFound: number;
  usedFallback?: boolean;
  parseError?: string | null;
}) {
  const phases = result.phases as Record<string, PhaseSummary> | undefined;
  const toolCalls = result.toolCalls || [];
  const collectCalls = toolCalls.filter((tc) => (tc.tool || tc.name) === 'collect_scan_recipe');
  return {
    label: label || '',
    task,
    recipesFound,
    usedFallback,
    parseError,
    toolCallCount: toolCalls.length,
    collectScanRecipeCallCount: collectCalls.length,
    iterations: result.usage.iterations || 0,
    durationMs: result.usage.durationMs || 0,
    runtimeDiagnostics: (result.diagnostics as AgentDiagnostics | null) || null,
    phases: Object.fromEntries(
      Object.entries(phases || {}).map(([phaseName, phase]) => [
        phaseName,
        {
          replyLength: phase.reply?.length || 0,
          toolCallCount: phase.toolCalls?.length || 0,
        },
      ])
    ),
  };
}
