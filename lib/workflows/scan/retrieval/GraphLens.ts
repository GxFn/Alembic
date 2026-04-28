import type {
  EvidenceGraphEdge,
  EvidenceGraphEntity,
  KnowledgeEvidencePack,
} from '#workflows/scan/ScanTypes.js';
import type { KnowledgeGraphServiceLike } from './RetrievalTypes.js';
import { asRecord, readString } from './RetrievalUtils.js';

export interface GraphLensOptions {
  knowledgeGraphService?: KnowledgeGraphServiceLike | null;
}

export class GraphLens {
  readonly #knowledgeGraphService: KnowledgeGraphServiceLike | null;

  constructor(options: GraphLensOptions = {}) {
    this.#knowledgeGraphService = options.knowledgeGraphService ?? null;
  }

  async collect(recipeIds: string[]): Promise<KnowledgeEvidencePack['graph']> {
    if (!this.#knowledgeGraphService || recipeIds.length === 0) {
      return { entities: [], edges: [] };
    }

    const entities = new Map<string, EvidenceGraphEntity>();
    const edges = new Map<string, EvidenceGraphEdge>();
    const scopedRecipeIds = recipeIds.slice(0, 12);

    for (const recipeId of scopedRecipeIds) {
      entities.set(`recipe:${recipeId}`, { id: recipeId, name: recipeId, kind: 'recipe' });

      const edgeGroup = await this.#knowledgeGraphService.getEdges?.(recipeId, 'recipe', 'both');
      for (const edge of [...(edgeGroup?.outgoing ?? []), ...(edgeGroup?.incoming ?? [])]) {
        const projected = projectGraphEdge(edge, recipeId);
        if (!projected) {
          continue;
        }
        edges.set(`${projected.from}:${projected.to}:${projected.relation}`, projected);
        entities.set(`recipe:${projected.from}`, {
          id: projected.from,
          name: projected.from,
          kind: 'recipe',
        });
        entities.set(`recipe:${projected.to}`, {
          id: projected.to,
          name: projected.to,
          kind: 'recipe',
        });
      }

      const impacted = await this.#knowledgeGraphService.getImpactAnalysis?.(recipeId, 'recipe', 2);
      for (const impactedNode of impacted ?? []) {
        const record = asRecord(impactedNode);
        const id = readString(record?.id);
        const relation = readString(record?.relation) || 'impacts';
        if (!id) {
          continue;
        }
        entities.set(`recipe:${id}`, { id, name: id, kind: readString(record?.type) || 'recipe' });
        edges.set(`${id}:${recipeId}:${relation}`, { from: id, to: recipeId, relation });
      }
    }

    return { entities: [...entities.values()], edges: [...edges.values()] };
  }
}

function projectGraphEdge(edgeValue: unknown, fallbackRecipeId: string): EvidenceGraphEdge | null {
  const edge = asRecord(edgeValue);
  if (!edge) {
    return null;
  }
  const from = readString(edge.fromId) || fallbackRecipeId;
  const to = readString(edge.toId);
  const relation = readString(edge.relation) || 'related';
  if (!from || !to) {
    return null;
  }
  return { from, to, relation };
}
