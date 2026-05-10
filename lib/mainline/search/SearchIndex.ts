import { normalizeMainlinePosixPath, uniqueMainlinePosixPaths } from "../core/PathIdentity.js";
import { mainlineTextSimilarity } from "../core/TextAnalysis.js";
import { MainlineFieldWeightedScorer } from "./FieldWeightedScorer.js";
import { tokenizeMainlineSearchText } from "./TextTokenizer.js";

export type MainlineSearchDocumentKind =
  | "recipe"
  | "source-ref"
  | "symbol"
  | "file"
  | "note"
  | "graph-node";

export interface MainlineSearchDocument {
  readonly id: string;
  readonly kind: MainlineSearchDocumentKind;
  readonly title?: string;
  readonly body?: string;
  readonly path?: string;
  readonly symbol?: string;
  readonly tags?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

export interface MainlineSearchQuery {
  readonly text?: string;
  readonly paths?: readonly string[];
  readonly symbols?: readonly string[];
  readonly kinds?: readonly MainlineSearchDocumentKind[];
  readonly limit?: number;
}

export interface MainlineSearchHitMeta {
  readonly topGap: number;
  readonly exactTitleMatch: boolean;
  readonly exactTriggerMatch: boolean;
  readonly codeQuery: boolean;
  readonly naturalLanguageQuery: boolean;
}

export interface MainlineSearchHit {
  readonly document: MainlineSearchDocument;
  readonly score: number;
  readonly confidence: number;
  readonly reasons: string[];
  readonly meta: MainlineSearchHitMeta;
}

/**
 * MainlineSearchIndex 是新主干的轻量搜索底座。
 * 它只接收调用方投影好的结构化文档，运行期不扫 Markdown，也不接旧 SearchEngine 或向量实现。
 */
export interface MainlineSearchIndex {
  upsert(documents: readonly MainlineSearchDocument[]): void;
  remove(documentIds: readonly string[]): void;
  search(query: MainlineSearchQuery): MainlineSearchHit[];
  snapshot(): MainlineSearchDocument[];
}

export class InMemoryMainlineSearchIndex implements MainlineSearchIndex {
  readonly #documents = new Map<string, MainlineSearchDocument>();

  upsert(documents: readonly MainlineSearchDocument[]): void {
    for (const document of documents) {
      this.#documents.set(document.id, normalizeDocument(document));
    }
  }

  remove(documentIds: readonly string[]): void {
    for (const documentId of documentIds) {
      this.#documents.delete(documentId);
    }
  }

  clear(): void {
    this.#documents.clear();
  }

