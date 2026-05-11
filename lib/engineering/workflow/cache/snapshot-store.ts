import { randomUUID } from "node:crypto";
import { buildWorkflowFileFingerprints, normalizeWorkflowProjectRoot } from "./path-utils.js";
import type {
  EngineeringWorkflowDimensionSnapshot,
  EngineeringWorkflowSnapshot,
  EngineeringWorkflowSnapshotDiagnostic,
  EngineeringWorkflowSnapshotReadResult,
  EngineeringWorkflowSnapshotStore,
  EngineeringWorkflowSnapshotStoreDocument,
  EngineeringWorkflowSnapshotWriteInput,
  EngineeringWorkflowSnapshotWriteResult,
} from "./types.js";

export const ENGINEERING_WORKFLOW_DEFAULT_SNAPSHOT_CAPACITY = 5;

export interface EngineeringWorkflowSnapshotStoreOptions {
  readonly capacity?: number;
  readonly now?: () => string;
  readonly idFactory?: () => string;
  readonly snapshots?: readonly EngineeringWorkflowSnapshot[];
}

interface MutableSnapshotStoreState {
  snapshots: EngineeringWorkflowSnapshot[];
}

export class InMemoryEngineeringWorkflowSnapshotStore implements EngineeringWorkflowSnapshotStore {
  readonly #state: MutableSnapshotStoreState;
  readonly #capacity: number;
  readonly #now: () => string;
  readonly #idFactory: () => string;

  constructor(options: EngineeringWorkflowSnapshotStoreOptions = {}) {
    this.#state = { snapshots: [...(options.snapshots ?? [])] };
    this.#capacity = options.capacity ?? ENGINEERING_WORKFLOW_DEFAULT_SNAPSHOT_CAPACITY;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#idFactory =
      options.idFactory ?? (() => `snap_${randomUUID().replace(/-/g, "").substring(0, 12)}`);
  }

  readLatest(projectRoot: string): EngineeringWorkflowSnapshotReadResult {
    try {
      const normalizedRoot = normalizeWorkflowProjectRoot(projectRoot);
      const snapshot =
        this.#state.snapshots
          .filter(
            (candidate) =>
              normalizeWorkflowProjectRoot(candidate.projectRoot) === normalizedRoot &&
              candidate.status === "complete",
          )
          .sort(compareSnapshotsNewestFirst)[0] ?? null;

      if (!snapshot) {
        return {
          snapshot: null,
          diagnostics: [
            {
              code: "baseline_missing",
              severity: "info",
              message: "No previous engineering workflow snapshot found; full rescan required",
            },
          ],
        };
      }
      return { snapshot, diagnostics: [] };
    } catch (error: unknown) {
      return {
        snapshot: null,
        diagnostics: [snapshotStoreFailureDiagnostic("snapshot_read_failed", error)],
      };
    }
  }

  readSnapshot(id: string): EngineeringWorkflowSnapshotReadResult {
    try {
      const snapshot = this.#state.snapshots.find((candidate) => candidate.id === id) ?? null;
      if (!snapshot) {
        return {
          snapshot: null,
          diagnostics: [
            {
              code: "baseline_missing",
              severity: "info",
              message: `Engineering workflow snapshot ${id} was not found`,
            },
          ],
        };
      }
      return { snapshot, diagnostics: [] };
    } catch (error: unknown) {
      return {
        snapshot: null,
        diagnostics: [snapshotStoreFailureDiagnostic("snapshot_read_failed", error)],
      };
    }
  }

  writeSnapshot(
    input: EngineeringWorkflowSnapshotWriteInput,
  ): EngineeringWorkflowSnapshotWriteResult {
    try {
      const snapshot = buildEngineeringWorkflowSnapshot(input, {
        now: this.#now,
        idFactory: this.#idFactory,
      });
      const existingIndex = this.#state.snapshots.findIndex(
        (candidate) => candidate.id === snapshot.id,
      );
      if (existingIndex >= 0) {
        this.#state.snapshots[existingIndex] = snapshot;
      } else {
        this.#state.snapshots.push(snapshot);
      }

      const prunedIds = pruneSnapshotCapacity(this.#state, snapshot.projectRoot, this.#capacity);
      const diagnostics: EngineeringWorkflowSnapshotDiagnostic[] =
        prunedIds.length > 0
          ? [
              {
                code: "capacity_pruned",
                severity: "info",
                message: `Pruned ${prunedIds.length} old engineering workflow snapshot(s)`,
                paths: prunedIds,
              },
            ]
          : [];

      return {
        snapshot,
        snapshotId: snapshot.id,
        prunedIds,
        diagnostics,
      };
    } catch (error: unknown) {
      return {
        snapshot: null,
        snapshotId: null,
        prunedIds: [],
        diagnostics: [snapshotStoreFailureDiagnostic("snapshot_write_failed", error)],
      };
    }
  }

