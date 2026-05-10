import path from "node:path";
import { normalizeMainlinePosixPath } from "../core/index.js";
import type {
  MainlineProjectIntelligenceArtifact,
  MainlineProjectIntelligenceFile,
  MainlineProjectIntelligenceSymbol,
} from "../graph/index.js";

export type MainlineSymbolHealthStatus = "present" | "moved" | "ambiguous" | "missing";

export interface MainlineFileHealthResult {
  readonly query: string;
  readonly normalizedPath: string;
  readonly status: MainlineSymbolHealthStatus;
  readonly file?: MainlineProjectIntelligenceFile;
  readonly candidates: readonly MainlineProjectIntelligenceFile[];
  readonly reason: string;
}

export interface MainlineSymbolHealthResult {
  readonly query: string;
  readonly normalizedQuery: string;
  readonly status: MainlineSymbolHealthStatus;
  readonly symbols: readonly MainlineProjectIntelligenceSymbol[];
  readonly reason: string;
}

interface ParsedSymbolQuery {
  readonly raw: string;
  readonly normalized: string;
  readonly filePath?: string;
  readonly symbolName?: string;
}

/**
 * SymbolHealthIndex 是主线里替代旧 CodeEntityRepository 存在性检查的轻量索引。
 * 它只读取 ProjectIntelligence artifact，不写数据库，也不触发额外 AST 扫描。
 */
export class SymbolHealthIndex {
  readonly #artifact: MainlineProjectIntelligenceArtifact;
  readonly #filesByPath: Map<string, MainlineProjectIntelligenceFile>;
  readonly #filesByBasename: Map<string, MainlineProjectIntelligenceFile[]>;
  readonly #symbolsById: Map<string, MainlineProjectIntelligenceSymbol>;
  readonly #symbolsByFqn: Map<string, MainlineProjectIntelligenceSymbol>;
  readonly #symbolsByName: Map<string, MainlineProjectIntelligenceSymbol[]>;

  constructor(artifact: MainlineProjectIntelligenceArtifact) {
    this.#artifact = artifact;
    this.#filesByPath = new Map(artifact.files.map((file) => [file.path, file]));
    this.#filesByBasename = groupBy(artifact.files, (file) => path.posix.basename(file.path));
    this.#symbolsById = new Map(artifact.symbols.map((symbol) => [symbol.id, symbol]));
    this.#symbolsByFqn = new Map(artifact.symbols.map((symbol) => [symbol.fqn, symbol]));
    this.#symbolsByName = groupBy(artifact.symbols, (symbol) => symbol.name);
  }

  file(query: string): MainlineFileHealthResult {
    const normalizedPath = normalizeEvidencePath(query);
    if (!normalizedPath) {
      return {
        query,
        normalizedPath: "",
        status: "missing",
        candidates: [],
        reason: "File query is empty or not a project-relative path.",
      };
    }

    const file = this.#filesByPath.get(normalizedPath);
    if (file) {
      return {
        query,
        normalizedPath,
        status: "present",
        file,
        candidates: [file],
        reason: "Exact file path is present in ProjectIntelligence.",
      };
    }

    const candidates = this.#filesByBasename.get(path.posix.basename(normalizedPath)) ?? [];
    if (candidates.length === 1) {
      const file = candidates[0];
      if (!file) {
        return missingFileResult(query, normalizedPath);
      }
      return {
        query,
        normalizedPath,
        status: "moved",
        file,
        candidates,
        reason: "Exact path is missing, but one file with the same basename exists.",
      };
    }
    if (candidates.length > 1) {
      return {
        query,
        normalizedPath,
        status: "ambiguous",
        candidates,
        reason: "Exact path is missing, and multiple files share the same basename.",
      };
    }

    return missingFileResult(query, normalizedPath);
  }

