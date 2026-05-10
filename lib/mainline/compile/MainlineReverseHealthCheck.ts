import type { MainlineProjectIntelligenceArtifact } from "../graph/index.js";
import type { Recipe, SourceRef } from "../knowledge/index.js";
import { SymbolHealthIndex } from "./SymbolHealthIndex.js";

export type MainlineReverseHealthSignalType =
  | "symbol_missing"
  | "match_rate_drop"
  | "zero_match"
  | "source_ref_stale";

export type MainlineReverseHealthSeverity = "high" | "medium" | "low";
export type MainlineReverseHealthRecommendation = "healthy" | "investigate" | "decay";

export interface MainlineReverseHealthSignal {
  readonly type: MainlineReverseHealthSignalType;
  readonly detail: string;
  readonly severity: MainlineReverseHealthSeverity;
  readonly evidence: {
    readonly expectedSymbol?: string;
    readonly matchRate?: { readonly current: number; readonly historical: number };
    readonly sourceRefIds?: readonly string[];
    readonly paths?: readonly string[];
  };
}

export interface MainlineReverseHealthCheckInput {
  readonly recipe: Recipe;
  readonly projectIntelligence?: MainlineProjectIntelligenceArtifact;
  readonly sourceRefs?: readonly SourceRef[];
  readonly projectFiles?: readonly { path: string; content: string }[];
  readonly historicalGuardHits?: number;
}

export interface MainlineReverseHealthResult {
  readonly recipeId: string;
  readonly title: string;
  readonly signals: readonly MainlineReverseHealthSignal[];
  readonly recommendation: MainlineReverseHealthRecommendation;
}