  listSnapshots(
    projectRoot: string,
    limit = Number.POSITIVE_INFINITY,
  ): readonly EngineeringWorkflowSnapshot[] {
    const normalizedRoot = normalizeWorkflowProjectRoot(projectRoot);
    return this.#state.snapshots
      .filter((snapshot) => normalizeWorkflowProjectRoot(snapshot.projectRoot) === normalizedRoot)
      .sort(compareSnapshotsNewestFirst)
      .slice(0, limit);
  }

  clearProject(projectRoot: string): readonly string[] {
    const normalizedRoot = normalizeWorkflowProjectRoot(projectRoot);
    const removed = this.#state.snapshots
      .filter((snapshot) => normalizeWorkflowProjectRoot(snapshot.projectRoot) === normalizedRoot)
      .map((snapshot) => snapshot.id);
    this.#state.snapshots = this.#state.snapshots.filter(
      (snapshot) => normalizeWorkflowProjectRoot(snapshot.projectRoot) !== normalizedRoot,
    );
    return removed;
  }

  toJSON(): EngineeringWorkflowSnapshotStoreDocument {
    return {
      version: 1,
      snapshots: [...this.#state.snapshots].sort(compareSnapshotsNewestFirst),
    };
  }
}

export class JsonSerializableEngineeringWorkflowSnapshotStore
  implements EngineeringWorkflowSnapshotStore
{
  readonly #memory: InMemoryEngineeringWorkflowSnapshotStore;

  constructor(
    document: EngineeringWorkflowSnapshotStoreDocument = { version: 1, snapshots: [] },
    options: EngineeringWorkflowSnapshotStoreOptions = {},
  ) {
    this.#memory = new InMemoryEngineeringWorkflowSnapshotStore({
      ...options,
      snapshots: document.snapshots,
    });
  }

  static fromJSON(
    value: unknown,
    options: EngineeringWorkflowSnapshotStoreOptions = {},
  ): {
    readonly store: JsonSerializableEngineeringWorkflowSnapshotStore;
    readonly diagnostics: readonly EngineeringWorkflowSnapshotDiagnostic[];
  } {
    const diagnostics: EngineeringWorkflowSnapshotDiagnostic[] = [];
    try {
      const document = parseSnapshotStoreDocument(value);
      return {
        store: new JsonSerializableEngineeringWorkflowSnapshotStore(document, options),
        diagnostics,
      };
    } catch (error: unknown) {
      diagnostics.push(snapshotStoreFailureDiagnostic("snapshot_read_failed", error));
      return {
        store: new JsonSerializableEngineeringWorkflowSnapshotStore(undefined, options),
        diagnostics,
      };
    }
  }

  readLatest(projectRoot: string): EngineeringWorkflowSnapshotReadResult {
    return this.#memory.readLatest(projectRoot);
  }

  readSnapshot(id: string): EngineeringWorkflowSnapshotReadResult {
    return this.#memory.readSnapshot(id);
  }

  writeSnapshot(
    input: EngineeringWorkflowSnapshotWriteInput,
  ): EngineeringWorkflowSnapshotWriteResult {
    return this.#memory.writeSnapshot(input);
  }

  listSnapshots(projectRoot: string, limit?: number): readonly EngineeringWorkflowSnapshot[] {
    return this.#memory.listSnapshots(projectRoot, limit);
  }

  clearProject(projectRoot: string): readonly string[] {
    return this.#memory.clearProject(projectRoot);
  }

  toJSON(): EngineeringWorkflowSnapshotStoreDocument {
    return this.#memory.toJSON();
  }
}

