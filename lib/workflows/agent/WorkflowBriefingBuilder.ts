import { isCoreDimensionLensId, type MainlineRecipeImpact } from "../../mainline/compile/index.js";
import type { DimensionLensActivation, DimensionLensId } from "../../mainline/knowledge/index.js";
import type { ScanLifecycleResult } from "../scan/ScanLifecycleRunner.js";
import type { AgentWorkflowTaskKind } from "./AgentDimensionWorkflow.js";

export type AgentWorkflowTaskTier = "critical" | "high" | "normal" | "background";
export type AgentWorkflowOutputType = "candidate" | "skill" | "decision";

export interface WorkflowBriefingBudget {
  readonly maxIterations: number;
  readonly maxTokens: number;
}

export interface WorkflowTaskBriefing {
  readonly taskId: string;
  readonly kind: AgentWorkflowTaskKind;
  readonly tier: AgentWorkflowTaskTier;
  readonly outputType: AgentWorkflowOutputType;
  readonly objective: string;
  readonly admission: string;
  readonly evidenceStarter: readonly string[];
  readonly gapSignals: readonly string[];
  readonly impactSignals: readonly string[];
  readonly budget: WorkflowBriefingBudget;
  readonly prompt: string;
}

export interface WorkflowDimensionBriefingInput {
  readonly scan: ScanLifecycleResult;
  readonly activation: DimensionLensActivation;
}

export interface WorkflowGapBriefingInput {
  readonly scan: ScanLifecycleResult;
  readonly lensId: DimensionLensId;
  readonly reason: string;
  readonly confidence: number;
}

export interface WorkflowEvolutionBriefingInput {
  readonly scan: ScanLifecycleResult;
  readonly impact: MainlineRecipeImpact;
}

const TIER_PRIORITY: Record<AgentWorkflowTaskTier, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  background: 1,
};

/**
 * WorkflowBriefingBuilder 把扫描产物投影成 AgentRuntime 可执行 briefing。
 * 中文注释：它只读 ScanLifecycleResult，不接 legacy MissionBriefingBuilder、
 * taskManager 或 UI presenter；任务分层、证据 starter 和预算都在这里归一化。
 */
export class WorkflowBriefingBuilder {
  buildDimension(input: WorkflowDimensionBriefingInput): WorkflowTaskBriefing {
    const lensId = String(input.activation.lensId);
    const outputType = outputTypeForLens(input.activation.lensId);
    const gapSignals = gapSignalsForScan(input.scan, input.activation.lensId);
    const impactSignals = impactSignalsForScan(input.scan);
    const tier = dimensionTier(input.scan, input.activation, gapSignals);
    const budget = budgetForTask("dimension", tier);
    const objective = `补齐 ${lensId} 维度下可复用的 Alembic 项目知识。`;
    const admission = [
      `lens:${lensId}`,
      isCoreDimensionLensId(input.activation.lensId) ? "core-lens" : "conditional-lens",
      `confidence:${round(input.activation.confidence)}`,
      `tier:${tier}`,
    ].join(" ");

    return {
      taskId: lensId,
      kind: "dimension",
      tier,
      outputType,
      objective,
      admission,
      evidenceStarter: evidenceStarter(input.scan),
      gapSignals,
      impactSignals,
      budget,
      prompt: dimensionPrompt({
        scan: input.scan,
        activation: input.activation,
        objective,
        admission,
        outputType,
        evidenceStarter: evidenceStarter(input.scan),
        gapSignals,
        impactSignals,
      }),
    };
  }

  buildGap(input: WorkflowGapBriefingInput): WorkflowTaskBriefing {
    return this.buildDimension({
      scan: input.scan,
      activation: {
        lensId: input.lensId,
        reason: input.reason,
        confidence: input.confidence,
      },
    });
  }

  buildEvolution(input: WorkflowEvolutionBriefingInput): WorkflowTaskBriefing {
    const tier = evolutionTier(input.impact);
    const budget = budgetForTask("evolution", tier);
    const impactSignals = [
      `recipe:${input.impact.recipeId}`,
      `action:${input.impact.suggestedAction}`,
      `level:${input.impact.impactLevel}`,
      `score:${round(input.impact.impactScore)}`,
      `changed:${input.impact.changedPath}`,
    ];
    const objective = `审查 Recipe ${input.impact.recipeId} 的增量影响并做 decision-only 决策。`;
    const admission = [
      "recipe-impact",
      `reason:${input.impact.reason}`,
      `action:${input.impact.suggestedAction}`,
      `tier:${tier}`,
    ].join(" ");

    return {
      taskId: `evolution:${input.impact.recipeId}`,
      kind: "evolution",
      tier,
      outputType: "decision",
      objective,
      admission,
      evidenceStarter: evidenceStarter(input.scan),
      gapSignals: gapSignalsForScan(input.scan, "recipe-relations"),
      impactSignals,
      budget,
      prompt: evolutionPrompt({
        scan: input.scan,
        impact: input.impact,
        objective,
        admission,
        evidenceStarter: evidenceStarter(input.scan),
        gapSignals: gapSignalsForScan(input.scan, "recipe-relations"),
        impactSignals,
      }),
    };
  }
}

