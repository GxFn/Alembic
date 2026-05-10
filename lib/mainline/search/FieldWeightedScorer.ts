import type { MainlineSearchDocument } from "./SearchIndex.js";
import { tokenizeMainlineSearchText } from "./TextTokenizer.js";

export interface MainlineFieldWeights {
  readonly trigger: number;
  readonly title: number;
  readonly tags: number;
  readonly summary: number;
  readonly body: number;
  readonly symbol: number;
  readonly path: number;
  readonly facets: number;
}

export interface MainlineWeightedScore {
  readonly score: number;
  readonly reasons: string[];
}

export const DEFAULT_MAINLINE_FIELD_WEIGHTS: MainlineFieldWeights = {
  trigger: 5,
  title: 3,
  tags: 2,
  summary: 1.5,
  body: 1,
  symbol: 2.5,
  path: 0.75,
  facets: 0.5,
};

/**
 * 字段权重评分器。
 * 它只认识主干 `MainlineSearchDocument`，把旧 SearchEngine 的高收益排序经验
 * 迁成纯算法：trigger/title/tag 优先，长文本用 IDF overlap，facet 只作轻量补分。
 */
export class MainlineFieldWeightedScorer {
  readonly #documents: readonly MainlineSearchDocument[];
  readonly #weights: MainlineFieldWeights;
  readonly #docFreq = new Map<string, number>();

  constructor(
    documents: readonly MainlineSearchDocument[],
    weights: MainlineFieldWeights = DEFAULT_MAINLINE_FIELD_WEIGHTS,
  ) {
    this.#documents = documents;
    this.#weights = weights;
    for (const document of documents) {
      for (const token of documentUniqueTokens(document)) {
        this.#docFreq.set(token, (this.#docFreq.get(token) ?? 0) + 1);
      }
    }
  }

  score(document: MainlineSearchDocument, queryText: string): MainlineWeightedScore {
    const queryTokens = tokenizeMainlineSearchText(queryText);
    if (queryTokens.length === 0) {
      return { score: 0, reasons: [] };
    }

    let score = 0;
    const reasons: string[] = [];
    const trigger = metadataString(document, "trigger");
    const summary = metadataString(document, "summary") || metadataString(document, "description");
    const facets = [
      document.kind,
      metadataString(document, "language"),
      metadataString(document, "category"),
      metadataString(document, "knowledgeType"),
    ].filter(Boolean);

    score += this.#scoreStringField(queryText, queryTokens, trigger, "trigger", reasons);
    score += this.#scoreStringField(queryText, queryTokens, document.title ?? "", "title", reasons);
    score += this.#scoreTags(queryTokens, document.tags ?? [], reasons);
    score +=
      this.#weights.summary * this.#scoreTokenField(queryTokens, summary, "summary", reasons);
    score +=
      this.#weights.body * this.#scoreTokenField(queryTokens, document.body ?? "", "body", reasons);
    score +=
      this.#weights.symbol *
      this.#scoreTokenField(queryTokens, document.symbol ?? "", "symbol", reasons);
    score +=
      this.#weights.path * this.#scoreTokenField(queryTokens, document.path ?? "", "path", reasons);
    score += this.#weights.facets * this.#scoreFacet(queryTokens, facets, reasons);

    return {
      score,
      reasons: [...new Set(reasons)],
    };
  }

