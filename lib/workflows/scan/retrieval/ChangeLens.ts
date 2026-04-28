import type {
  EvidenceImpactDetail,
  KnowledgeRetrievalInput,
  ScanChangeSet,
} from '#workflows/scan/ScanTypes.js';
import type { SourceRefRecord, SourceRefRepositoryLike } from './RetrievalTypes.js';
import { collectChangedFiles, uniqueStrings } from './RetrievalUtils.js';

export interface ChangeLensOptions {
  sourceRefRepository?: SourceRefRepositoryLike | null;
}

export interface ChangeLensResult {
  changedFiles: string[];
  impactedRecipeIds: string[];
  impactDetails: EvidenceImpactDetail[];
  staleRefs: SourceRefRecord[];
}

export class ChangeLens {
  readonly #sourceRefRepository: SourceRefRepositoryLike | null;

  constructor(options: ChangeLensOptions = {}) {
    this.#sourceRefRepository = options.sourceRefRepository ?? null;
  }

  collect(input: KnowledgeRetrievalInput, changeSet: ScanChangeSet | undefined): ChangeLensResult {
    const changedFiles = collectChangedFiles(changeSet);
    const impactedRecipeIds = new Set(input.scope?.recipeIds ?? []);
    const impactDetails = new Map<string, EvidenceImpactDetail>();

    for (const detail of input.reports?.reactive?.details ?? []) {
      if (detail.action !== 'needs-review' && detail.action !== 'deprecate') {
        continue;
      }
      impactedRecipeIds.add(detail.recipeId);
      if (detail.modifiedPath && detail.impactLevel) {
        impactDetails.set(`${detail.recipeId}:${detail.modifiedPath}`, {
          recipeId: detail.recipeId,
          file: detail.modifiedPath,
          level: detail.impactLevel,
          matchedTokens: [],
          score: detail.impactLevel === 'pattern' ? 0.6 : 0.8,
        });
      }
    }

    for (const filePath of changedFiles) {
      const refs = this.#sourceRefRepository?.findBySourcePath?.(filePath) ?? [];
      for (const ref of refs) {
        impactedRecipeIds.add(ref.recipeId);
        const inferredLevel = inferImpactLevel(changeSet, filePath);
        impactDetails.set(`${ref.recipeId}:${filePath}`, {
          recipeId: ref.recipeId,
          file: filePath,
          level: inferredLevel,
          matchedTokens: [],
          score: inferredLevel === 'direct' ? 0.8 : 0.3,
        });
      }
    }

    const staleRefs = shouldCollectStaleRefs(input)
      ? (this.#sourceRefRepository?.findStale?.() ?? [])
      : [];
    for (const ref of staleRefs) {
      impactedRecipeIds.add(ref.recipeId);
    }

    return {
      changedFiles,
      impactedRecipeIds: uniqueStrings(impactedRecipeIds),
      impactDetails: [...impactDetails.values()],
      staleRefs,
    };
  }
}

function inferImpactLevel(
  changeSet: ScanChangeSet | undefined,
  filePath: string
): EvidenceImpactDetail['level'] {
  if (!changeSet) {
    return 'reference';
  }
  if (
    changeSet.deleted.includes(filePath) ||
    changeSet.renamed?.some((rename) => rename.oldPath === filePath)
  ) {
    return 'direct';
  }
  return 'reference';
}

function shouldCollectStaleRefs(input: KnowledgeRetrievalInput): boolean {
  return input.intent === 'repair-stale-knowledge' || input.intent === 'maintain-health';
}
