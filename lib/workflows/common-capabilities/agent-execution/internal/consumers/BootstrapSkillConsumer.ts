import type { SessionStore } from '#agent/memory/SessionStore.js';
import Logger from '#infra/logging/Logger.js';
import type { BootstrapEventEmitter } from '#service/bootstrap/BootstrapEventEmitter.js';
import type { DimensionCandidateData } from '#workflows/common-capabilities/agent-execution/internal/consumers/BootstrapDimensionConsumer.js';
import { generateSkill } from '#workflows/common-capabilities/agent-execution/skills/WorkflowSkillCompletionCapability.js';

const logger = Logger.getInstance();

export interface SkillResults {
  created: number;
  failed: number;
  skills: string[];
  errors: Array<{ dimId: string; error: string }>;
}

export interface BootstrapSkillDimension {
  id: string;
  label?: string;
  skillWorthy?: boolean;
  skillMeta?: { name?: string; description?: string } | null;
}

type GenerateSkillFn = typeof generateSkill;

export interface ConsumeBootstrapSkillsOptions {
  ctx: Parameters<GenerateSkillFn>[0];
  dimensions: BootstrapSkillDimension[];
  dimensionCandidates: Record<string, DimensionCandidateData>;
  sessionStore: SessionStore;
  emitter: BootstrapEventEmitter;
  shouldAbort?: () => boolean;
  generateSkillFn?: GenerateSkillFn;
}

export async function consumeBootstrapSkills({
  ctx,
  dimensions,
  dimensionCandidates,
  sessionStore,
  emitter,
  shouldAbort,
  generateSkillFn = generateSkill,
}: ConsumeBootstrapSkillsOptions): Promise<SkillResults> {
  const skillResults: SkillResults = { created: 0, failed: 0, skills: [], errors: [] };

  try {
    for (const dim of dimensions) {
      if (!dim.skillWorthy) {
        continue;
      }
      const dimData = dimensionCandidates[dim.id];
      if (!dimData?.analysisReport?.analysisText) {
        continue;
      }
      if (shouldAbort?.()) {
        break;
      }

      await consumeSingleBootstrapSkill({
        ctx,
        dim,
        dimData,
        sessionStore,
        emitter,
        skillResults,
        generateSkillFn,
      });
    }
  } catch (e: unknown) {
    logger.warn(
      `[Insight-v3] Skill generation module import failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  return skillResults;
}

async function consumeSingleBootstrapSkill({
  ctx,
  dim,
  dimData,
  sessionStore,
  emitter,
  skillResults,
  generateSkillFn,
}: {
  ctx: Parameters<GenerateSkillFn>[0];
  dim: BootstrapSkillDimension;
  dimData: DimensionCandidateData;
  sessionStore: SessionStore;
  emitter: BootstrapEventEmitter;
  skillResults: SkillResults;
  generateSkillFn: GenerateSkillFn;
}) {
  try {
    const analysisText = dimData.analysisReport.analysisText;
    const referencedFiles = dimData.analysisReport.referencedFiles || [];
    const dimReport = sessionStore.getDimensionReport(dim.id);
    const keyFindings = extractSkillKeyFindings(dimReport);
    const effectiveText = buildEffectiveSkillAnalysisText({
      dim,
      analysisText,
      keyFindings,
      distilled: dimReport?.workingMemoryDistilled,
    });

    const result = await generateSkillFn(
      ctx,
      dim,
      effectiveText,
      referencedFiles,
      keyFindings,
      'bootstrap-v3'
    );

    if (result.success) {
      skillResults.created++;
      skillResults.skills.push(result.skillName);
      emitter.emitDimensionComplete(dim.id, {
        type: 'skill',
        skillName: result.skillName,
        sourceCount: referencedFiles.length,
      });
    } else {
      skillResults.failed++;
      skillResults.errors.push({ dimId: dim.id, error: result.error ?? 'unknown' });
      emitter.emitDimensionFailed(dim.id, new Error(result.error));
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn(`[Insight-v3] Skill generation failed for "${dim.id}": ${errMsg}`);
    skillResults.failed++;
    skillResults.errors.push({ dimId: dim.id, error: errMsg });
    emitter.emitDimensionFailed(dim.id, err instanceof Error ? err : new Error(errMsg));
  }
}

export function extractSkillKeyFindings(dimReport: unknown): string[] {
  const report = dimReport as { findings?: Array<Record<string, unknown>> } | null | undefined;
  return ((report?.findings || []) as Array<Record<string, unknown>>)
    .sort((a, b) => (Number(b.importance) || 5) - (Number(a.importance) || 5))
    .slice(0, 10)
    .map((f) => String(f.finding || ''));
}

export function buildEffectiveSkillAnalysisText({
  dim,
  analysisText,
  keyFindings,
  distilled,
}: {
  dim: BootstrapSkillDimension;
  analysisText: string;
  keyFindings: string[];
  distilled?: { toolCallSummary?: Array<string | { tool?: string; summary?: string }> } | null;
}) {
  if (analysisText.trim().length >= 100 || keyFindings.length === 0) {
    return analysisText;
  }

  const synthesized = [
    `## ${dim.label || dim.id}`,
    '',
    analysisText.trim(),
    '',
    '## 关键发现',
    '',
    ...keyFindings.map((f: string, i: number) => `${i + 1}. ${f}`),
  ];
  if ((distilled?.toolCallSummary?.length ?? 0) > 0) {
    synthesized.push('', '## 探索记录', '');
    for (const s of (distilled?.toolCallSummary ?? []).slice(0, 10)) {
      synthesized.push(`- ${formatToolCallSummary(s)}`);
    }
  }
  const effectiveText = synthesized.join('\n');
  logger.info(
    `[Insight-v3] Skill "${dim.id}": analysisText too short (${analysisText.trim().length} chars), ` +
      `synthesized from ${keyFindings.length} findings → ${effectiveText.length} chars`
  );
  return effectiveText;
}

function formatToolCallSummary(summary: string | { tool?: string; summary?: string }) {
  if (typeof summary === 'string') {
    return summary;
  }
  return [summary.tool, summary.summary].filter(Boolean).join(': ') || 'unknown tool call';
}
