/**
 * §10.2 Search wire types — 搜索结果类型拆分
 *
 * 将 SearchResultItem 的 25+ optional 字段拆分为有意义的层次结构。
 * 现有代码可继续使用 SearchResultItem；新代码应使用分层类型。
 */

// ──────────────────────────────────────────────────────────────────
// SearchHitBase — 所有搜索命中的基础形状
// ──────────────────────────────────────────────────────────────────

/** 基础搜索命中 — 无论来源（FieldWeighted / Vector / Context）都具备的字段 */
export interface SearchHitBase {
  id: string;
  title: string;
  trigger: string;
  kind?: string;
  language?: string;
  category?: string;
  knowledgeType?: string;
}

// ──────────────────────────────────────────────────────────────────
// 特化命中类型
// ──────────────────────────────────────────────────────────────────

/** FieldWeighted 命中 — 附带加权分数 */
export interface WeightedHit extends SearchHitBase {
  weightedScore: number;
  matchedTokens?: string[];
}

/** Vector 命中 — 附带向量相似度 */
export interface VectorHit extends SearchHitBase {
  vectorScore: number;
  embeddingModel?: string;
}

// ──────────────────────────────────────────────────────────────────
// 排序后的统一搜索结果
// ──────────────────────────────────────────────────────────────────

/** 排序后的统一搜索结果 — API 响应中的单项 */
export interface RankedSearchItem extends SearchHitBase {
  // 分数来源
  weightedScore?: number;
  vectorScore?: number;
  // 排序信号
  relevanceScore: number;
  authorityScore: number;
  recencyScore: number;
  finalScore: number;
  // 展示字段
  description?: string;
  content?: string;
  tags?: string[];
  updatedAt?: string | null;
}

// ──────────────────────────────────────────────────────────────────
// 搜索响应
// ──────────────────────────────────────────────────────────────────

/** 搜索 API 响应 */
export interface SearchResponse {
  items: RankedSearchItem[];
  total: number;
  query: string;
  mode: 'weighted' | 'semantic' | 'hybrid' | 'context';
}
