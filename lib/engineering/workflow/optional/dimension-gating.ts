import { isEngineeringGeneratedArtifact } from "../core/core.js";
import type {
  EngineeringWorkflowDimensionFileRef,
  EngineeringWorkflowDimensionGate,
  EngineeringWorkflowDimensionGateInput,
  EngineeringWorkflowDimensionGateResult,
  EngineeringWorkflowEnhancementSignal,
  EngineeringWorkflowOptionalDiagnostic,
  EngineeringWorkflowOptionalDimension,
} from "./types.js";

export function gateOptionalDimensions(
  input: EngineeringWorkflowDimensionGateInput,
): EngineeringWorkflowDimensionGateResult {
  const snapshot = input.snapshot ?? null;
  const gaps = input.gaps ?? snapshot?.gaps ?? [];
  const dimensions = dedupeDimensions([
    ...dimensionsFromSnapshot(snapshot),
    ...(input.dimensions ?? []),
  ]);
  const diagnostics: EngineeringWorkflowOptionalDiagnostic[] = [];

  if (!snapshot) {
    diagnostics.push({
      code: "optional.dimension.no-snapshot",
      severity: "info",
      message:
        "Dimension gating is using input dimensions only because no panorama snapshot was supplied.",
      source: "dimension-gating",
    });
  }

  const gates = dimensions.map((dimension) => gateForDimension(dimension, gaps));
  const activeDimensions = dimensions.filter((dimension) =>
    gates.some((gate) => gate.dimensionId === dimension.id && gate.active),
  );
  const fileRefs = dedupeFileRefs(
    [
      ...refsFromGaps(gaps),
      ...refsFromSnapshotModules(snapshot, gates),
      ...refsFromEnhancementSignals(input.enhancementSignals ?? []),
    ].filter((ref) => !isGeneratedPath(ref.filePath, input.generatedArtifactBlacklist ?? [])),
  );

  return {
    activeDimensions,
    gates,
    fileRefs,
    diagnostics,
  };
}

function dimensionsFromSnapshot(
  snapshot: EngineeringWorkflowDimensionGateInput["snapshot"],
): readonly EngineeringWorkflowOptionalDimension[] {
  if (!snapshot) {
    return [];
  }
  return snapshot.dimensions.dimensions.map((dimension) => ({
    id: dimension.id,
    label: dimension.name,
    guide: dimension.description,
    knowledgeTypes: [],
    source: "panorama",
  }));
}

function gateForDimension(
  dimension: EngineeringWorkflowOptionalDimension,
  gaps: EngineeringWorkflowDimensionGateInput["gaps"],
): EngineeringWorkflowDimensionGate {
  const matchingGaps = (gaps ?? []).filter((gap) =>
    dimensionMatchesGap(dimension.id, gap.dimension),
  );
  if (matchingGaps.length > 0) {
    const priority = highestPriority(matchingGaps.map((gap) => gap.priority));
    return {
      dimensionId: dimension.id,
      active: true,
      reason: `Activated by ${matchingGaps.length} panorama gap(s).`,
      priority,
      source: "gap",
    };
  }
  if (dimension.source && dimension.source !== "panorama") {
    return {
      dimensionId: dimension.id,
      active: true,
      reason: `Activated by ${dimension.source} optional enhancement.`,
      priority: "medium",
      source: "enhancement",
    };
  }
  return {
    dimensionId: dimension.id,
    active: false,
    reason: "No matching weak area, gap, or enhancement signal.",
    priority: "low",
    source: "input",
  };
}

function refsFromGaps(
  gaps: NonNullable<EngineeringWorkflowDimensionGateInput["gaps"]>,
): readonly EngineeringWorkflowDimensionFileRef[] {
  const refs: EngineeringWorkflowDimensionFileRef[] = [];
  for (const gap of gaps) {
    const dimensionId = gap.dimension ?? dimensionForGapType(gap.type);
    for (const evidence of gap.evidence) {
      const filePath = filePathFromEvidence(evidence);
      if (filePath) {
        refs.push({
          dimensionId,
          filePath,
          source: "gap-evidence",
          reason: gap.title,
          confidence: priorityConfidence(gap.priority),
          ...(gap.module === undefined ? {} : { module: gap.module }),
        });
      }
    }
  }
  return refs;
}

