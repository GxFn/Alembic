import type {
  ConditionalDimensionLensId,
  CoreDimensionLensId,
  DimensionLensActivation,
  DimensionLensId,
  EvidencePackage,
  SourceRef,
} from "../knowledge/index.js";

export const CORE_DIMENSION_LENS_IDS = [
  "project-shape",
  "coding-contract",
  "agent-guidelines",
  "quality-safety",
  "recipe-relations",
] as const satisfies readonly CoreDimensionLensId[];

export const CONDITIONAL_DIMENSION_LENS_IDS = [
  "ui-interaction",
  "networking-api",
  "persistence-data",
  "concurrency-async",
  "security-auth",
  "performance",
  "observability",
  "release-deploy",
] as const satisfies readonly ConditionalDimensionLensId[];

interface ConditionalLensRule {
  readonly lensId: ConditionalDimensionLensId;
  readonly keywords: RegExp;
}

interface EvidenceSignal {
  readonly channel: "changedFiles" | "sourceRefs" | "notes";
  readonly value: string;
}

const CORE_LENS_REASONS: Record<CoreDimensionLensId, string> = {
  "project-shape": "Core lens for project structure, module boundaries, and dependency direction.",
  "coding-contract": "Core lens for interfaces, data flow, naming, and error-handling contracts.",
  "agent-guidelines": "Core lens for safe agent edits, command choices, and validation workflow.",
  "quality-safety": "Core lens for tests, build risk, permissions, and safety boundaries.",
  "recipe-relations": "Core lens for mining RecipeEdge relationships from shared evidence.",
};

const CONDITIONAL_LENS_RULES: readonly ConditionalLensRule[] = [
  {
    lensId: "ui-interaction",
    keywords:
      /\b(ui|views?|components?|screens?|pages?|swiftui|tsx|jsx|css|scss|buttons?|forms?|layout)\b/,
  },
  {
    lensId: "networking-api",
    keywords:
      /\b(api|https?|fetch|axios|endpoints?|routes?|graphql|websockets?|sockets?|clients?|rest|request|response)\b/,
  },
  {
    lensId: "persistence-data",
    keywords:
      /\b(db|data|database|migrations?|repositories?|schemas?|models?|store|storage|cache|sqlite|postgres|prisma|persistence|persists?|persisted)\b/,
  },
  {
    lensId: "concurrency-async",
    keywords:
      /\b(async|promises?|queues?|workers?|jobs?|scheduler|threads?|mutex|lock|parallel|concurrent)\b/,
  },
  {
    lensId: "security-auth",
    keywords:
      /\b(auth|oauth|permissions?|sandbox|secrets?|tokens?|credentials?|crypto|security|acl|login)\b/,
  },
  {
    lensId: "performance",
    keywords:
      /\b(perf|performance|latency|benchmarks?|profiling|profile|memory|cpu|throughput|slow|speed)\b/,
  },
  {
    lensId: "observability",
    keywords: /\b(logs?|logging|metrics?|telemetry|traces?|tracing|audit|diagnostics?)\b/,
  },
  {
    lensId: "release-deploy",
    keywords:
      /\b(releases?|deploy|deployment|ci|cd|workflows?|docker|k8s|publish|version|changelog)\b/,
  },
];

const CORE_DIMENSION_LENS_ID_SET = new Set<string>(CORE_DIMENSION_LENS_IDS);

export function isCoreDimensionLensId(lensId: DimensionLensId): lensId is CoreDimensionLensId {
  return CORE_DIMENSION_LENS_ID_SET.has(lensId);
}

export function isConditionalDimensionLensId(
  lensId: DimensionLensId,
): lensId is ConditionalDimensionLensId {
  return CONDITIONAL_DIMENSION_LENS_IDS.includes(lensId as ConditionalDimensionLensId);
}

export class DimensionLensPolicy {
  /**
   * 只从已经归一化的 evidence 中激活 lens。
   * 中文注释：这里避免 file IO、Wiki generation、ToolForge 和 ReverseGuard，
   * 因此可以无副作用地运行在编译期主线里。
   */
  activate(evidencePackage: EvidencePackage): DimensionLensActivation[] {
    const activations: DimensionLensActivation[] = CORE_DIMENSION_LENS_IDS.map((lensId) => ({
      lensId,
      reason: CORE_LENS_REASONS[lensId],
      confidence: 1,
    }));
    const signals = collectEvidenceSignals(evidencePackage);

    for (const rule of CONDITIONAL_LENS_RULES) {
      const matchedSignals = signals.filter((signal) =>
        rule.keywords.test(signal.value.toLowerCase()),
      );
      if (matchedSignals.length === 0) {
        continue;
      }

      activations.push({
        lensId: rule.lensId,
        reason: `Matched ${formatSignalList(matchedSignals)} in changedFiles/sourceRefs/notes.`,
        confidence: Math.min(0.95, 0.7 + matchedSignals.length * 0.05),
      });
    }

    return activations;
  }
}

function collectEvidenceSignals(evidencePackage: EvidencePackage): EvidenceSignal[] {
  return [
    ...evidencePackage.changedFiles.map((value) => evidenceSignal("changedFiles", value)),
    ...evidencePackage.sourceRefs.flatMap(sourceRefSignals),
    ...evidencePackage.notes.map((value) => evidenceSignal("notes", value)),
  ].filter((signal) => signal.value.length > 0);
}

function sourceRefSignals(sourceRef: SourceRef): EvidenceSignal[] {
  return [
    evidenceSignal("sourceRefs", sourceRef.kind),
    evidenceSignal("sourceRefs", sourceRef.location.path),
    evidenceSignal("sourceRefs", sourceRef.location.symbol ?? ""),
    evidenceSignal("sourceRefs", sourceRef.summary ?? ""),
  ];
}

function evidenceSignal(channel: EvidenceSignal["channel"], value: string): EvidenceSignal {
  return { channel, value: value.trim() };
}

function formatSignalList(signals: readonly EvidenceSignal[]): string {
  return signals
    .slice(0, 3)
    .map((signal) => `${signal.channel}:${signal.value}`)
    .join(", ");
}
