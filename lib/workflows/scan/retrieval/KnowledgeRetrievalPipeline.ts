import { ChangeLens } from '#workflows/scan/retrieval/ChangeLens.js';
import { CodeEntityLens } from '#workflows/scan/retrieval/CodeEntityLens.js';
import { EvidenceBudgeter } from '#workflows/scan/retrieval/EvidenceBudgeter.js';
import { GraphLens } from '#workflows/scan/retrieval/GraphLens.js';
import { KnowledgeLens } from '#workflows/scan/retrieval/KnowledgeLens.js';
import { ProjectSnapshotLens } from '#workflows/scan/retrieval/ProjectSnapshotLens.js';
import { normalizeChangeSet } from '#workflows/scan/retrieval/RetrievalUtils.js';
import type { KnowledgeEvidencePack, KnowledgeRetrievalInput } from '#workflows/scan/ScanTypes.js';
import type {
  CodeEntityGraphLike,
  KnowledgeGraphServiceLike,
  KnowledgeRepositoryLike,
  SearchEngineLike,
  SourceRefRepositoryLike,
} from './RetrievalTypes.js';

export interface KnowledgeRetrievalPipelineOptions {
  projectRoot?: string;
  knowledgeRepository?: KnowledgeRepositoryLike | null;
  sourceRefRepository?: SourceRefRepositoryLike | null;
  searchEngine?: SearchEngineLike | null;
  knowledgeGraphService?: KnowledgeGraphServiceLike | null;
  codeEntityGraph?: CodeEntityGraphLike | null;
  budgeter?: EvidenceBudgeter;
  now?: () => number;
}

export class KnowledgeRetrievalPipeline {
  readonly #projectLens: ProjectSnapshotLens;
  readonly #changeLens: ChangeLens;
  readonly #knowledgeLens: KnowledgeLens;
  readonly #graphLens: GraphLens;
  readonly #codeEntityLens: CodeEntityLens;
  readonly #budgeter: EvidenceBudgeter;
  readonly #now: () => number;

  constructor(options: KnowledgeRetrievalPipelineOptions = {}) {
    const sourceRefRepository = options.sourceRefRepository ?? null;
    this.#projectLens = new ProjectSnapshotLens({ projectRoot: options.projectRoot });
    this.#changeLens = new ChangeLens({ sourceRefRepository });
    this.#knowledgeLens = new KnowledgeLens({
      knowledgeRepository: options.knowledgeRepository,
      sourceRefRepository,
      searchEngine: options.searchEngine,
    });
    this.#graphLens = new GraphLens({ knowledgeGraphService: options.knowledgeGraphService });
    this.#codeEntityLens = new CodeEntityLens({ codeEntityGraph: options.codeEntityGraph });
    this.#budgeter = options.budgeter ?? new EvidenceBudgeter();
    this.#now = options.now ?? Date.now;
  }

  async retrieve(input: KnowledgeRetrievalInput): Promise<KnowledgeEvidencePack> {
    const startedAt = this.#now();
    const warnings: string[] = [];
    const changeSet = normalizeChangeSet(input.changeSet);
    const changeEvidence = this.#changeLens.collect(input, changeSet);
    const knowledge = await this.#knowledgeLens.collect(input, {
      changedFiles: changeEvidence.changedFiles,
      impactedRecipeIds: changeEvidence.impactedRecipeIds,
      staleRefs: changeEvidence.staleRefs,
      warnings,
    });
    const graph = mergeGraphs(
      await this.#graphLens.collect(knowledge.recipeIds),
      await this.#codeEntityLens.collect(input, {
        changedFiles: changeEvidence.changedFiles,
        warnings,
      })
    );
    const files = this.#projectLens.files(input, changeEvidence.changedFiles);

    const pack: KnowledgeEvidencePack = {
      project: this.#projectLens.project(input, files),
      changes: changeSet
        ? {
            files: changeEvidence.changedFiles,
            impactedDimensions: input.scope?.dimensions ?? [],
            impactedRecipeIds: changeEvidence.impactedRecipeIds,
            impactDetails: changeEvidence.impactDetails,
          }
        : undefined,
      files,
      knowledge: knowledge.items,
      graph,
      gaps: this.#projectLens.gaps(input, changeSet, knowledge.items, changeEvidence.staleRefs),
      diagnostics: {
        truncated: false,
        warnings,
        retrievalMs: this.#now() - startedAt,
      },
    };

    return this.#budgeter.apply(pack, input.mode, input.depth, input.budget);
  }
}

function mergeGraphs(
  left: KnowledgeEvidencePack['graph'],
  right: KnowledgeEvidencePack['graph']
): KnowledgeEvidencePack['graph'] {
  const entities = new Map<string, KnowledgeEvidencePack['graph']['entities'][number]>();
  const edges = new Map<string, KnowledgeEvidencePack['graph']['edges'][number]>();

  for (const entity of [...left.entities, ...right.entities]) {
    entities.set(`${entity.kind}:${entity.id}`, entity);
  }
  for (const edge of [...left.edges, ...right.edges]) {
    edges.set(`${edge.from}:${edge.to}:${edge.relation}`, edge);
  }

  return { entities: [...entities.values()], edges: [...edges.values()] };
}
