export type EngineeringWorkflowSnapshotStatus = "complete" | "failed" | "partial";

export type EngineeringWorkflowSnapshotDiagnosticCode =
  | "baseline_missing"
  | "project_root_mismatch"
  | "path_reconciled"
  | "path_reconcile_ambiguous"
  | "generated_artifact_skipped"
  | "snapshot_read_failed"
  | "snapshot_write_failed"
  | "capacity_pruned";

export interface EngineeringWorkflowSnapshotDiagnostic {
  readonly code: EngineeringWorkflowSnapshotDiagnosticCode;
  readonly severity: "info" | "warn" | "error";
  readonly message: string;
  readonly paths?: readonly string[];
}

export interface EngineeringWorkflowFileInput {
  readonly path?: string;
  readonly relativePath?: string;
  readonly content?: string;
  readonly targetName?: string;
  readonly moduleName?: string;
  readonly isGenerated?: boolean;
}

export interface EngineeringWorkflowFileFingerprint {
  readonly path: string;
  readonly hash: string;
  readonly targetName?: string;
  readonly moduleName?: string;
}

export interface EngineeringWorkflowDimensionSnapshot {
  readonly candidateCount: number;
  readonly analysisChars: number;
  readonly referencedFiles: number;
  readonly durationMs: number;
  readonly referencedFilesList: readonly string[];
}

export interface EngineeringWorkflowSnapshot {
  readonly id: string;
  readonly sessionId: string | null;
  readonly projectRoot: string;
  readonly createdAt: string;
  readonly durationMs: number;
  readonly fileCount: number;
  readonly dimensionCount: number;
  readonly candidateCount: number;
  readonly primaryLang: string | null;
  readonly files: Readonly<Record<string, EngineeringWorkflowFileFingerprint>>;
  readonly dimensionMeta: Readonly<Record<string, EngineeringWorkflowDimensionSnapshot>>;
  readonly episodicData: unknown | null;
  readonly isIncremental: boolean;
  readonly parentId: string | null;
  readonly changedFiles: readonly string[];
  readonly affectedDimensions: readonly string[];
  readonly status: EngineeringWorkflowSnapshotStatus;
}

export interface EngineeringWorkflowFileMove {
  readonly from: string;
  readonly to: string;
  readonly hash: string;
}

export interface EngineeringWorkflowFileDiff {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly moved: readonly EngineeringWorkflowFileMove[];
  readonly unchanged: readonly string[];
  readonly generatedSkipped: readonly string[];
  readonly changeRatio: number;
  readonly diagnostics: readonly EngineeringWorkflowSnapshotDiagnostic[];
}

export interface EngineeringWorkflowSnapshotWriteInput {
  readonly id?: string;
  readonly sessionId?: string | null;
  readonly projectRoot: string;
  readonly allFiles: readonly EngineeringWorkflowFileInput[];
  readonly dimensionStats?: Readonly<Record<string, Partial<EngineeringWorkflowDimensionSnapshot>>>;
  readonly episodicData?: unknown | null;
  readonly meta?: {
    readonly durationMs?: number;
    readonly candidateCount?: number;
    readonly primaryLang?: string | null;
  };
  readonly isIncremental?: boolean;
  readonly parentId?: string | null;
  readonly changedFiles?: readonly string[];
  readonly affectedDimensions?: readonly string[];
  readonly createdAt?: string;
  readonly status?: EngineeringWorkflowSnapshotStatus;
}

export interface EngineeringWorkflowSnapshotReadResult {
  readonly snapshot: EngineeringWorkflowSnapshot | null;
  readonly diagnostics: readonly EngineeringWorkflowSnapshotDiagnostic[];
}

export interface EngineeringWorkflowSnapshotWriteResult {
  readonly snapshot: EngineeringWorkflowSnapshot | null;
  readonly snapshotId: string | null;
  readonly prunedIds: readonly string[];
  readonly diagnostics: readonly EngineeringWorkflowSnapshotDiagnostic[];
}

export interface EngineeringWorkflowSnapshotStore {
  readLatest(projectRoot: string): EngineeringWorkflowSnapshotReadResult;
  readSnapshot(id: string): EngineeringWorkflowSnapshotReadResult;
  writeSnapshot(
    input: EngineeringWorkflowSnapshotWriteInput,
  ): EngineeringWorkflowSnapshotWriteResult;
  listSnapshots(projectRoot: string, limit?: number): readonly EngineeringWorkflowSnapshot[];
  clearProject(projectRoot: string): readonly string[];
}

export interface EngineeringWorkflowSnapshotStoreDocument {
  readonly version: 1;
  readonly snapshots: readonly EngineeringWorkflowSnapshot[];
}
