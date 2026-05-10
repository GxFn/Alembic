import { normalizeMainlinePosixPath } from "../core/index.js";
import type {
  MainlineProjectIntelligenceArtifact,
  MainlineProjectIntelligenceSymbol,
} from "../graph/index.js";
import type { Recipe, SourceRef, SourceRefStatus } from "../knowledge/index.js";
import { extractMainlineReverseHealthSymbols } from "./MainlineReverseHealthCheck.js";
import { type MainlineSymbolHealthStatus, SymbolHealthIndex } from "./SymbolHealthIndex.js";

export type MainlineRecipeEvidenceSource =
  | "source-ref"
  | "reasoning-source"
  | "source-file"
  | "core-code";

export interface MainlineRecipeFileEvidence {
  readonly path: string;
  readonly status: MainlineSymbolHealthStatus;
  readonly source: MainlineRecipeEvidenceSource;
  readonly strength: number;
  readonly sourceRefIds: readonly string[];
}

export interface MainlineRecipeSymbolEvidence {
  readonly symbolId: string;
  readonly fqn: string;
  readonly name: string;
  readonly path: string;
  readonly status: MainlineSymbolHealthStatus;
  readonly source: MainlineRecipeEvidenceSource;
  readonly strength: number;
  readonly sourceRefIds: readonly string[];
}

export interface MainlineRecipeUnresolvedEvidence {
  readonly query: string;
  readonly kind: "file" | "symbol";
  readonly source: MainlineRecipeEvidenceSource;
  readonly reason: string;
}

export interface MainlineRecipeEvidenceLink {
  readonly recipeId: string;
  readonly title: string;
  readonly evidenceScore: number;
  readonly files: readonly MainlineRecipeFileEvidence[];
  readonly symbols: readonly MainlineRecipeSymbolEvidence[];
  readonly unresolved: readonly MainlineRecipeUnresolvedEvidence[];
}

export interface MainlineRecipeEvidenceLinkSummary {
  readonly recipeCount: number;
  readonly linkedRecipeCount: number;
  readonly unlinkedRecipeCount: number;
  readonly fileLinkCount: number;
  readonly symbolLinkCount: number;
  readonly unresolvedCount: number;
}

export interface MainlineRecipeEvidenceLinkReport {
  readonly recipes: readonly MainlineRecipeEvidenceLink[];
  readonly summary: MainlineRecipeEvidenceLinkSummary;
}

export interface MainlineRecipeEvidenceLinkRequest {
  readonly recipes: readonly Recipe[];
  readonly projectIntelligence: MainlineProjectIntelligenceArtifact;
  readonly sourceRefs?: readonly SourceRef[];
}

interface EvidenceAccumulator {
  readonly files: Map<string, MainlineRecipeFileEvidence>;
  readonly symbols: Map<string, MainlineRecipeSymbolEvidence>;
  readonly unresolved: Map<string, MainlineRecipeUnresolvedEvidence>;
}

/**
 * RecipeEvidenceLinker 把统一 Recipe 与 ProjectIntelligence 事实对齐。
 * 它直接消费 sourceRefIds、reasoning.sources、sourceFile 和 coreCode token，
 * 输出证据强度报告，不改 Recipe，不写 Markdown。
 */
export class RecipeEvidenceLinker {
  link(request: MainlineRecipeEvidenceLinkRequest): MainlineRecipeEvidenceLinkReport {
    const sourceRefs = new Map(
      (request.sourceRefs ?? []).map((sourceRef) => [sourceRef.id, sourceRef]),
    );
    const healthIndex = new SymbolHealthIndex(request.projectIntelligence);
    const recipes = request.recipes.map((recipe) =>
      linkRecipeEvidence(recipe, healthIndex, sourceRefs),
    );

    return {
      recipes,
      summary: {
        recipeCount: recipes.length,
        linkedRecipeCount: recipes.filter((recipe) => recipe.evidenceScore > 0).length,
        unlinkedRecipeCount: recipes.filter((recipe) => recipe.evidenceScore === 0).length,
        fileLinkCount: recipes.reduce((sum, recipe) => sum + recipe.files.length, 0),
        symbolLinkCount: recipes.reduce((sum, recipe) => sum + recipe.symbols.length, 0),
        unresolvedCount: recipes.reduce((sum, recipe) => sum + recipe.unresolved.length, 0),
      },
    };
  }
}