  search(query: MainlineSearchQuery): MainlineSearchHit[] {
    const limit = query.limit ?? 20;
    const kinds = query.kinds ? new Set(query.kinds) : null;
    const queryText = query.text ?? "";
    const queryTokens = tokenizeMainlineSearchText(queryText);
    const queryPaths = uniqueMainlinePosixPaths(query.paths ?? []);
    const querySymbols = uniqueStrings(query.symbols ?? []);
    const queryProfile = classifyQuery(queryText, queryPaths, querySymbols);
    const hits: MainlineSearchHit[] = [];
    const scorer = new MainlineFieldWeightedScorer([...this.#documents.values()]);

    for (const document of this.#documents.values()) {
      if (kinds && !kinds.has(document.kind)) {
        continue;
      }
      const hit = scoreDocument(document, scorer, {
        queryText,
        queryTokens,
        queryPaths,
        querySymbols,
        queryProfile,
      });
      if (hit.score > 0 || isEmptyQuery(queryTokens, queryPaths, querySymbols)) {
        hits.push(hit);
      }
    }

    const sortedHits = hits.sort(
      (left, right) =>
        right.score - left.score || left.document.id.localeCompare(right.document.id),
    );
    const topScore = sortedHits[0]?.score ?? 0;
    const topGap = Math.max(0, topScore - (sortedHits[1]?.score ?? 0));

    return sortedHits
      .map((hit) => ({
        ...hit,
        confidence: searchHitConfidence(hit, topScore, topGap),
        meta: { ...hit.meta, topGap },
      }))
      .slice(0, limit);
  }

  snapshot(): MainlineSearchDocument[] {
    // 快照只序列化已经 upsert 的结构化文档，不从 Markdown 目录重新扫描，保证恢复路径确定且可测试。
    return [...this.#documents.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
}

interface ScoreInput {
  readonly queryText: string;
  readonly queryTokens: readonly string[];
  readonly queryPaths: readonly string[];
  readonly querySymbols: readonly string[];
  readonly queryProfile: QueryProfile;
}

interface QueryProfile {
  readonly codeQuery: boolean;
  readonly naturalLanguageQuery: boolean;
}

function scoreDocument(
  document: MainlineSearchDocument,
  scorer: MainlineFieldWeightedScorer,
  input: ScoreInput,
): MainlineSearchHit {
  const weightedScore = scorer.score(document, input.queryText);
  let score = weightedScore.score;
  const reasons: string[] = [...weightedScore.reasons];
  const exactTitleMatch = exactStringMatch(document.title, input.queryText);
  const exactTriggerMatch = exactStringMatch(metadataString(document, "trigger"), input.queryText);
  const searchableText = [
    metadataString(document, "trigger"),
    document.title,
    metadataString(document, "summary"),
    metadataString(document, "description"),
    document.body,
    document.path,
    document.symbol,
    ...(document.tags ?? []),
  ]
    .filter(Boolean)
    .join("\n");
  const documentTokens = new Set(tokenizeMainlineSearchText(searchableText));

  if (exactTitleMatch) {
    score += 3;
    reasons.push("title:exact");
  }

  if (exactTriggerMatch) {
    score += 5;
    reasons.push("trigger:exact");
  }

  for (const token of input.queryTokens) {
    if (documentTokens.has(token)) {
      score += document.title?.toLowerCase().includes(token) ? 0.4 : 0.1;
      reasons.push(`token:${token}`);
    }
  }

  for (const pathQuery of input.queryPaths) {
    const pathScore = scorePath(document.path, pathQuery);
    if (pathScore > 0) {
      score += pathScore;
      reasons.push(`path:${pathQuery}`);
    }
  }

  for (const symbolQuery of input.querySymbols) {
    const symbolScore = scoreSymbol(document.symbol, symbolQuery);
    if (symbolScore > 0) {
      score += symbolScore;
      reasons.push(`symbol:${symbolQuery}`);
    }
  }

  if (score === 0 && input.queryTokens.length > 0) {
    const similarity = mainlineTextSimilarity(input.queryTokens.join(" "), searchableText, {
      substringBonus: true,
    });
    if (similarity >= 0.35) {
      score += similarity;
      reasons.push("similarity");
    }
  }

  return {
    document,
    score,
    confidence: 0,
    reasons: [...new Set(reasons)],
    meta: {
      topGap: 0,
      exactTitleMatch,
      exactTriggerMatch,
      codeQuery: input.queryProfile.codeQuery,
      naturalLanguageQuery: input.queryProfile.naturalLanguageQuery,
    },
  };
}

function searchHitConfidence(hit: MainlineSearchHit, topScore: number, topGap: number): number {
  if (hit.score <= 0) {
    return 0;
  }
  const relativeScore = topScore > 0 ? hit.score / topScore : 0;
  const gapSignal = topScore > 0 ? Math.min(topGap / topScore, 1) : 0;
  const exactSignal = hit.meta.exactTriggerMatch ? 0.15 : hit.meta.exactTitleMatch ? 0.1 : 0;
  // 主线只输出轻量启发式置信度：相对分、第一名间距和精确命中共同决定。
  return roundConfidence(0.25 + relativeScore * 0.45 + gapSignal * 0.15 + exactSignal);
}

function scorePath(pathValue: string | undefined, pathQuery: string): number {
  if (!pathValue) {
    return 0;
  }
  const normalizedPath = normalizeMainlinePosixPath(pathValue);
  if (normalizedPath === pathQuery) {
    return 8;
  }
  if (normalizedPath.endsWith(`/${pathQuery}`) || normalizedPath.includes(pathQuery)) {
    return 4;
  }
  return 0;
}

function scoreSymbol(symbolValue: string | undefined, symbolQuery: string): number {
  if (!symbolValue) {
    return 0;
  }
  const normalizedSymbol = symbolValue.toLowerCase();
  const normalizedQuery = symbolQuery.toLowerCase();
  if (normalizedSymbol === normalizedQuery) {
    return 7;
  }
  if (normalizedSymbol.includes(normalizedQuery)) {
    return 3;
  }
  return 0;
}

function normalizeDocument(document: MainlineSearchDocument): MainlineSearchDocument {
  return {
    ...document,
    ...(document.path ? { path: normalizeMainlinePosixPath(document.path) } : {}),
    ...(document.tags ? { tags: uniqueStrings(document.tags) } : {}),
    ...(document.metadata ? { metadata: { ...document.metadata } } : {}),
  };
}

function classifyQuery(
  queryText: string,
  queryPaths: readonly string[],
  querySymbols: readonly string[],
): QueryProfile {
  const text = queryText.trim();
  const tokens = tokenizeMainlineSearchText(text);
  const codeQuery = Boolean(
    queryPaths.length > 0 ||
      querySymbols.length > 0 ||
      /[`{}()[\]./\\:@#$_-]/.test(text) ||
      /\b[A-Za-z]+[A-Z][A-Za-z0-9]*\b/.test(text) ||
      /\b(?:ts|tsx|js|jsx|swift|kt|java|py|go|rs|sql|json|yaml|md)\b/i.test(text),
  );
  const naturalLanguageQuery = Boolean(
    text &&
      !codeQuery &&
      (tokens.length >= 3 ||
        /[?？]|^(how|why|when|where|what|which|谁|什么|如何|为什么|什么时候|哪里)\b/i.test(text)),
  );
  return { codeQuery, naturalLanguageQuery };
}

function exactStringMatch(value: string | undefined, queryText: string): boolean {
  const normalizedValue = value?.trim().toLowerCase();
  const normalizedQuery = queryText.trim().toLowerCase();
  return Boolean(normalizedValue && normalizedQuery && normalizedValue === normalizedQuery);
}

function roundConfidence(value: number): number {
  return Math.round(Math.max(0, Math.min(value, 1)) * 1000) / 1000;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function metadataString(document: MainlineSearchDocument, key: string): string {
  const value = document.metadata?.[key];
  return typeof value === "string" ? value : "";
}

function isEmptyQuery(
  queryTokens: readonly string[],
  queryPaths: readonly string[],
  querySymbols: readonly string[],
): boolean {
  return queryTokens.length + queryPaths.length + querySymbols.length === 0;
}
