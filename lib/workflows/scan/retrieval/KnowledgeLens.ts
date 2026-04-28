import { basename, extname } from 'node:path';
import type { SearchResultItem } from '#service/search/SearchTypes.js';
import type {
  EvidenceKnowledgeContent,
  EvidenceKnowledgeItem,
  KnowledgeRetrievalInput,
} from '#workflows/scan/ScanTypes.js';
import type {
  KnowledgeRepositoryLike,
  SearchEngineLike,
  SourceRefRecord,
  SourceRefRepositoryLike,
} from './RetrievalTypes.js';
import {
  asRecord,
  readNumber,
  readOptionalString,
  readString,
  readStringArray,
  uniqueStrings,
} from './RetrievalUtils.js';

export interface KnowledgeLensOptions {
  knowledgeRepository?: KnowledgeRepositoryLike | null;
  sourceRefRepository?: SourceRefRepositoryLike | null;
  searchEngine?: SearchEngineLike | null;
}

export interface KnowledgeLensContext {
  changedFiles: string[];
  impactedRecipeIds: string[];
  staleRefs: SourceRefRecord[];
  warnings: string[];
}

export interface KnowledgeLensResult {
  recipeIds: string[];
  items: EvidenceKnowledgeItem[];
}

export class KnowledgeLens {
  readonly #knowledgeRepository: KnowledgeRepositoryLike | null;
  readonly #sourceRefRepository: SourceRefRepositoryLike | null;
  readonly #searchEngine: SearchEngineLike | null;

  constructor(options: KnowledgeLensOptions = {}) {
    this.#knowledgeRepository = options.knowledgeRepository ?? null;
    this.#sourceRefRepository = options.sourceRefRepository ?? null;
    this.#searchEngine = options.searchEngine ?? null;
  }

  async collect(
    input: KnowledgeRetrievalInput,
    context: KnowledgeLensContext
  ): Promise<KnowledgeLensResult> {
    const searchItems = await this.#search(input, context.changedFiles, context.warnings);
    const searchRecipeIds = searchItems.map((item) => item.id).filter((id) => id.length > 0);
    const recipeIds = uniqueStrings([...context.impactedRecipeIds, ...searchRecipeIds]);
    const items = await this.#loadKnowledge(recipeIds, searchItems, context.staleRefs);
    return { recipeIds, items };
  }

  async #search(
    input: KnowledgeRetrievalInput,
    changedFiles: string[],
    warnings: string[]
  ): Promise<SearchResultItem[]> {
    const query = buildSearchQuery(input, changedFiles);
    if (!query || !this.#searchEngine?.search) {
      return [];
    }
    try {
      this.#searchEngine.ensureIndex?.();
      const response = await this.#searchEngine.search(query, {
        mode: 'auto',
        limit: input.budget?.maxKnowledgeItems ?? 20,
        rank: true,
        context: { intent: input.intent, language: input.primaryLang ?? undefined },
      });
      return response.items;
    } catch (err: unknown) {
      warnings.push(`search failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async #loadKnowledge(
    recipeIds: string[],
    searchItems: SearchResultItem[],
    staleRefs: SourceRefRecord[]
  ): Promise<EvidenceKnowledgeItem[]> {
    const byId = new Map<string, EvidenceKnowledgeItem>();
    const staleRecipeIds = new Set(staleRefs.map((ref) => ref.recipeId));

    for (const item of searchItems) {
      const sourceRefs = readStringArray((item as { sourceRefs?: unknown }).sourceRefs);
      byId.set(item.id, {
        id: item.id,
        title: item.title || item.id,
        description: item.description,
        trigger: item.trigger,
        lifecycle: item.status || 'active',
        knowledgeType: item.knowledgeType,
        kind: item.kind,
        category: item.category,
        language: item.language,
        content: parseContent(item.content),
        sourceRefs,
        reason: 'search',
        score: item.score,
      });
    }

    for (const record of await this.#loadKnowledgeRecords(recipeIds)) {
      const item = projectKnowledgeRecord(record);
      if (!item) {
        continue;
      }
      const existing = byId.get(item.id);
      const sourceRefs = collectSourceRefs(
        this.#sourceRefRepository,
        item.id,
        existing?.sourceRefs
      );
      byId.set(item.id, {
        ...existing,
        ...item,
        sourceRefs,
        reason: staleRecipeIds.has(item.id) ? 'stale' : (existing?.reason ?? 'source-ref'),
        score: existing?.score ?? item.score,
      });
    }

    return [...byId.values()].sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  }

  async #loadKnowledgeRecords(recipeIds: string[]): Promise<unknown[]> {
    if (recipeIds.length === 0 || !this.#knowledgeRepository) {
      return [];
    }

    if (this.#knowledgeRepository.findById) {
      const records: unknown[] = [];
      for (const recipeId of recipeIds) {
        const record = await this.#knowledgeRepository.findById(recipeId);
        if (record) {
          records.push(record);
        }
      }
      return records;
    }

    if (this.#knowledgeRepository.findNonDeprecatedSync) {
      const wanted = new Set(recipeIds);
      return this.#knowledgeRepository
        .findNonDeprecatedSync()
        .filter((record) => wanted.has(readString(asRecord(record)?.id)));
    }

    return this.#knowledgeRepository.findByIdsDetailSync?.(recipeIds) ?? [];
  }
}

function buildSearchQuery(input: KnowledgeRetrievalInput, changedFiles: string[]): string {
  const parts = [
    input.scope?.query,
    ...(input.scope?.dimensions ?? []),
    ...(input.scope?.modules ?? []),
    ...(input.scope?.symbols ?? []),
    ...changedFiles.slice(0, 6).map((filePath) => basename(filePath, extname(filePath))),
  ].filter((part): part is string => Boolean(part?.trim()));
  return uniqueStrings(parts).join(' ');
}

function projectKnowledgeRecord(recordValue: unknown): EvidenceKnowledgeItem | null {
  const record = normalizeRecord(recordValue);
  if (!record) {
    return null;
  }
  const id = readString(record.id);
  if (!id) {
    return null;
  }
  return {
    id,
    title: readString(record.title) || id,
    description: readOptionalString(record.description),
    trigger: readOptionalString(record.trigger),
    lifecycle: readString(record.lifecycle) || readString(record.status) || 'active',
    knowledgeType: readOptionalString(record.knowledgeType),
    kind: readOptionalString(record.kind),
    category: readOptionalString(record.category),
    language: readOptionalString(record.language),
    content: parseContent(record.content),
    sourceRefs: readStringArray(record.sourceRefs),
    reason: 'source-ref',
    score: readNumber(record.score),
  };
}

function normalizeRecord(value: unknown): Record<string, unknown> | null {
  const baseRecord = asRecord(value);
  if (!baseRecord) {
    return null;
  }
  const toJson = baseRecord.toJSON;
  if (typeof toJson === 'function') {
    const json = toJson.call(value);
    return asRecord(json) ?? baseRecord;
  }
  return baseRecord;
}

function parseContent(value: unknown): EvidenceKnowledgeContent | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return asRecord(parsed) as EvidenceKnowledgeContent | undefined;
    } catch {
      return { markdown: value };
    }
  }
  return asRecord(value) as EvidenceKnowledgeContent | undefined;
}

function collectSourceRefs(
  sourceRefRepository: SourceRefRepositoryLike | null,
  recipeId: string,
  existing: string[] | undefined
): string[] {
  const refs = sourceRefRepository?.findByRecipeId?.(recipeId) ?? [];
  return uniqueStrings([...(existing ?? []), ...refs.map((ref) => ref.sourcePath)]);
}