export function linkMainlineRecipeEvidence(
  request: MainlineRecipeEvidenceLinkRequest,
): MainlineRecipeEvidenceLinkReport {
  return new RecipeEvidenceLinker().link(request);
}

function linkRecipeEvidence(
  recipe: Recipe,
  healthIndex: SymbolHealthIndex,
  sourceRefs: ReadonlyMap<string, SourceRef>,
): MainlineRecipeEvidenceLink {
  const accumulator: EvidenceAccumulator = {
    files: new Map(),
    symbols: new Map(),
    unresolved: new Map(),
  };

  for (const sourceRefId of recipe.sourceRefIds) {
    const sourceRef = sourceRefs.get(sourceRefId);
    if (sourceRef) {
      const strength = sourceRefStrength(sourceRef.status);
      addFileEvidence(accumulator, healthIndex, sourceRef.location.path, "source-ref", strength, [
        sourceRef.id,
      ]);
      const symbolQuery = sourceRef.location.symbol ?? symbolQueryFromSourceRefId(sourceRef.id);
      if (sourceRef.kind === "symbol" || symbolQuery) {
        addSymbolEvidence(
          accumulator,
          healthIndex,
          symbolQuery ?? sourceRef.id,
          "source-ref",
          strength,
          [sourceRef.id],
        );
      }
      continue;
    }

    if (looksLikeSymbolQuery(sourceRefId)) {
      addSymbolEvidence(accumulator, healthIndex, sourceRefId, "source-ref", 0.75, [sourceRefId]);
    } else {
      addFileEvidence(accumulator, healthIndex, sourceRefId, "source-ref", 0.75, [sourceRefId]);
    }
  }

  for (const source of recipe.knowledge?.reasoning.sources ?? []) {
    const parsed = parseEvidenceSource(source);
    if (parsed.path) {
      addFileEvidence(accumulator, healthIndex, parsed.path, "reasoning-source", 0.7, []);
    }
    if (parsed.symbol) {
      addSymbolEvidence(accumulator, healthIndex, parsed.symbol, "reasoning-source", 0.65, []);
    }
  }

  const sourceFile = recipe.knowledge?.source.sourceFile;
  if (sourceFile) {
    addFileEvidence(accumulator, healthIndex, sourceFile, "source-file", 0.7, []);
  }

  for (const symbol of extractMainlineReverseHealthSymbols(
    recipe.knowledge?.delivery.coreCode ?? "",
  )) {
    addSymbolEvidence(accumulator, healthIndex, symbol, "core-code", 0.55, []);
  }

  const files = [...accumulator.files.values()].sort(
    (left, right) =>
      right.strength - left.strength ||
      left.path.localeCompare(right.path) ||
      left.source.localeCompare(right.source),
  );
  const symbols = [...accumulator.symbols.values()].sort(
    (left, right) =>
      right.strength - left.strength ||
      left.path.localeCompare(right.path) ||
      left.fqn.localeCompare(right.fqn),
  );
  const unresolved = [...accumulator.unresolved.values()].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.query.localeCompare(right.query) ||
      left.source.localeCompare(right.source),
  );

  return {
    recipeId: recipe.id,
    title: recipe.title,
    evidenceScore: evidenceScore(files, symbols),
    files,
    symbols,
    unresolved,
  };
}

function addFileEvidence(
  accumulator: EvidenceAccumulator,
  healthIndex: SymbolHealthIndex,
  query: string,
  source: MainlineRecipeEvidenceSource,
  strength: number,
  sourceRefIds: readonly string[],
): void {
  const result = healthIndex.file(query);
  if (result.status === "missing") {
    addUnresolved(accumulator, query, "file", source, result.reason);
    return;
  }
  const candidates =
    result.candidates.length > 0 ? result.candidates : result.file ? [result.file] : [];
  for (const file of candidates) {
    upsertFileEvidence(accumulator, {
      path: file.path,
      status: result.status,
      source,
      strength: adjustedStrength(strength, result.status),
      sourceRefIds,
    });
  }
}

function addSymbolEvidence(
  accumulator: EvidenceAccumulator,
  healthIndex: SymbolHealthIndex,
  query: string,
  source: MainlineRecipeEvidenceSource,
  strength: number,
  sourceRefIds: readonly string[],
): void {
  const result = healthIndex.symbol(query);
  if (result.status === "missing") {
    addUnresolved(accumulator, query, "symbol", source, result.reason);
    return;
  }
  for (const symbol of result.symbols) {
    upsertSymbolEvidence(accumulator, symbol, result.status, source, strength, sourceRefIds);
  }
}

