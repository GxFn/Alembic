/**
 * SearchTypes — SearchEngine 共享类型定义
 *
 * 从 SearchEngine.ts 提取的所有接口和类型，
 * 供 SearchEngine、FieldWeightedScorer、BM25Scorer 及测试文件独立消费。
 *
 * @module SearchTypes
 */

/** Internal scorer document representation */
export interface ScorerDocument {
  id: string;
  tokens: string[];
  tokenFreq: Record<string, number>;
  length: number;
  meta: Record<string, unknown>;
}

/** Scorer search result */
export interface ScorerResult {
  id: string;
  score: number;
  meta: Record<string, unknown>;
}

// ── Legacy aliases (backward compat) ──
/** @deprecated Use ScorerDocument */
export type BM25Document = ScorerDocument;
/** @deprecated Use ScorerResult */
export type BM25SearchResult = ScorerResult;

/**
 * Scorer 通用接口 — FieldWeightedScorer（默认）与 BM25Scorer 共同实现
 *
 * SearchEngine 通过此接口与具体评分器解耦，可在运行时切换。
 */
export interface Scorer {
  totalDocs: number;
  avgLength: number;
  docFreq: Record<string, number>;
  documents: ({ id: string } | null)[];
  addDocument(id: string, text: string, meta: Record<string, unknown>): void;
  removeDocument(id: string): boolean;
  updateDocument(id: string, text: string, meta: Record<string, unknown>): void;
  hasDocument(id: string): boolean;
  search(query: string, limit?: number): ScorerResult[];
  clear(): void;
}

/** Meta structure produced by _buildDocMeta */
export interface DocMeta {
  type: string;
  title: string;
  trigger: string;
  status: string | undefined;
  knowledgeType: string | undefined;
  kind: string;
  language: string;
  dimensionId?: string;
  category: string;
  updatedAt: string | null;
  createdAt: string | null;
  difficulty: string;
  tags: string[];
  usageCount: number;
  authorityScore: number;
  qualityScore: number;
  [key: string]: unknown;
}

/** @deprecated Use DocMeta */
export type BM25DocMeta = DocMeta;

/** Unified search result item flowing through the ranking pipeline */
export interface SearchResultItem {
  id: string;
  title?: string;
  description?: string;
  trigger?: string;
  type?: string;
  kind?: string;
  status?: string;
  language?: string;
  dimensionId?: string;
  category?: string;
  score?: number;
  content?: string;
  code?: string;
  headers?: string;
  moduleName?: string;
  knowledgeType?: string;
  qualityScore?: number;
  usageCount?: number;
  authorityScore?: number;
  tags?: string[] | string;
  difficulty?: string;
  updatedAt?: string | null;
  createdAt?: string | null;
  whenClause?: string;
  doClause?: string;
  rankerScore?: number;
  coarseScore?: number;
  contextScore?: number;
  recallScore?: number;
  [key: string]: unknown;
}

/** Database row from knowledge_entries table */
export interface DbRow {
  id: string;
  title?: string;
  description?: string;
  language?: string;
  dimensionId?: string;
  category?: string;
  knowledgeType?: string;
  kind?: string;
  content?: string;
  lifecycle?: string;
  tags?: string;
  trigger?: string;
  difficulty?: string;
  quality?: string;
  stats?: string;
  updatedAt?: string;
  createdAt?: string;
  status?: string;
  headers?: string;
  moduleName?: string;
  whenClause?: string;
  doClause?: string;
  [key: string]: unknown;
}

/** Search method options */
export interface SearchOptions {
  type?: string;
  limit?: number;
  mode?: string;
  context?: RankingContext;
  rank?: boolean;
  groupByKind?: boolean;
  useAI?: boolean;
  [key: string]: unknown;
}

/** Context for ranking pipeline */
export interface RankingContext {
  sessionHistory?: Array<{ content?: string; rawInput?: string }>;
  language?: string;
  intent?: string;
  [key: string]: unknown;
}

/** Search response envelope */
export interface SearchResponse {
  items: SearchResultItem[];
  total: number;
  query: string;
  mode?: string;
  type?: string;
  ranked?: boolean;
  byKind?: Record<string, SearchResultItem[]>;
}

/** Duck-typed database connection (better-sqlite3 style) */
export interface SearchDb {
  prepare(sql: string): { all(...args: unknown[]): DbRow[] };
}

/** AI provider with embedding capability */
export interface SearchAiProvider {
  embed(text: string): Promise<number[]>;
}

/** Vector store for semantic search */
export interface SearchVectorStore {
  query(embedding: number[], limit: number): Promise<VectorHit[]>;
  hybridSearch?(
    embedding: number[],
    query: string,
    options: { topK?: number }
  ): Promise<VectorHit[]>;
}

/** Vector search hit */
export interface VectorHit {
  id: string;
  similarity?: number;
  score?: number;
  content?: string;
  metadata?: Record<string, unknown>;
  item?: { id: string; content?: string; metadata?: Record<string, unknown> };
  [key: string]: unknown;
}