export function compareWorkflowTaskTier(
  left: AgentWorkflowTaskTier,
  right: AgentWorkflowTaskTier,
): number {
  return TIER_PRIORITY[right] - TIER_PRIORITY[left];
}

export function workflowGapActivations(scan: ScanLifecycleResult): DimensionLensActivation[] {
  const activations: DimensionLensActivation[] = [];
  if (scan.summary.recipes === 0) {
    activations.push({
      lensId: "knowledge-gap",
      reason: "No active Recipe was compiled; agent should mine foundational project guidance.",
      confidence: 0.92,
    });
  }
  if (scan.summary.truncated) {
    activations.push({
      lensId: "scan-coverage-gap",
      reason: "Source scan was truncated; agent should identify coverage risk and next scan scope.",
      confidence: 0.86,
    });
  }
  if ((scan.compile?.search.embeddingFailures ?? 0) > 0) {
    activations.push({
      lensId: "semantic-search-gap",
      reason: "Embedding failures were reported; agent should note degraded semantic retrieval.",
      confidence: 0.8,
    });
  }
  return activations;
}

function dimensionPrompt(input: {
  readonly scan: ScanLifecycleResult;
  readonly activation: DimensionLensActivation;
  readonly objective: string;
  readonly admission: string;
  readonly outputType: AgentWorkflowOutputType;
  readonly evidenceStarter: readonly string[];
  readonly gapSignals: readonly string[];
  readonly impactSignals: readonly string[];
}): string {
  const lensId = String(input.activation.lensId);
  const panorama = input.scan.evidence?.projectPanorama;
  const skillGuidance =
    input.outputType === "skill"
      ? "这个维度允许产出 skill-worthy 结论：如果发现稳定的 agent 操作流程、验证链路或安全约束，请用 knowledge.submit 保存候选，并在 dimensionDigest.skillWorthy 标记 true。"
      : "高价值且可复用的规范、模式或操作约束可以通过 knowledge.submit 提交候选；普通发现用 memory.note_finding 记录。";

  return [
    `你正在为 Alembic 内部冷启动/增量扫描执行 briefing：${lensId}`,
    `目标：${input.objective}`,
    `准入：${input.admission}`,
    `维度触发原因：${input.activation.reason}`,
    `项目根目录：${input.scan.projectRoot}`,
    `扫描模式：${input.scan.mode}`,
    panorama
      ? `项目摘要：files=${panorama.fileCount}, symbols=${panorama.symbolCount}, language=${
          panorama.dominantLanguage ?? "unknown"
        }`
      : null,
    `变更摘要：added=${input.scan.summary.addedFiles}, modified=${input.scan.summary.modifiedFiles}, deleted=${input.scan.summary.deletedFiles}, impacts=${input.scan.summary.recipeImpacts}`,
    input.gapSignals.length > 0 ? `缺口信号：${input.gapSignals.join("; ")}` : null,
    input.impactSignals.length > 0 ? `影响信号：${input.impactSignals.join("; ")}` : null,
    input.evidenceStarter.length > 0 ? `证据 starter：${input.evidenceStarter.join("; ")}` : null,
    "",
    "请先用允许的工具查证事实，不要凭空生成项目规则。",
    skillGuidance,
    "最终必须输出 dimensionDigest JSON，包含 summary、candidateCount、keyFindings、crossRefs、gaps、remainingTasks；skill-worthy 任务还要包含 skillWorthy。",
  ]
    .filter(Boolean)
    .join("\n");
}

function evolutionPrompt(input: {
  readonly scan: ScanLifecycleResult;
  readonly impact: MainlineRecipeImpact;
  readonly objective: string;
  readonly admission: string;
  readonly evidenceStarter: readonly string[];
  readonly gapSignals: readonly string[];
  readonly impactSignals: readonly string[];
}): string {
  return [
    `你正在执行 Alembic Recipe evolution briefing：${input.impact.recipeTitle}`,
    `目标：${input.objective}`,
    `准入：${input.admission}`,
    `Recipe id: ${input.impact.recipeId}`,
    `项目根目录：${input.scan.projectRoot}`,
    `变化路径：${input.impact.changedPath}`,
    input.impact.targetPath ? `目标路径：${input.impact.targetPath}` : null,
    `影响原因：${input.impact.reason}`,
    `影响等级：${input.impact.impactLevel}`,
    `建议动作：${input.impact.suggestedAction}`,
    `命中 token：${input.impact.matchedTokens.join(", ") || "none"}`,
    input.gapSignals.length > 0 ? `缺口信号：${input.gapSignals.join("; ")}` : null,
    input.impactSignals.length > 0 ? `影响信号：${input.impactSignals.join("; ")}` : null,
    input.evidenceStarter.length > 0 ? `证据 starter：${input.evidenceStarter.join("; ")}` : null,
    "",
    "当前阶段只允许调用 knowledge.manage，并且必须对该 Recipe 做 evolve、deprecate 或 skip_evolution 决策。",
  ]
    .filter(Boolean)
    .join("\n");
}

