export interface MainlineRankedSearchHit {
  readonly id: string;
  readonly score: number;
  readonly source?: string;
}

export interface MainlineFusedSearchHit {
  readonly id: string;
  readonly score: number;
  readonly sources: string[];
  readonly ranks: Record<string, number>;
}

export interface MainlineRrfOptions {
  readonly k?: number;
  readonly limit?: number;
}

/**
 * Reciprocal Rank Fusion。
 * 新主干只把它作为纯排序工具：稀疏、向量或图谱召回都先各自产生稳定排名，
 * 这里按 rank 融合，不泄露旧 SearchEngine 的内部多信号状态。
 */
export function fuseMainlineRankedHits(
  rankedLists: readonly (readonly MainlineRankedSearchHit[])[],
  options: MainlineRrfOptions = {},
): MainlineFusedSearchHit[] {
  const k = options.k ?? 60;
  const fused = new Map<string, MainlineFusedSearchHit>();

  for (let listIndex = 0; listIndex < rankedLists.length; listIndex++) {
    const list = rankedLists[listIndex] ?? [];
    const source = list[0]?.source ?? `source-${listIndex + 1}`;
    for (let hitIndex = 0; hitIndex < list.length; hitIndex++) {
      const hit = list[hitIndex];
      if (!hit) {
        continue;
      }
      const rank = hitIndex + 1;
      const existing = fused.get(hit.id);
      const rankScore = 1 / (k + rank);
      fused.set(hit.id, {
        id: hit.id,
        score: (existing?.score ?? 0) + rankScore,
        sources: [...new Set([...(existing?.sources ?? []), hit.source ?? source])],
        ranks: {
          ...(existing?.ranks ?? {}),
          [hit.source ?? source]: rank,
        },
      });
    }
  }

  return [...fused.values()]
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, options.limit ?? Number.POSITIVE_INFINITY);
}
