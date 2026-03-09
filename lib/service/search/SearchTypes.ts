/**
 * SearchTypes — SearchEngine 共享类型定义
 *
 * 从 SearchEngine.ts 提取的所有接口和类型，
 * 供 SearchEngine、BM25Scorer、InvertedIndex 及测试文件独立消费。
 *
 * @module SearchTypes
 */

/** Internal BM25 document representation */
export interface BM25Document {
  id: string;
  tokens: string[];
  tokenFreq: Record<string, number>;
  length: number;
  meta: Record<string, unknown>;
}

/** BM25 search result */
export interface BM25SearchResult {
  id: string;
  score: number;
  meta: Record<string, unknown>;
}

/** Meta structure produced by _buildDocMeta */
export interface BM25DocMeta {
  type: string;
  title: string;
  trigger: string;
  status: string | undefined;
  knowledgeType: string | undefined;
  kind: string;
  language: string;
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
  category?: string;
  score?: number;
  content?: string;
  code?: string;
  headers?: string;
  moduleName?: string;
  knowledgeType?: string;
  bm25Score?: number;
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
  cacheMaxAge?: number;
  fusionBm25Weight?: number;
  fusionSemanticWeight?: number;
  [key: string]: unknown;
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