const SYMBOL_PATTERNS = [
  /\b([A-Z][A-Za-z0-9_]+)\s*[.(]/g,
  /\[\s*([A-Z][A-Za-z0-9_]+)\s+\w/g,
  /(?:import|from)\s+['"]([^'"]+)['"]/g,
  /^\s*#(?:import|include)\s+[<"]([^>"]+)[>"]/gm,
  /\b([a-z][a-z0-9_]+(?:::[A-Z][A-Za-z0-9_]+|\.[A-Z][A-Za-z0-9_]+))/g,
  /@([A-Z][A-Za-z0-9_]+)/g,
] as const;

const DRIFT_THRESHOLDS = {
  INVESTIGATE_HIGH: 1,
  DECAY_HIGH: 2,
  INVESTIGATE_MEDIUM: 3,
} as const;

/**
 * MainlineReverseHealthCheck 是报告型 Recipe→Code 健康检查。
 * 它复用旧 ReverseGuard 的符号、pattern 和 SourceRef 判断，但不会发信号或提交提案。
 */
export class MainlineReverseHealthCheck {
  check(input: MainlineReverseHealthCheckInput): MainlineReverseHealthResult {
    const signals = [
      ...symbolDriftSignals(input.recipe, input.projectIntelligence),
      ...guardPatternSignals(input.recipe, input.projectFiles ?? [], input.historicalGuardHits),
      ...sourceRefSignals(input.recipe, input.sourceRefs ?? []),
    ];

    return {
      recipeId: input.recipe.id,
      title: input.recipe.title,
      signals,
      recommendation: recommendReverseHealth(signals),
    };
  }
}

export function extractMainlineReverseHealthSymbols(coreCode: string): Set<string> {
  const symbols = new Set<string>();
  for (const pattern of SYMBOL_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match = re.exec(coreCode);
    while (match !== null) {
      const symbol = match[1];
      if (!symbol || symbol.length < 3) {
        match = re.exec(coreCode);
        continue;
      }
      if (/^[a-z]+$/.test(symbol) && symbol.length < 6) {
        match = re.exec(coreCode);
        continue;
      }
      symbols.add(symbol);
      match = re.exec(coreCode);
    }
  }
  return symbols;
}

export function recommendReverseHealth(
  signals: readonly Pick<MainlineReverseHealthSignal, "severity">[],
): MainlineReverseHealthRecommendation {
  if (signals.length === 0) {
    return "healthy";
  }
  const highCount = signals.filter((signal) => signal.severity === "high").length;
  const mediumCount = signals.filter((signal) => signal.severity === "medium").length;
  if (highCount >= DRIFT_THRESHOLDS.DECAY_HIGH) {
    return "decay";
  }
  if (highCount >= DRIFT_THRESHOLDS.INVESTIGATE_HIGH) {
    return "investigate";
  }
  if (mediumCount >= DRIFT_THRESHOLDS.INVESTIGATE_MEDIUM) {
    return "investigate";
  }
  return "healthy";
}

function symbolDriftSignals(
  recipe: Recipe,
  artifact: MainlineProjectIntelligenceArtifact | undefined,
): MainlineReverseHealthSignal[] {
  const coreCode = recipe.knowledge?.delivery.coreCode ?? "";
  if (!coreCode.trim() || !artifact) {
    return [];
  }
  const symbols = extractMainlineReverseHealthSymbols(coreCode);
  if (symbols.size === 0) {
    return [];
  }
  const healthIndex = new SymbolHealthIndex(artifact);
  return [...symbols]
    .filter((symbol) => !healthIndex.referenceExists(symbol))
    .map((symbol) => ({
      type: "symbol_missing" as const,
      detail: `Symbol "${symbol}" referenced in Recipe coreCode was not found in ProjectIntelligence.`,
      severity: "high" as const,
      evidence: { expectedSymbol: symbol },
    }));
}

function guardPatternSignals(
  recipe: Recipe,
  projectFiles: readonly { path: string; content: string }[],
  historicalGuardHits: number | undefined,
): MainlineReverseHealthSignal[] {
  if (projectFiles.length === 0) {
    return [];
  }
  const patterns = extractGuardPatterns(recipe);
  const historical = historicalGuardHits ?? recipe.knowledge?.usage.guardHits ?? 0;
  const signals: MainlineReverseHealthSignal[] = [];

  for (const pattern of patterns) {
    const regex = safeRegex(pattern);
    if (!regex) {
      continue;
    }
    const current = countMatches(regex, projectFiles);
    if (current === 0) {
      signals.push({
        type: "zero_match",
        detail: `Guard pattern matches 0 times across ${projectFiles.length} files.`,
        severity: "high",
        evidence: { matchRate: { current, historical } },
      });
      continue;
    }
    if (historical > 0 && current / historical < 0.3) {
      signals.push({
        type: "match_rate_drop",
        detail: `Guard pattern match count dropped to ${current}/${historical}.`,
        severity: "medium",
        evidence: { matchRate: { current, historical } },
      });
    }
  }

  return signals;
}

function sourceRefSignals(
  recipe: Recipe,
  sourceRefs: readonly SourceRef[],
): MainlineReverseHealthSignal[] {
  const recipeSourceRefIds = new Set(recipe.sourceRefIds);
  const degraded = sourceRefs.filter(
    (sourceRef) =>
      recipeSourceRefIds.has(sourceRef.id) &&
      (sourceRef.status === "stale" ||
        sourceRef.status === "missing" ||
        sourceRef.status === "unknown"),
  );
  if (degraded.length === 0) {
    return [];
  }
  const missingCount = degraded.filter((sourceRef) => sourceRef.status === "missing").length;
  return [
    {
      type: "source_ref_stale",
      detail: `${degraded.length} SourceRef(s) are stale, missing, or unverified.`,
      severity: degraded.length >= 3 || missingCount > 0 ? "high" : "medium",
      evidence: {
        sourceRefIds: degraded.map((sourceRef) => sourceRef.id),
        paths: degraded.map((sourceRef) => sourceRef.location.path),
      },
    },
  ];
}

function extractGuardPatterns(recipe: Recipe): string[] {
  const guards = recipe.knowledge?.constraints.guards ?? [];
  const patterns = guards.flatMap((guard) =>
    ["pattern", "regex", "guardPattern"].flatMap((key) => {
      const value = guard[key];
      return typeof value === "string" && value.trim() ? [value.trim()] : [];
    }),
  );
  const metadataPattern = readNestedString(recipe.metadata, [
    "legacyKnowledgeEntry",
    "full",
    "guardPattern",
  ]);
  return [...new Set([...patterns, ...(metadataPattern ? [metadataPattern] : [])])];
}

function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "gm");
  } catch {
    return null;
  }
}

function countMatches(
  regex: RegExp,
  projectFiles: readonly { path: string; content: string }[],
): number {
  let count = 0;
  for (const file of projectFiles) {
    regex.lastIndex = 0;
    count += file.content.match(regex)?.length ?? 0;
  }
  return count;
}

function readNestedString(value: unknown, path: readonly string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}
