import type {
  ScanRecommendationRecord,
  ScanRecommendationRepository,
} from '#repo/scan/ScanRecommendationRepository.js';
import type { ScanRecommendedRun } from '#workflows/scan/ScanTypes.js';

export interface ScanRecommendationSchedulerContainer {
  get?: (name: string) => unknown;
}

export interface PersistScanRecommendationsInput {
  projectRoot: string;
  sourceRunId?: string | null;
  recommendedRuns: ScanRecommendedRun[];
}

export class ScanRecommendationScheduler {
  readonly #repository: ScanRecommendationRepository | null;

  constructor(repository?: ScanRecommendationRepository | null) {
    this.#repository = repository ?? null;
  }

  static fromContainer(
    container: ScanRecommendationSchedulerContainer
  ): ScanRecommendationScheduler {
    return new ScanRecommendationScheduler(readScanRecommendationRepository(container));
  }

  persistPending({
    projectRoot,
    sourceRunId,
    recommendedRuns,
  }: PersistScanRecommendationsInput): ScanRecommendationRecord[] {
    if (!this.#repository || recommendedRuns.length === 0) {
      return [];
    }
    return this.#repository.createMany(
      recommendedRuns.map((run) => ({
        projectRoot,
        sourceRunId: sourceRunId ?? null,
        mode: run.mode,
        reason: run.reason,
        scope: run.scope,
        priority: run.priority,
      }))
    );
  }

  markQueued(id: string, jobId?: string | null): ScanRecommendationRecord | null {
    return this.#repository?.markQueued(id, jobId) ?? null;
  }

  markExecuted(id: string, runId?: string | null): ScanRecommendationRecord | null {
    return this.#repository?.markExecuted(id, runId) ?? null;
  }

  dismiss(id: string, reason?: string | null): ScanRecommendationRecord | null {
    return this.#repository?.dismiss(id, reason) ?? null;
  }
}

function readScanRecommendationRepository(
  container: ScanRecommendationSchedulerContainer
): ScanRecommendationRepository | null {
  try {
    const repository = container.get?.('scanRecommendationRepository') as
      | ScanRecommendationRepository
      | undefined;
    return repository && typeof repository.createMany === 'function' ? repository : null;
  } catch {
    return null;
  }
}