function refsFromSnapshotModules(
  snapshot: EngineeringWorkflowDimensionGateInput["snapshot"],
  gates: readonly EngineeringWorkflowDimensionGate[],
): readonly EngineeringWorkflowDimensionFileRef[] {
  if (!snapshot) {
    return [];
  }
  const activeDimensionIds = new Set(
    gates.filter((gate) => gate.active).map((gate) => gate.dimensionId),
  );
  const refs: EngineeringWorkflowDimensionFileRef[] = [];
  for (const weakArea of snapshot.dimensions.weakAreas) {
    if (!activeDimensionIds.has(weakArea.dimension)) {
      continue;
    }
    for (const moduleName of weakArea.affectedModules) {
      const module = snapshot.modules.find((item) => item.name === moduleName);
      for (const filePath of module?.files ?? []) {
        refs.push({
          dimensionId: weakArea.dimension,
          filePath,
          source: "dimension-module",
          reason: weakArea.reason,
          confidence: priorityConfidence(weakArea.priority),
          module: moduleName,
        });
      }
    }
  }
  for (const gap of snapshot.gaps) {
    const dimensionId = gap.dimension ?? dimensionForGapType(gap.type);
    if (!activeDimensionIds.has(dimensionId) || !gap.module) {
      continue;
    }
    const module = snapshot.modules.find((item) => item.name === gap.module);
    for (const filePath of module?.files ?? []) {
      refs.push({
        dimensionId,
        filePath,
        source: "module-role",
        reason: gap.reason,
        confidence: priorityConfidence(gap.priority),
        module: gap.module,
      });
    }
  }
  return refs;
}

function refsFromEnhancementSignals(
  signals: readonly EngineeringWorkflowEnhancementSignal[],
): readonly EngineeringWorkflowDimensionFileRef[] {
  return signals
    .filter((signal) => signal.filePath !== undefined)
    .map((signal) => ({
      dimensionId: `${signal.packId}-enhancement`,
      filePath: signal.filePath ?? "",
      source: "enhancement-signal" as const,
      reason: signal.reason,
      confidence: signal.confidence,
    }))
    .filter((ref) => ref.filePath.length > 0);
}

function dimensionMatchesGap(dimensionId: string, gapDimension: string | undefined): boolean {
  return (
    gapDimension === dimensionId ||
    (gapDimension !== undefined && dimensionId.includes(gapDimension))
  );
}

function dimensionForGapType(type: string): string {
  switch (type) {
    case "architecture-cycle":
    case "external-dependency-hotspot":
    case "layer-conflict":
      return "architecture";
    case "recipe-coverage":
      return "recipe-coverage";
    case "role-uncertainty":
      return "module-role";
    case "structural-coverage":
      return "structural-coverage";
    default:
      return type;
  }
}

function filePathFromEvidence(evidence: string): string | null {
  const direct = evidence.match(/(?:^|\s)([A-Za-z0-9_.@/-]+\.[A-Za-z0-9]+)(?::\d+)?(?:\s|$)/);
  if (direct?.[1]) {
    return direct[1];
  }
  const bracketed = evidence.match(/\[([^\]]+\.[A-Za-z0-9]+)(?::\d+)?\]/);
  return bracketed?.[1] ?? null;
}

function highestPriority(
  priorities: readonly ("high" | "medium" | "low")[],
): "high" | "medium" | "low" {
  if (priorities.includes("high")) {
    return "high";
  }
  if (priorities.includes("medium")) {
    return "medium";
  }
  return "low";
}

function priorityConfidence(priority: "high" | "medium" | "low"): number {
  if (priority === "high") {
    return 0.9;
  }
  if (priority === "medium") {
    return 0.7;
  }
  return 0.5;
}

function dedupeDimensions(
  dimensions: readonly EngineeringWorkflowOptionalDimension[],
): readonly EngineeringWorkflowOptionalDimension[] {
  return [...new Map(dimensions.map((dimension) => [dimension.id, dimension])).values()];
}

function dedupeFileRefs(
  refs: readonly EngineeringWorkflowDimensionFileRef[],
): readonly EngineeringWorkflowDimensionFileRef[] {
  return [
    ...new Map(
      refs.map((ref) => [`${ref.dimensionId}\0${ref.filePath}\0${ref.source}`, ref]),
    ).values(),
  ];
}

function isGeneratedPath(filePath: string, generatedArtifactBlacklist: readonly string[]): boolean {
  const generated = new Set(generatedArtifactBlacklist);
  return generated.has(filePath) || isEngineeringGeneratedArtifact(filePath);
}
