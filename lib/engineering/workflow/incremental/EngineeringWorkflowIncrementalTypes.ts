import type {
  EngineeringWorkflowFileDiff,
  EngineeringWorkflowSnapshot,
  EngineeringWorkflowSnapshotDiagnostic,
} from "../cache/EngineeringWorkflowCacheTypes.js";

export type EngineeringWorkflowIncrementalMode =
  | "full-rescan"
  | "targeted-rescan"
  | "panorama-only"
  | "skip";

export interface EngineeringWorkflowIncrementalPlan {
  readonly mode: EngineeringWorkflowIncrementalMode;
  readonly reason: string;
  readonly baselineSnapshotId: string | null;
  readonly affectedFiles: readonly string[];
  readonly affectedModules: readonly string[];
  readonly affectedDimensions: readonly string[];
  readonly skippedDimensions: readonly string[];
  readonly diagnostics: readonly EngineeringWorkflowSnapshotDiagnostic[];
  readonly diff: EngineeringWorkflowFileDiff | null;
}

export interface EngineeringWorkflowIncrementalPlannerInput {
  readonly projectRoot: string;
  readonly snapshot: EngineeringWorkflowSnapshot | null;
  readonly diff: EngineeringWorkflowFileDiff | null;
  readonly allDimensions: readonly string[];
  readonly fullRescanThreshold?: number;
}