  #scoreStringField(
    queryText: string,
    queryTokens: readonly string[],
    fieldText: string,
    fieldName: keyof Pick<MainlineFieldWeights, "trigger" | "title">,
    reasons: string[],
  ): number {
    if (!fieldText.trim()) {
      return 0;
    }
    const stringScore = stringMatchScore(queryText, fieldText);
    const tokenScore = tokenOverlap(queryTokens, tokenizeMainlineSearchText(fieldText));
    const fieldScore = Math.max(stringScore, tokenScore);
    if (fieldScore > 0) {
      reasons.push(`${fieldName}:match`);
    }
    return this.#weights[fieldName] * fieldScore;
  }

  #scoreTokenField(
    queryTokens: readonly string[],
    fieldText: string,
    reason: string,
    reasons: string[],
  ): number {
    const score = this.#idfWeightedOverlap(queryTokens, tokenizeMainlineSearchText(fieldText));
    if (score > 0) {
      reasons.push(`${reason}:token`);
    }
    return score;
  }

  #scoreTags(queryTokens: readonly string[], tags: readonly string[], reasons: string[]): number {
    if (tags.length === 0 || queryTokens.length === 0) {
      return 0;
    }
    let matched = 0;
    const querySet = new Set(queryTokens);
    for (const tag of tags) {
      const normalizedTag = tag.toLowerCase();
      if (querySet.has(normalizedTag)) {
        matched += 1;
        continue;
      }
      if (
        tokenizeMainlineSearchText(tag).some(
          (tagToken) =>
            querySet.has(tagToken) || [...querySet].some((query) => tagToken.includes(query)),
        )
      ) {
        matched += 0.5;
      }
    }
    const score = Math.min(matched / queryTokens.length, 1);
    if (score > 0) {
      reasons.push("tags:match");
    }
    return this.#weights.tags * score;
  }

  #scoreFacet(
    queryTokens: readonly string[],
    facets: readonly string[],
    reasons: string[],
  ): number {
    if (facets.length === 0) {
      return 0;
    }
    const querySet = new Set(queryTokens);
    const matched = facets.filter((facet) =>
      tokenizeMainlineSearchText(facet).some((token) => querySet.has(token)),
    ).length;
    const score = matched / facets.length;
    if (score > 0) {
      reasons.push("facets:match");
    }
    return score;
  }

  #idfWeightedOverlap(queryTokens: readonly string[], fieldTokens: readonly string[]): number {
    if (queryTokens.length === 0 || fieldTokens.length === 0) {
      return 0;
    }
    const fieldSet = new Set(fieldTokens);
    let totalIdf = 0;
    let matchedIdf = 0;
    for (const queryToken of queryTokens) {
      const idf = this.#idf(queryToken);
      totalIdf += idf;
      if (fieldSet.has(queryToken)) {
        matchedIdf += idf;
      }
    }
    return totalIdf > 0 ? matchedIdf / totalIdf : 0;
  }

  #idf(token: string): number {
    const documentFrequency = this.#docFreq.get(token) ?? 0;
    return Math.log2(1 + this.#documents.length / (documentFrequency + 1));
  }
}

function stringMatchScore(queryText: string, fieldText: string): number {
  const query = queryText.trim().toLowerCase();
  const field = fieldText.trim().toLowerCase();
  if (!query || !field) {
    return 0;
  }
  if (field === query) {
    return 1;
  }
  if (field.startsWith(query)) {
    return 0.7;
  }
  if (field.includes(query)) {
    return 0.5;
  }
  if (query.includes(field) && field.length > 3) {
    return 0.3;
  }
  return 0;
}

function tokenOverlap(queryTokens: readonly string[], fieldTokens: readonly string[]): number {
  if (queryTokens.length === 0 || fieldTokens.length === 0) {
    return 0;
  }
  const fieldSet = new Set(fieldTokens);
  return queryTokens.filter((token) => fieldSet.has(token)).length / queryTokens.length;
}

function documentUniqueTokens(document: MainlineSearchDocument): string[] {
  return tokenizeMainlineSearchText(
    [
      metadataString(document, "trigger"),
      document.title,
      ...(document.tags ?? []),
      metadataString(document, "summary"),
      metadataString(document, "description"),
      document.body,
      document.symbol,
      document.path,
      document.kind,
      metadataString(document, "language"),
      metadataString(document, "category"),
      metadataString(document, "knowledgeType"),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function metadataString(document: MainlineSearchDocument, key: string): string {
  const value = document.metadata?.[key];
  return typeof value === "string" ? value : "";
}
