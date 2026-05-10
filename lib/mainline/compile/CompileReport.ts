import { epochSecondsNow } from "../core/time.js";
import type {
  DimensionLensActivation,
  EvidencePackage,
  Recipe,
  RecipeEdge,
  RecipeEdgeRelation,
  RecipeEdgeSource,
  RecipeKind,
  RecipeStatus,
  SourceRefStatus,
} from "../knowledge/index.js";
import { isCoreDimensionLensId } from "./DimensionLensPolicy.js";
import type { SourceRefFreshnessFinding } from "./SourceRefFreshnessCheck.js";

const RECIPE_STATUSES = [
  "candidate",
  "active",
  "stale",
  "superseded",
  "rejected",
] as const satisfies readonly RecipeStatus[];

const RECIPE_KINDS = [
  "convention",
  "pattern",
  "fact",
  "risk",
  "workflow",
  "guard-rule",
] as const satisfies readonly RecipeKind[];

const EDGE_RELATIONS = [
  "requires",
  "supports",
  "conflicts_with",
  "supersedes",
  "refines",
  "same_context",
  "applies_to",
] as const satisfies readonly RecipeEdgeRelation[];

const EDGE_SOURCES = [
  "source-ref-overlap",
  "code-entity-cooccurrence",
  "guard-finding-cooccurrence",
  "manual",
  "llm-candidate",
  "legacy",
] as const satisfies readonly RecipeEdgeSource[];

const SOURCE_REF_STATUSES = [
  "active",
  "stale",
  "renamed",
  "missing",
  "unknown",
] as const satisfies readonly SourceRefStatus[];

export type CompileReportNextStepCode =
  | "collect-evidence"
  | "activate-lenses"
  | "anchor-recipes"
  | "mine-recipe-edges"
  | "refresh-source-refs"
  | "write-context-index"
  | "ready-for-runtime";

export type CompileReportNextStepSeverity = "info" | "warning";

export interface CompileReportNextStep {
  readonly code: CompileReportNextStepCode;
  readonly severity: CompileReportNextStepSeverity;
  readonly summary: string;
}

export interface CompileReportEvidenceSummary {
  readonly packageId: string;
  readonly packageCount: number;
  readonly origin: EvidencePackage["origin"];
  readonly changedFileCount: number;
  readonly sourceRefCount: number;
  readonly noteCount: number;
  readonly lensActivationCount: number;
  readonly coreLensCount: number;
  readonly conditionalLensCount: number;
}

export interface CompileReportRecipeSummary {
  readonly total: number;
  readonly withSourceRefs: number;
  readonly withoutSourceRefs: number;
  readonly byStatus: Record<RecipeStatus, number>;
  readonly byKind: Record<RecipeKind, number>;
}

export interface CompileReportEdgeSummary {
  readonly total: number;
  readonly byRelation: Record<RecipeEdgeRelation, number>;
  readonly byEvidenceSource: Record<RecipeEdgeSource, number>;
}

export interface CompileReportFreshnessSummary {
  readonly total: number;
  readonly fresh: number;
  readonly needsRefresh: number;
  readonly byStatus: Record<SourceRefStatus, number>;
}

/**
 * CompileReport 是小型编译期 artifact，不是 workflow report。
 * 中文注释：它只汇总当前编译已经产出的对象和确定性下一步，
 * 不调用旧 service、dashboard presenter 或 runtime builder。
 */
export interface CompileReport {
  readonly id: string;
  readonly generatedAt: number;
  readonly evidence: CompileReportEvidenceSummary;
  readonly recipes: CompileReportRecipeSummary;
  readonly edges: CompileReportEdgeSummary;
  readonly freshness: CompileReportFreshnessSummary;
  readonly nextSteps: CompileReportNextStep[];
}

export interface BuildCompileReportRequest {
  readonly id?: string;
  readonly evidencePackage: EvidencePackage;
  readonly lensActivations?: readonly DimensionLensActivation[];
  readonly recipes?: readonly Recipe[];
  readonly edges?: readonly RecipeEdge[];
  readonly freshnessFindings?: readonly SourceRefFreshnessFinding[];
  readonly generatedAt?: number;
}

export class CompileReportBuilder {
  build(request: BuildCompileReportRequest): CompileReport {
    const evidence = summarizeEvidence(request.evidencePackage, request.lensActivations ?? []);
    const recipes = summarizeRecipes(request.recipes ?? []);
    const edges = summarizeEdges(request.edges ?? []);
    const freshness = summarizeFreshness(request.evidencePackage, request.freshnessFindings);

    return {
      id: request.id ?? `${request.evidencePackage.id}:compile-report`,
      generatedAt: request.generatedAt ?? epochSecondsNow(),
      evidence,
      recipes,
      edges,
      freshness,
      nextSteps: recommendNextSteps(evidence, recipes, edges, freshness),
    };
  }
}