  symbol(query: string): MainlineSymbolHealthResult {
    const parsed = parseSymbolQuery(query);
    if (!parsed.normalized) {
      return {
        query,
        normalizedQuery: "",
        status: "missing",
        symbols: [],
        reason: "Symbol query is empty.",
      };
    }

    const exactById = this.#symbolsById.get(parsed.normalized);
    if (exactById) {
      return presentSymbolResult(query, parsed.normalized, [exactById], "Exact symbol id exists.");
    }

    const exactByFqn = this.#symbolsByFqn.get(parsed.normalized);
    if (exactByFqn) {
      return presentSymbolResult(
        query,
        parsed.normalized,
        [exactByFqn],
        "Exact symbol fqn exists.",
      );
    }

    const candidates = this.#candidateSymbols(parsed);
    if (candidates.length === 0) {
      return {
        query,
        normalizedQuery: parsed.normalized,
        status: "missing",
        symbols: [],
        reason: "No matching symbol exists in ProjectIntelligence.",
      };
    }

    const sameFileCandidates = parsed.filePath
      ? candidates.filter((symbol) => symbol.file === parsed.filePath)
      : candidates;
    if (sameFileCandidates.length === 1) {
      return presentSymbolResult(
        query,
        parsed.normalized,
        sameFileCandidates,
        "Symbol name exists in the expected file.",
      );
    }
    if (sameFileCandidates.length > 1) {
      return {
        query,
        normalizedQuery: parsed.normalized,
        status: "ambiguous",
        symbols: sortSymbols(sameFileCandidates),
        reason: "Multiple symbols match the query in the expected file.",
      };
    }

    if (parsed.filePath && candidates.length === 1) {
      return {
        query,
        normalizedQuery: parsed.normalized,
        status: "moved",
        symbols: candidates,
        reason: "Symbol name still exists, but not under the expected file path.",
      };
    }

    return {
      query,
      normalizedQuery: parsed.normalized,
      status: "ambiguous",
      symbols: sortSymbols(candidates),
      reason: parsed.filePath
        ? "Symbol name exists in multiple other files."
        : "Multiple symbols match the query.",
    };
  }

  fileExists(query: string): boolean {
    return this.file(query).status !== "missing";
  }

  symbolExists(query: string): boolean {
    return this.symbol(query).status !== "missing";
  }

  referenceExists(query: string): boolean {
    return looksLikePath(query) ? this.fileExists(query) : this.symbolExists(query);
  }

  files(): readonly MainlineProjectIntelligenceFile[] {
    return [...this.#artifact.files];
  }

  symbols(): readonly MainlineProjectIntelligenceSymbol[] {
    return [...this.#artifact.symbols];
  }

  #candidateSymbols(parsed: ParsedSymbolQuery): MainlineProjectIntelligenceSymbol[] {
    const symbolName = parsed.symbolName ?? lastSymbolSegment(parsed.normalized);
    if (!symbolName) {
      return [];
    }
    return sortSymbols(this.#symbolsByName.get(symbolName) ?? []);
  }
}

function presentSymbolResult(
  query: string,
  normalizedQuery: string,
  symbols: readonly MainlineProjectIntelligenceSymbol[],
  reason: string,
): MainlineSymbolHealthResult {
  return {
    query,
    normalizedQuery,
    status: symbols.length > 1 ? "ambiguous" : "present",
    symbols: sortSymbols(symbols),
    reason,
  };
}

function parseSymbolQuery(query: string): ParsedSymbolQuery {
  const raw = query.trim();
  const withoutPrefix = raw.startsWith("symbol:") ? raw.slice("symbol:".length) : raw;
  const normalized = withoutPrefix.replace("#", "::").trim();
  const separator = normalized.includes("::")
    ? normalized.lastIndexOf("::")
    : normalized.lastIndexOf("#");
  const filePath =
    separator > 0 ? normalizeMainlinePosixPath(normalized.slice(0, separator)) : undefined;
  const symbolName = separator > 0 ? lastSymbolSegment(normalized.slice(separator + 2)) : undefined;
  return {
    raw,
    normalized: raw.startsWith("symbol:") ? `symbol:${withoutPrefix}` : normalized,
    ...(filePath === undefined ? {} : { filePath }),
    ...(symbolName === undefined ? {} : { symbolName }),
  };
}

function lastSymbolSegment(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutCall = trimmed.replace(/\(.*/, "");
  return withoutCall
    .split(/[.:#/]/)
    .filter(Boolean)
    .at(-1);
}

function normalizeEvidencePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return "";
  }
  const withoutPrefix = trimmed.replace(/^(file|diff):/, "");
  const withoutLine = withoutPrefix.replace(/:\d+(?::\d+)?$/, "");
  const withoutHash = withoutLine.replace(/#.+$/, "");
  const withoutSymbolPrefix = withoutHash.startsWith("symbol:")
    ? (withoutHash.slice("symbol:".length).split("::")[0] ?? "")
    : withoutHash;
  return normalizeMainlinePosixPath(withoutSymbolPrefix);
}

function missingFileResult(query: string, normalizedPath: string): MainlineFileHealthResult {
  return {
    query,
    normalizedPath,
    status: "missing",
    candidates: [],
    reason: "File path is not present in ProjectIntelligence.",
  };
}

function looksLikePath(query: string): boolean {
  const trimmed = query.trim();
  return (
    trimmed.startsWith("file:") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.includes("/") ||
    /\.[a-z0-9]+(?::\d+)?$/i.test(trimmed)
  );
}

function sortSymbols(
  symbols: readonly MainlineProjectIntelligenceSymbol[],
): MainlineProjectIntelligenceSymbol[] {
  return [...symbols].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.fqn.localeCompare(right.fqn) ||
      left.id.localeCompare(right.id),
  );
}

function groupBy<T>(items: readonly T[], keyFor: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}