/** Hybrid retriever for RRF fusion */
export interface SearchHybridRetriever {
  search(
    query: string,
    queryEmbedding: number[],
    options: {
      topK?: number;
      alpha?: number;
      sparseSearchFn?: () => SearchResultItem[];
    }
  ): Promise<RrfHit[]>;
}

/** Single RRF fusion hit */
export interface RrfHit {
  id: string;
  score: number;
  data?: { item?: Record<string, unknown>; [key: string]: unknown };
  [key: string]: unknown;
}

/** Cross-encoder reranker abstraction */
import type { SignalBus } from '../../infrastructure/signal/SignalBus.js';

export interface SearchCrossEncoder {
  rerank(query: string, candidates: SearchResultItem[]): Promise<SearchResultItem[]>;
}

/** SearchEngine constructor options */
export interface SearchEngineOptions {
  aiProvider?: SearchAiProvider | null;
  vectorStore?: SearchVectorStore | null;
  vectorService?: SearchVectorService | null;
  hybridRetriever?: SearchHybridRetriever | null;
  crossEncoderReranker?: SearchCrossEncoder | null;
  signalBus?: SignalBus | null;
  cacheMaxAge?: number;
  fusionRecallWeight?: number;
  fusionSemanticWeight?: number;
  [key: string]: unknown;
}

// ─── Unified Slim Projection ────────────────────────────────

/**
 * 统一的搜索结果投影类型 — 去除内部排序信号，只保留 Agent/Bridge 可操作字段。
 * 合并自 mcp/search.ts#SlimSearchItem 和 TaskKnowledgeBridge#SlimKnowledgeItem。
 */
export interface SlimSearchResult {
  id: string;
  title: string;
  trigger: string;
  kind: string;
  language: string;
  score: number;
  description: string;
  actionHint?: string;
  /** 知识类型 (code-standard/code-pattern/...) — Bridge 场景需要 */
  knowledgeType?: string;
  /** 已验证的项目来源文件路径（可信度证据链） */
  sourceRefs?: string[];
}

/**
 * 统一投影函数 — 将 SearchResultItem 投影为 SlimSearchResult。
 *
 * 合并了 mcp/search.ts#_slimSearchItem() 和 TaskKnowledgeBridge#_projectItem() 的逻辑：
 * - 去除内部信号 (recallScore, coarseScore, rankerScore, contextScore, content, code...)
 * - description 截断 120 字符
 * - 生成 actionHint (whenClause → doClause)
 *
 * @param item 搜索结果项（来自 SearchEngine）
 * @returns 瘦身后的结果项
 */
export function slimSearchResult(item: SearchResultItem): SlimSearchResult {
  const doText = (item.doClause as string) || '';
  const whenText = (item.whenClause as string) || '';
  const actionHint =
    doText || whenText
      ? `${whenText ? `${whenText} → ` : ''}${doText}`.replace(/ → $/, '')
      : undefined;
  const rawRefs = (item as SearchResultItem & { sourceRefs?: unknown }).sourceRefs;
  const sourceRefs =
    Array.isArray(rawRefs) && rawRefs.length > 0
      ? rawRefs.filter((s: unknown) => typeof s === 'string' && (s as string).length > 0)
      : undefined;
  return {
    id: item.id,
    title: (item.title as string) || '',
    trigger: (item.trigger as string) || '',
    kind: (item.kind as string) || 'pattern',
    language: (item.language as string) || '',
    score: Math.round(((item.score as number) || 0) * 1000) / 1000,
    description: ((item.description as string) || '').slice(0, 120),
    actionHint,
    knowledgeType: (item.knowledgeType as string) || undefined,
    sourceRefs,
  };
}

/** items → byKind 分组（统一实现） */
export function groupByKind<T extends { kind?: string }>(
  items: T[]
): { rule: T[]; pattern: T[]; fact: T[] } {
  const byKind: { rule: T[]; pattern: T[]; fact: T[] } = { rule: [], pattern: [], fact: [] };
  for (const it of items) {
    const kind = it.kind || 'pattern';
    const bucket = (byKind as unknown as Record<string, T[]>)[kind] || byKind.pattern;
    bucket.push(it);
  }
  return byKind;
}

/** VectorService abstraction for SearchEngine delegation */
export interface SearchVectorService {
  search(
    query: string,
    opts?: { topK?: number; filter?: Record<string, unknown> | null; minScore?: number }
  ): Promise<Array<{ item: Record<string, unknown>; score: number }>>;
  hybridSearch(
    query: string,
    opts?: {
      topK?: number;
      alpha?: number;
      sparseSearchFn?:
        | ((
            q: string,
            limit: number
          ) => Array<{ id: string; score?: number; [key: string]: unknown }>)
        | null;
    }
  ): Promise<Array<{ id: string; score: number; [key: string]: unknown }>>;
}