function summarizeEvidence(
  evidencePackage: EvidencePackage,
  lensActivations: readonly DimensionLensActivation[],
): CompileReportEvidenceSummary {
  const coreLensCount = lensActivations.filter((activation) =>
    isCoreDimensionLensId(activation.lensId),
  ).length;

  return {
    packageId: evidencePackage.id,
    packageCount: 1,
    origin: evidencePackage.origin,
    changedFileCount: evidencePackage.changedFiles.length,
    sourceRefCount: evidencePackage.sourceRefs.length,
    noteCount: evidencePackage.notes.length,
    lensActivationCount: lensActivations.length,
    coreLensCount,
    conditionalLensCount: lensActivations.length - coreLensCount,
  };
}

function summarizeRecipes(recipes: readonly Recipe[]): CompileReportRecipeSummary {
  return {
    total: recipes.length,
    withSourceRefs: recipes.filter((recipe) => recipe.sourceRefIds.length > 0).length,
    withoutSourceRefs: recipes.filter((recipe) => recipe.sourceRefIds.length === 0).length,
    byStatus: countBy(
      recipes.map((recipe) => recipe.status),
      RECIPE_STATUSES,
    ),
    byKind: countBy(
      recipes.map((recipe) => recipe.kind),
      RECIPE_KINDS,
    ),
  };
}

function summarizeEdges(edges: readonly RecipeEdge[]): CompileReportEdgeSummary {
  return {
    total: edges.length,
    byRelation: countBy(
      edges.map((edge) => edge.relation),
      EDGE_RELATIONS,
    ),
    byEvidenceSource: countBy(
      edges.map((edge) => edge.evidenceSource),
      EDGE_SOURCES,
    ),
  };
}

function summarizeFreshness(
  evidencePackage: EvidencePackage,
  freshnessFindings?: readonly SourceRefFreshnessFinding[],
): CompileReportFreshnessSummary {
  const statuses =
    freshnessFindings?.map((finding) => finding.status) ??
    evidencePackage.sourceRefs.map((sourceRef) => sourceRef.status);
  const fresh =
    freshnessFindings?.filter((finding) => finding.fresh).length ??
    statuses.filter(isFreshSourceRefStatus).length;

  return {
    total: statuses.length,
    fresh,
    needsRefresh: statuses.length - fresh,
    byStatus: countBy(statuses, SOURCE_REF_STATUSES),
  };
}

function recommendNextSteps(
  evidence: CompileReportEvidenceSummary,
  recipes: CompileReportRecipeSummary,
  edges: CompileReportEdgeSummary,
  freshness: CompileReportFreshnessSummary,
): CompileReportNextStep[] {
  const nextSteps: CompileReportNextStep[] = [];

  if (evidence.changedFileCount + evidence.sourceRefCount + evidence.noteCount === 0) {
    nextSteps.push({
      code: "collect-evidence",
      severity: "info",
      summary: "Collect changed files, SourceRefs, or notes before mining Recipes.",
    });
  }

  if (evidence.lensActivationCount === 0) {
    nextSteps.push({
      code: "activate-lenses",
      severity: "info",
      summary: "Run DimensionLensPolicy before recipe mining so miners have focused lenses.",
    });
  }

  if (recipes.withoutSourceRefs > 0) {
    nextSteps.push({
      code: "anchor-recipes",
      severity: "warning",
      summary: "Add SourceRef anchors before promoting unanchored Recipes.",
    });
  }

  if (freshness.needsRefresh > 0) {
    nextSteps.push({
      code: "refresh-source-refs",
      severity: "warning",
      summary: "Refresh stale, missing, or unknown SourceRefs before trusting compile output.",
    });
  }

  if (recipes.total > 1 && edges.total === 0) {
    nextSteps.push({
      code: "mine-recipe-edges",
      severity: "info",
      summary: "Mine RecipeEdge relationships so runtime bundles can expand context.",
    });
  }

  if (evidence.sourceRefCount + recipes.total + edges.total > 0) {
    nextSteps.push({
      code: "write-context-index",
      severity: "info",
      summary:
        "Write validated SourceRefs, Recipes, and RecipeEdges to the compiled context index.",
    });
  }

  if (
    nextSteps.every((step) => step.severity === "info") &&
    recipes.total > 0 &&
    freshness.needsRefresh === 0
  ) {
    nextSteps.push({
      code: "ready-for-runtime",
      severity: "info",
      summary: "Compile artifacts are ready for runtime ContextBundle reads.",
    });
  }

  return nextSteps;
}

function countBy<T extends string>(values: readonly T[], keys: readonly T[]): Record<T, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
  for (const value of values) {
    counts[value] += 1;
  }
  return counts;
}

function isFreshSourceRefStatus(status: SourceRefStatus): boolean {
  return status === "active" || status === "renamed";
}
