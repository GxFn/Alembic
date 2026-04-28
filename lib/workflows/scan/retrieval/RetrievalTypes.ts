import type { SearchResponse } from '#service/search/SearchTypes.js';

export interface KnowledgeRepositoryLike {
  findById?: (id: string) => Promise<unknown>;
  findNonDeprecatedSync?: () => unknown[];
  findByIdsDetailSync?: (ids: string[]) => unknown[];
}

export interface SourceRefRecord {
  recipeId: string;
  sourcePath: string;
  status?: string;
  newPath?: string | null;
}

export interface SourceRefRepositoryLike {
  findBySourcePath?: (sourcePath: string) => SourceRefRecord[];
  findByRecipeId?: (recipeId: string) => SourceRefRecord[];
  findActiveByRecipeIds?: (recipeIds: string[]) => SourceRefRecord[];
  findStale?: () => SourceRefRecord[];
}

export interface SearchEngineLike {
  search?: (query: string, options?: Record<string, unknown>) => Promise<SearchResponse>;
  ensureIndex?: () => void;
}

export interface KnowledgeGraphServiceLike {
  getEdges?: (
    nodeId: string,
    nodeType: string,
    direction?: 'both' | 'in' | 'out'
  ) => Promise<{ outgoing?: unknown[]; incoming?: unknown[] }>;
  getImpactAnalysis?: (nodeId: string, nodeType: string, maxDepth?: number) => Promise<unknown[]>;
}

export interface CodeEntityRecordLike {
  entityId: string;
  entityType: string;
  name: string;
  filePath: string | null;
  line?: number | null;
  metadata?: Record<string, unknown>;
}

export interface CodeEntityEdgeRecordLike {
  fromId: string;
  fromType: string;
  toId: string;
  toType: string;
  relation: string;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface CodeEntityGraphLike {
  searchEntities?: (
    query: string,
    options?: { type?: string; limit?: number }
  ) => Promise<CodeEntityRecordLike[]>;
  getEntityEdges?: (
    entityId: string,
    entityType: string,
    direction?: 'both' | 'in' | 'out'
  ) => Promise<{ outgoing?: CodeEntityEdgeRecordLike[]; incoming?: CodeEntityEdgeRecordLike[] }>;
  getCallers?: (
    methodId: string,
    maxDepth?: number
  ) => Promise<Array<{ caller: string; depth: number; callType: string }>>;
  getCallees?: (
    methodId: string,
    maxDepth?: number
  ) => Promise<Array<{ callee: string; depth: number; callType: string }>>;
}
