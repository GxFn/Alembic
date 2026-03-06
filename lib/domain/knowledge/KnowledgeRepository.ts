import type KnowledgeEntry from './KnowledgeEntry.js';

interface PaginationOptions {
  page?: number;
  pageSize?: number;
}

interface PaginatedResult {
  data: KnowledgeEntry[];
  pagination: Record<string, unknown>;
}

/**
 * KnowledgeRepository — 统一知识实体仓储接口
 *
 * 替代 CandidateRepository + RecipeRepository。
 * 实现类见 lib/repository/knowledge/KnowledgeRepository.impl.js
 */
export class KnowledgeRepository {
  async create(entry: KnowledgeEntry): Promise<KnowledgeEntry> {
    throw new Error('Not implemented');
  }

  async findById(id: string): Promise<KnowledgeEntry | null> {
    throw new Error('Not implemented');
  }

  async findWithPagination(
    filters?: Record<string, unknown>,
    options?: PaginationOptions & { orderBy?: string; order?: string }
  ): Promise<PaginatedResult> {
    throw new Error('Not implemented');
  }

  async findByLifecycle(
    lifecycle: string,
    pagination?: PaginationOptions
  ): Promise<PaginatedResult> {
    throw new Error('Not implemented');
  }

  async findByKind(
    kind: string,
    options?: PaginationOptions & { lifecycle?: string }
  ): Promise<PaginatedResult> {
    throw new Error('Not implemented');
  }

  async findActiveRules(): Promise<KnowledgeEntry[]> {
    throw new Error('Not implemented');
  }

  async findByLanguage(language: string, pagination?: PaginationOptions): Promise<PaginatedResult> {
    throw new Error('Not implemented');
  }

  async findByCategory(category: string, pagination?: PaginationOptions): Promise<PaginatedResult> {
    throw new Error('Not implemented');
  }

  async search(keyword: string, pagination?: PaginationOptions): Promise<PaginatedResult> {
    throw new Error('Not implemented');
  }

  async update(id: string, updates: Record<string, unknown>): Promise<KnowledgeEntry> {
    throw new Error('Not implemented');
  }

  async delete(id: string): Promise<boolean> {
    throw new Error('Not implemented');
  }

  async getStats(): Promise<Record<string, unknown>> {
    throw new Error('Not implemented');
  }
}

export default KnowledgeRepository;