export function buildEngineeringWorkflowSnapshot(
  input: EngineeringWorkflowSnapshotWriteInput,
  options: {
    readonly now?: () => string;
    readonly idFactory?: () => string;
  } = {},
): EngineeringWorkflowSnapshot {
  const id =
    input.id ?? options.idFactory?.() ?? `snap_${randomUUID().replace(/-/g, "").substring(0, 12)}`;
  const createdAt = input.createdAt ?? options.now?.() ?? new Date().toISOString();
  const fingerprintResult = buildWorkflowFileFingerprints(input.allFiles, input.projectRoot);
  const dimensionMeta = normalizeDimensionStats(input.dimensionStats ?? {});

  return {
    id,
    sessionId: input.sessionId ?? null,
    projectRoot: input.projectRoot,
    createdAt,
    durationMs: input.meta?.durationMs ?? 0,
    fileCount: Object.keys(fingerprintResult.fingerprints).length,
    dimensionCount: Object.keys(dimensionMeta).length,
    candidateCount: input.meta?.candidateCount ?? 0,
    primaryLang: input.meta?.primaryLang ?? null,
    files: fingerprintResult.fingerprints,
    dimensionMeta,
    episodicData: input.episodicData ?? null,
    isIncremental: input.isIncremental ?? false,
    parentId: input.parentId ?? null,
    changedFiles: input.changedFiles ?? [],
    affectedDimensions: input.affectedDimensions ?? [],
    status: input.status ?? "complete",
  };
}

function normalizeDimensionStats(
  stats: Readonly<Record<string, Partial<EngineeringWorkflowDimensionSnapshot>>>,
): Record<string, EngineeringWorkflowDimensionSnapshot> {
  const normalized: Record<string, EngineeringWorkflowDimensionSnapshot> = {};
  for (const [dimensionId, stat] of Object.entries(stats)) {
    normalized[dimensionId] = {
      candidateCount: stat.candidateCount ?? 0,
      analysisChars: stat.analysisChars ?? 0,
      referencedFiles: stat.referencedFiles ?? stat.referencedFilesList?.length ?? 0,
      durationMs: stat.durationMs ?? 0,
      referencedFilesList: stat.referencedFilesList ?? [],
    };
  }
  return normalized;
}

function compareSnapshotsNewestFirst(
  left: EngineeringWorkflowSnapshot,
  right: EngineeringWorkflowSnapshot,
): number {
  const byTime = right.createdAt.localeCompare(left.createdAt);
  return byTime === 0 ? right.id.localeCompare(left.id) : byTime;
}

function pruneSnapshotCapacity(
  state: MutableSnapshotStoreState,
  projectRoot: string,
  capacity: number,
): readonly string[] {
  if (capacity < 1) {
    return [];
  }
  const normalizedRoot = normalizeWorkflowProjectRoot(projectRoot);
  const projectSnapshots = state.snapshots
    .filter((snapshot) => normalizeWorkflowProjectRoot(snapshot.projectRoot) === normalizedRoot)
    .sort(compareSnapshotsNewestFirst);
  const keep = new Set(projectSnapshots.slice(0, capacity).map((snapshot) => snapshot.id));
  const pruned = projectSnapshots.slice(capacity).map((snapshot) => snapshot.id);
  if (pruned.length === 0) {
    return [];
  }
  state.snapshots = state.snapshots.filter(
    (snapshot) =>
      normalizeWorkflowProjectRoot(snapshot.projectRoot) !== normalizedRoot ||
      keep.has(snapshot.id),
  );
  return pruned;
}

function snapshotStoreFailureDiagnostic(
  code: "snapshot_read_failed" | "snapshot_write_failed",
  error: unknown,
): EngineeringWorkflowSnapshotDiagnostic {
  return {
    code,
    severity: "warn",
    message: `Engineering workflow snapshot ${code === "snapshot_read_failed" ? "read" : "write"} failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  };
}

function parseSnapshotStoreDocument(value: unknown): EngineeringWorkflowSnapshotStoreDocument {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("snapshot document must be an object");
  }
  const maybeDocument = parsed as Partial<EngineeringWorkflowSnapshotStoreDocument>;
  if (maybeDocument.version !== 1 || !Array.isArray(maybeDocument.snapshots)) {
    throw new Error("snapshot document version or snapshots are invalid");
  }
  return {
    version: 1,
    snapshots: maybeDocument.snapshots,
  };
}
