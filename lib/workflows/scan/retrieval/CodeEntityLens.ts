import { basename, extname } from 'node:path';
import type {
  EvidenceGraphEdge,
  EvidenceGraphEntity,
  KnowledgeEvidencePack,
  KnowledgeRetrievalInput,
} from '#workflows/scan/ScanTypes.js';
import type {
  CodeEntityEdgeRecordLike,
  CodeEntityGraphLike,
  CodeEntityRecordLike,
} from './RetrievalTypes.js';
import { readString, uniqueStrings } from './RetrievalUtils.js';

export interface CodeEntityLensOptions {
  codeEntityGraph?: CodeEntityGraphLike | null;
  maxQueries?: number;
  maxEntities?: number;
  maxEdgesPerEntity?: number;
}

export interface CodeEntityLensContext {
  changedFiles: string[];
  warnings: string[];
}

export class CodeEntityLens {
  readonly #codeEntityGraph: CodeEntityGraphLike | null;
  readonly #maxQueries: number;
  readonly #maxEntities: number;
  readonly #maxEdgesPerEntity: number;

  constructor(options: CodeEntityLensOptions = {}) {
    this.#codeEntityGraph = options.codeEntityGraph ?? null;
    this.#maxQueries = options.maxQueries ?? 12;
    this.#maxEntities = options.maxEntities ?? 24;
    this.#maxEdgesPerEntity = options.maxEdgesPerEntity ?? 8;
  }

  async collect(
    input: KnowledgeRetrievalInput,
    context: CodeEntityLensContext
  ): Promise<KnowledgeEvidencePack['graph']> {
    if (!this.#codeEntityGraph?.searchEntities) {
      return { entities: [], edges: [] };
    }

    try {
      const entities = await this.#searchEntities(input, context.changedFiles);
      const projectedEntities = new Map<string, EvidenceGraphEntity>();
      const projectedEdges = new Map<string, EvidenceGraphEdge>();

      for (const entity of entities) {
        const projected = projectEntity(entity);
        projectedEntities.set(entityKey(projected.kind, projected.id), projected);
      }

      for (const entity of entities) {
        await this.#collectEntityEdges(entity, projectedEntities, projectedEdges);
        await this.#collectCallEdges(entity, projectedEntities, projectedEdges);
      }

      return { entities: [...projectedEntities.values()], edges: [...projectedEdges.values()] };
    } catch (err: unknown) {
      context.warnings.push(
        `code entity graph failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return { entities: [], edges: [] };
    }
  }

  async #searchEntities(
    input: KnowledgeRetrievalInput,
    changedFiles: string[]
  ): Promise<CodeEntityRecordLike[]> {
    const queries = buildQueries(input, changedFiles).slice(0, this.#maxQueries);
    const byKey = new Map<string, CodeEntityRecordLike>();

    for (const query of queries) {
      const results = await this.#codeEntityGraph?.searchEntities?.(query, { limit: 6 });
      for (const entity of results ?? []) {
        byKey.set(entityKey(entity.entityType, entity.entityId), entity);
        if (byKey.size >= this.#maxEntities) {
          return [...byKey.values()];
        }
      }
    }

    return [...byKey.values()];
  }

  async #collectEntityEdges(
    entity: CodeEntityRecordLike,
    entities: Map<string, EvidenceGraphEntity>,
    edges: Map<string, EvidenceGraphEdge>
  ): Promise<void> {
    if (!this.#codeEntityGraph?.getEntityEdges) {
      return;
    }

    const edgeGroup = await this.#codeEntityGraph.getEntityEdges(
      entity.entityId,
      entity.entityType,
      'both'
    );
    for (const edge of [
      ...(edgeGroup.outgoing ?? []).slice(0, this.#maxEdgesPerEntity),
      ...(edgeGroup.incoming ?? []).slice(0, this.#maxEdgesPerEntity),
    ]) {
      addEdge(edge, entities, edges);
    }
  }

  async #collectCallEdges(
    entity: CodeEntityRecordLike,
    entities: Map<string, EvidenceGraphEntity>,
    edges: Map<string, EvidenceGraphEdge>
  ): Promise<void> {
    if (entity.entityType !== 'method') {
      return;
    }

    const callers = await this.#codeEntityGraph?.getCallers?.(entity.entityId, 1);
    for (const caller of callers ?? []) {
      const from = { id: caller.caller, name: caller.caller, kind: 'method' };
      const to = projectEntity(entity);
      entities.set(entityKey(from.kind, from.id), from);
      entities.set(entityKey(to.kind, to.id), to);
      setEdge(edges, { from: from.id, to: to.id, relation: 'calls' });
    }

    const callees = await this.#codeEntityGraph?.getCallees?.(entity.entityId, 1);
    for (const callee of callees ?? []) {
      const from = projectEntity(entity);
      const to = { id: callee.callee, name: callee.callee, kind: 'method' };
      entities.set(entityKey(from.kind, from.id), from);
      entities.set(entityKey(to.kind, to.id), to);
      setEdge(edges, { from: from.id, to: to.id, relation: 'calls' });
    }
  }
}

function buildQueries(input: KnowledgeRetrievalInput, changedFiles: string[]): string[] {
  const fileTerms = changedFiles
    .slice(0, 8)
    .map((filePath) => basename(filePath, extname(filePath)))
    .filter((term) => term.length > 1);
  const queryTerms = splitQuery(input.scope?.query);
  return uniqueStrings([
    ...(input.scope?.symbols ?? []),
    ...(input.scope?.modules ?? []),
    ...fileTerms,
    ...queryTerms,
  ]);
}

function splitQuery(query: string | undefined): string[] {
  if (!query) {
    return [];
  }
  return query
    .split(/[^\p{L}\p{N}_.$-]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
}

function projectEntity(entity: CodeEntityRecordLike): EvidenceGraphEntity {
  return {
    id: entity.entityId,
    name: entity.name || entity.entityId,
    kind: entity.entityType,
    file: entity.filePath ?? undefined,
  };
}

function addEdge(
  edge: CodeEntityEdgeRecordLike,
  entities: Map<string, EvidenceGraphEntity>,
  edges: Map<string, EvidenceGraphEdge>
): void {
  const from = { id: edge.fromId, name: edge.fromId, kind: edge.fromType };
  const to = { id: edge.toId, name: edge.toId, kind: edge.toType };
  entities.set(entityKey(from.kind, from.id), from);
  entities.set(entityKey(to.kind, to.id), to);
  setEdge(edges, { from: edge.fromId, to: edge.toId, relation: readString(edge.relation) });
}

function setEdge(edges: Map<string, EvidenceGraphEdge>, edge: EvidenceGraphEdge): void {
  if (!edge.from || !edge.to || !edge.relation) {
    return;
  }
  edges.set(`${edge.from}:${edge.to}:${edge.relation}`, edge);
}

function entityKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}
