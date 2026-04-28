import type {
  ScanEvidencePackKind,
  ScanEvidencePackRecord,
  ScanEvidencePackRepository,
} from '#repo/scan/ScanEvidencePackRepository.js';
import type {
  CompleteScanRunOptions,
  CreateScanRunInput,
  ScanRunRecord,
  ScanRunRepository,
} from '#repo/scan/ScanRunRepository.js';
import type { KnowledgeEvidencePack } from '#workflows/scan/ScanTypes.js';

export interface ScanRunTrackerContainer {
  get?: (name: string) => unknown;
}

export interface ScanRunTrackerLogger {
  warn(...args: unknown[]): void;
}

export interface ScanRunTrackerOptions {
  runRepository?: ScanRunRepository | null;
  evidenceRepository?: ScanEvidencePackRepository | null;
  logger?: ScanRunTrackerLogger | null;
}

export interface TrackScanRunOptions<T> {
  input: CreateScanRunInput;
  execute: () => Promise<T>;
  summarize: (result: T) => Record<string, unknown>;
  evidencePack?: (result: T) => KnowledgeEvidencePack | null;
  evidenceKind?: ScanEvidencePackKind;
  signal?: AbortSignal;
}

export interface TrackedScanRunResult<T> {
  result: T;
  run: ScanRunRecord | null;
  evidencePackRecord: ScanEvidencePackRecord | null;
}

export interface CreatedScanRunResult {
  run: ScanRunRecord | null;
  evidencePackRecord: ScanEvidencePackRecord | null;
}

export interface PersistEvidencePackOptions {
  runId: string;
  packKind?: ScanEvidencePackKind;
  pack: KnowledgeEvidencePack;
  summary?: Record<string, unknown>;
}

export class TrackedScanRunError extends Error {
  readonly run: ScanRunRecord | null;
  readonly originalError: unknown;

  constructor(message: string, run: ScanRunRecord | null, originalError: unknown) {
    super(message);
    this.name = 'TrackedScanRunError';
    this.run = run;
    this.originalError = originalError;
  }
}

export class ScanRunTracker {
  readonly #runRepository: ScanRunRepository | null;
  readonly #evidenceRepository: ScanEvidencePackRepository | null;
  readonly #logger: ScanRunTrackerLogger | null;

  constructor(options: ScanRunTrackerOptions = {}) {
    this.#runRepository = options.runRepository ?? null;
    this.#evidenceRepository = options.evidenceRepository ?? null;
    this.#logger = options.logger ?? null;
  }

  static fromContainer(
    container: ScanRunTrackerContainer,
    logger?: ScanRunTrackerLogger | null
  ): ScanRunTracker {
    return new ScanRunTracker({
      runRepository: readScanRunRepository(container),
      evidenceRepository: readScanEvidencePackRepository(container),
      logger,
    });
  }

  create(
    input: CreateScanRunInput,
    evidence?: Omit<PersistEvidencePackOptions, 'runId'> | null
  ): CreatedScanRunResult {
    const run = this.#runRepository?.create(input) ?? null;
    if (!run || !evidence?.pack) {
      return { run, evidencePackRecord: null };
    }
    return {
      run,
      evidencePackRecord: this.persistEvidencePack({
        runId: run.id,
        ...evidence,
      }),
    };
  }

  complete(
    runId: string | null | undefined,
    summary: Record<string, unknown>,
    options?: CompleteScanRunOptions
  ): ScanRunRecord | null {
    if (!runId) {
      return null;
    }
    return options
      ? (this.#runRepository?.complete(runId, summary, options) ?? null)
      : (this.#runRepository?.complete(runId, summary) ?? null);
  }

  fail(
    runId: string | null | undefined,
    error: unknown,
    summary: Record<string, unknown> = {}
  ): ScanRunRecord | null {
    if (!runId) {
      return null;
    }
    return this.#runRepository?.fail(runId, toErrorMessage(error), summary) ?? null;
  }

  cancel(
    runId: string | null | undefined,
    summary: Record<string, unknown> = {}
  ): ScanRunRecord | null {
    if (!runId) {
      return null;
    }
    return this.#runRepository?.cancel(runId, summary) ?? null;
  }

  persistEvidencePack({
    runId,
    packKind = 'retrieval',
    pack,
    summary,
  }: PersistEvidencePackOptions): ScanEvidencePackRecord | null {
    if (!this.#evidenceRepository) {
      return null;
    }
    try {
      return this.#evidenceRepository.create({
        runId,
        packKind,
        pack,
        summary,
      });
    } catch (err: unknown) {
      this.#logger?.warn('[ScanRunTracker] evidence pack persistence failed', {
        runId,
        packKind,
        error: toErrorMessage(err),
      });
      return null;
    }
  }

  async track<T>({
    input,
    execute,
    summarize,
    evidencePack,
    evidenceKind = 'retrieval',
    signal,
  }: TrackScanRunOptions<T>): Promise<TrackedScanRunResult<T>> {
    const run = this.#runRepository?.create(input) ?? null;
    try {
      const result = await execute();
      const summary = summarize(result);
      const pack = evidencePack?.(result) ?? null;
      const evidencePackRecord =
        run && pack
          ? this.persistEvidencePack({
              runId: run.id,
              packKind: evidenceKind,
              pack,
              summary: summary.evidence as Record<string, unknown> | undefined,
            })
          : null;
      const completedRun = run
        ? signal?.aborted
          ? (this.#runRepository?.cancel(run.id, { ...summary, cancelled: true }) ?? run)
          : (this.#runRepository?.complete(run.id, summary) ?? run)
        : null;
      return { result, run: completedRun, evidencePackRecord };
    } catch (err: unknown) {
      const terminalRun = run
        ? signal?.aborted
          ? (this.#runRepository?.cancel(run.id, {
              cancelled: true,
              errorMessage: toErrorMessage(err),
            }) ?? run)
          : (this.#runRepository?.fail(run.id, toErrorMessage(err)) ?? run)
        : null;
      throw new TrackedScanRunError(toErrorMessage(err), terminalRun, err);
    }
  }
}

function readScanRunRepository(container: ScanRunTrackerContainer): ScanRunRepository | null {
  try {
    const repository = container.get?.('scanRunRepository') as ScanRunRepository | undefined;
    return repository && typeof repository.create === 'function' ? repository : null;
  } catch {
    return null;
  }
}

function readScanEvidencePackRepository(
  container: ScanRunTrackerContainer
): ScanEvidencePackRepository | null {
  try {
    const repository = container.get?.('scanEvidencePackRepository') as
      | ScanEvidencePackRepository
      | undefined;
    return repository && typeof repository.create === 'function' ? repository : null;
  } catch {
    return null;
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