function upsertFileEvidence(
  accumulator: EvidenceAccumulator,
  evidence: MainlineRecipeFileEvidence,
): void {
  const key = `${evidence.path}\u0000${evidence.source}`;
  const current = accumulator.files.get(key);
  if (!current || evidence.strength > current.strength) {
    accumulator.files.set(key, {
      ...evidence,
      strength: roundStrength(evidence.strength),
      sourceRefIds: mergeSourceRefIds(current?.sourceRefIds ?? [], evidence.sourceRefIds),
    });
  }
}

function upsertSymbolEvidence(
  accumulator: EvidenceAccumulator,
  symbol: MainlineProjectIntelligenceSymbol,
  status: MainlineSymbolHealthStatus,
  source: MainlineRecipeEvidenceSource,
  strength: number,
  sourceRefIds: readonly string[],
): void {
  const key = `${symbol.id}\u0000${source}`;
  const current = accumulator.symbols.get(key);
  const nextStrength = adjustedStrength(strength, status);
  if (!current || nextStrength > current.strength) {
    accumulator.symbols.set(key, {
      symbolId: symbol.id,
      fqn: symbol.fqn,
      name: symbol.name,
      path: symbol.file,
      status,
      source,
      strength: roundStrength(nextStrength),
      sourceRefIds: mergeSourceRefIds(current?.sourceRefIds ?? [], sourceRefIds),
    });
  }
}

function addUnresolved(
  accumulator: EvidenceAccumulator,
  query: string,
  kind: MainlineRecipeUnresolvedEvidence["kind"],
  source: MainlineRecipeEvidenceSource,
  reason: string,
): void {
  const key = `${kind}\u0000${source}\u0000${query}`;
  accumulator.unresolved.set(key, { query, kind, source, reason });
}

function sourceRefStrength(status: SourceRefStatus): number {
  switch (status) {
    case "active":
    case "renamed":
      return 1;
    case "unknown":
      return 0.55;
    case "stale":
      return 0.25;
    case "missing":
      return 0.1;
    case "repaired":
      return 0.85;
  }
}

function adjustedStrength(strength: number, status: MainlineSymbolHealthStatus): number {
  switch (status) {
    case "present":
      return strength;
    case "moved":
      return strength * 0.75;
    case "ambiguous":
      return strength * 0.6;
    case "missing":
      return 0;
  }
}

function evidenceScore(
  files: readonly Pick<MainlineRecipeFileEvidence, "strength">[],
  symbols: readonly Pick<MainlineRecipeSymbolEvidence, "strength">[],
): number {
  return roundStrength(
    Math.max(0, ...files.map((file) => file.strength), ...symbols.map((symbol) => symbol.strength)),
  );
}

function parseEvidenceSource(source: string): { readonly path?: string; readonly symbol?: string } {
  const trimmed = source.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return {};
  }
  if (trimmed.startsWith("symbol:")) {
    return { symbol: trimmed };
  }
  const hashIndex = trimmed.indexOf("#");
  const pathPart = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const symbolPart = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : "";
  const pathWithoutLine = pathPart.replace(/:\d+(?::\d+)?$/, "");
  const normalizedPath = normalizeMainlinePosixPath(pathWithoutLine.replace(/^(file|diff):/, ""));
  const symbol =
    symbolPart.trim() && normalizedPath
      ? `${normalizedPath}::${symbolPart.trim()}`
      : symbolPart.trim();
  return {
    ...(normalizedPath ? { path: normalizedPath } : {}),
    ...(symbol ? { symbol } : {}),
  };
}

function symbolQueryFromSourceRefId(sourceRefId: string): string | undefined {
  if (!looksLikeSymbolQuery(sourceRefId)) {
    return undefined;
  }
  return sourceRefId;
}

function looksLikeSymbolQuery(value: string): boolean {
  return value.startsWith("symbol:") || value.includes("::") || value.includes("#");
}

function mergeSourceRefIds(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right].filter(Boolean))].sort();
}

function roundStrength(value: number): number {
  return Math.round(value * 1000) / 1000;
}
