/**
 * SkillConsumer — skillWorthy 维度的 Project Skill 生成消费器
 *
 * 结构清洗 W2：自 execution/GenerateConsumers.ts 纯移动并入 skill-delivery/。
 * 承载 consumeGenerateSkills 及 skill 提炼助手（关键发现提取、短文本合成、
 * delivery receipt 记录与过程事件发射）；就近消费同目录
 * SkillCompletionCapability 的 generateSkill。逻辑与日志文案保持逐字不变。
 */

import type { SessionStore } from '@alembic/agent/memory';
import type { ProjectSkillDeliveryReceipt } from '@alembic/core/host-agent-workflows';
import Logger from '@alembic/core/logging';
import type { GenerateEventEmitter } from '#recipe-pipeline/generate/runtime/GenerateEventEmitter.js';
import type { DimensionCandidateData } from '../execution/consumers/shared.js';
import { generateSkill, type WorkflowSkillGenerationResult } from './SkillCompletionCapability.js';

const logger = Logger.getInstance();

// ---------------------------------------------------------------------------
// Skill consumer
// ---------------------------------------------------------------------------

export interface SkillResults {
  created: number;
  failed: number;
  deliveryReceiptSummaries?: string[];
  deliveryReceiptValidationIssues?: Array<{ dimId: string; issues: string[]; skillName: string }>;
  deliveryReceipts?: ProjectSkillDeliveryReceipt[];
  skills: string[];
  errors: Array<{ dimId: string; error: string }>;
}

export interface GenerateSkillDimension {
  id: string;
  label?: string;
  skillWorthy?: boolean;
  skillMeta?: { name?: string; description?: string } | null;
}

type GenerateSkillFn = typeof generateSkill;

export interface ConsumeGenerateSkillsOptions {
  ctx: Parameters<GenerateSkillFn>[0];
  dimensions: GenerateSkillDimension[];
  dimensionCandidates: Record<string, DimensionCandidateData>;
  sessionStore: SessionStore;
  emitter: GenerateEventEmitter;
  sessionId?: string;
  shouldAbort?: () => boolean;
  generateSkillFn?: GenerateSkillFn;
}

export async function consumeGenerateSkills({
  ctx,
  dimensions,
  dimensionCandidates,
  sessionStore,
  emitter,
  sessionId,
  shouldAbort,
  generateSkillFn = generateSkill,
}: ConsumeGenerateSkillsOptions): Promise<SkillResults> {
  const skillResults: SkillResults = {
    created: 0,
    deliveryReceiptSummaries: [],
    deliveryReceiptValidationIssues: [],
    deliveryReceipts: [],
    failed: 0,
    skills: [],
    errors: [],
  };

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
        sessionId,
        skillResults,
        generateSkillFn,
      });
    }
  } catch (e: unknown) {
    logger.warn(
      `[generate] Skill generation module import failed: ${e instanceof Error ? e.message : String(e)}`
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
  sessionId,
  skillResults,
  generateSkillFn,
}: {
  ctx: Parameters<GenerateSkillFn>[0];
  dim: GenerateSkillDimension;
  dimData: DimensionCandidateData;
  sessionStore: SessionStore;
  emitter: GenerateEventEmitter;
  sessionId?: string;
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
      recordSkillDeliveryReceipt({
        dim,
        emitter,
        result,
        sessionId,
        skillResults,
      });
      skillResults.created++;
      skillResults.skills.push(result.skillName);
      emitter.emitDimensionComplete(dim.id, {
        type: 'skill',
        deliveryReceipt: result.deliveryReceipt,
        deliveryReceiptSummary: result.deliveryReceiptSummary,
        deliveryReceiptValidation: result.deliveryReceiptValidation,
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
    logger.warn(`[generate] Skill generation failed for "${dim.id}": ${errMsg}`);
    skillResults.failed++;
    skillResults.errors.push({ dimId: dim.id, error: errMsg });
    emitter.emitDimensionFailed(dim.id, err instanceof Error ? err : new Error(errMsg));
  }
}

function recordSkillDeliveryReceipt({
  dim,
  emitter,
  result,
  sessionId,
  skillResults,
}: {
  dim: GenerateSkillDimension;
  emitter: GenerateEventEmitter;
  result: WorkflowSkillGenerationResult;
  sessionId?: string;
  skillResults: SkillResults;
}) {
  if (!result.deliveryReceipt) {
    return;
  }

  skillResults.deliveryReceipts?.push(result.deliveryReceipt);
  if (result.deliveryReceiptSummary) {
    skillResults.deliveryReceiptSummaries?.push(result.deliveryReceiptSummary);
  }
  if (result.deliveryReceiptValidation && !result.deliveryReceiptValidation.ok) {
    skillResults.deliveryReceiptValidationIssues?.push({
      dimId: dim.id,
      issues: result.deliveryReceiptValidation.issues,
      skillName: result.skillName,
    });
  }

  if (!sessionId) {
    return;
  }

  const emitProcessEvents = (
    emitter as { emitProcessEvents?: GenerateEventEmitter['emitProcessEvents'] }
  ).emitProcessEvents;
  emitProcessEvents?.call(emitter, {
    dimensionId: dim.id,
    sessionId,
    source: 'alembic-project-skill-delivery',
    targetName: dim.label ?? dim.id,
    taskId: dim.id,
    events: [
      {
        artifactRefs: [
          {
            kind: 'project-skill-delivery-receipt',
            label: 'ProjectSkillDeliveryReceipt',
            mimeType: 'application/json',
            ref: `project-skill-delivery:${result.deliveryReceipt.id}`,
          },
          {
            kind: 'skill-file',
            label: 'Generated SKILL.md',
            mimeType: 'text/markdown',
            ref: result.deliveryReceipt.asset.path,
          },
        ],
        content: {
          data: result.deliveryReceipt,
          language: 'json',
          mimeType: 'application/json',
          role: 'tool',
          text: JSON.stringify(result.deliveryReceipt, null, 2),
        },
        displayPolicy: 'summary-only',
        kind: 'artifact',
        metadata: {
          projectScopeId: result.deliveryReceipt.projectScopeId,
          receiptId: result.deliveryReceipt.id,
          route: result.deliveryReceipt.route,
          runtimeExportStatus: result.deliveryReceipt.runtimeExport.status,
          skillName: result.skillName,
          validationIssues: result.deliveryReceiptValidation?.issues ?? [],
        },
        phase: 'skill-delivery',
        retention: 'artifact-retained',
        severity: result.deliveryReceiptValidation?.ok === false ? 'warning' : 'success',
        summary:
          result.deliveryReceiptSummary ??
          `Project Skill ${result.skillName} generated; runtime export pending.`,
        title: 'Project Skill delivery receipt',
      },
    ],
  });
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
  dim: GenerateSkillDimension;
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
    `[generate] Skill "${dim.id}": analysisText too short (${analysisText.trim().length} chars), ` +
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