function evidenceStarter(scan: ScanLifecycleResult): string[] {
  const compile = scan.compile;
  const fingerprintDiff = scan.evidence?.fingerprintDiff;
  return [
    ...(scan.plan.scan.skipDirs?.slice(0, 3).map((entry) => `skipDir:${entry}`) ?? []),
    ...(fingerprintDiff?.added.slice(0, 3).map((entry) => `added:${entry}`) ?? []),
    ...(fingerprintDiff?.modified.slice(0, 3).map((entry) => `modified:${entry}`) ?? []),
    ...(fingerprintDiff?.deleted.slice(0, 3).map((entry) => `deleted:${entry}`) ?? []),
    ...(compile?.projectIntelligence.artifact.files
      .slice(0, 3)
      .map((file) => `file:${file.path}`) ?? []),
    ...(compile?.projectIntelligence.artifact.symbols
      .slice(0, 3)
      .map((symbol) => `symbol:${symbol.fqn}`) ?? []),
  ].slice(0, 12);
}

function gapSignalsForScan(scan: ScanLifecycleResult, lensId: DimensionLensId): string[] {
  const gaps: string[] = [];
  if (scan.summary.recipes === 0) {
    gaps.push("no_recipes_compiled");
  }
  if (scan.summary.searchDocuments === 0) {
    gaps.push("search_index_empty");
  }
  if (scan.summary.truncated) {
    gaps.push("scan_truncated");
  }
  if (scan.warnings.length > 0) {
    gaps.push(`warnings:${scan.warnings.length}`);
  }
  if ((scan.compile?.search.embeddingFailures ?? 0) > 0) {
    gaps.push(`embedding_failures:${scan.compile?.search.embeddingFailures ?? 0}`);
  }
  if (scan.summary.repairedSourceRefs + scan.summary.staleSourceRefs > 0) {
    gaps.push(
      `source_ref_repair:${scan.summary.repairedSourceRefs + scan.summary.staleSourceRefs}`,
    );
  }
  if (lensId === "recipe-relations" && scan.summary.recipes < 2) {
    gaps.push("insufficient_recipe_relation_candidates");
  }
  return gaps;
}

function impactSignalsForScan(scan: ScanLifecycleResult): string[] {
  const impactPlan = scan.compile?.recipeImpact;
  if (!impactPlan || impactPlan.impacts.length === 0) {
    return [];
  }
  return impactPlan.impacts
    .slice(0, 5)
    .map((impact) =>
      [
        `recipe:${impact.recipeId}`,
        `path:${impact.changedPath}`,
        `action:${impact.suggestedAction}`,
        `level:${impact.impactLevel}`,
      ].join(","),
    );
}

function dimensionTier(
  scan: ScanLifecycleResult,
  activation: DimensionLensActivation,
  gapSignals: readonly string[],
): AgentWorkflowTaskTier {
  if (activation.lensId === "knowledge-gap" || activation.lensId === "scan-coverage-gap") {
    return "high";
  }
  if (activation.lensId === "semantic-search-gap") {
    return "normal";
  }
  if (scan.summary.recipeImpacts > 0 && activation.lensId === "recipe-relations") {
    return "critical";
  }
  if (
    activation.lensId === "quality-safety" &&
    (scan.warnings.length > 0 || scan.summary.truncated)
  ) {
    return "high";
  }
  if (activation.lensId === "agent-guidelines" || activation.lensId === "quality-safety") {
    return "high";
  }
  if (gapSignals.length > 0 || activation.confidence >= 0.9) {
    return "high";
  }
  return isCoreDimensionLensId(activation.lensId) ? "normal" : "background";
}

function evolutionTier(impact: MainlineRecipeImpact): AgentWorkflowTaskTier {
  if (impact.suggestedAction === "deprecate" || impact.impactScore >= 0.9) {
    return "critical";
  }
  if (impact.suggestedAction === "update" || impact.impactLevel === "pattern") {
    return "high";
  }
  return impact.suggestedAction === "verify" ? "normal" : "background";
}

function budgetForTask(
  kind: AgentWorkflowTaskKind,
  tier: AgentWorkflowTaskTier,
): WorkflowBriefingBudget {
  if (kind === "evolution") {
    return tier === "critical"
      ? { maxIterations: 5, maxTokens: 2200 }
      : { maxIterations: 4, maxTokens: 1600 };
  }
  if (tier === "critical") {
    return { maxIterations: 10, maxTokens: 3800 };
  }
  if (tier === "high") {
    return { maxIterations: 8, maxTokens: 3200 };
  }
  return { maxIterations: 6, maxTokens: 2400 };
}

function outputTypeForLens(lensId: DimensionLensId): AgentWorkflowOutputType {
  return lensId === "agent-guidelines" ? "skill" : "candidate";
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
