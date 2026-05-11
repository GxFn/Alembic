import {
  buildWorkflowFileFingerprints,
  isSameWorkflowSnapshotPath,
  normalizeWorkflowProjectRoot,
  reconcileWorkflowSnapshotFiles,
} from "./path-utils.js";
import type {
  EngineeringWorkflowFileDiff,
  EngineeringWorkflowFileFingerprint,
  EngineeringWorkflowFileInput,
  EngineeringWorkflowFileMove,
  EngineeringWorkflowSnapshot,
  EngineeringWorkflowSnapshotDiagnostic,
  EngineeringWorkflowSnapshotStore,
  EngineeringWorkflowSnapshotWriteInput,
  EngineeringWorkflowSnapshotWriteResult,
} from "./types.js";

export interface EngineeringWorkflowFileDiffInput {
  readonly projectRoot: string;
  readonly snapshot: EngineeringWorkflowSnapshot;
  readonly currentFiles: readonly EngineeringWorkflowFileInput[];
}

export interface EngineeringWorkflowFileDiffEvaluationInput {
  readonly projectRoot: string;
  readonly currentFiles: readonly EngineeringWorkflowFileInput[];
}

export interface EngineeringWorkflowFileDiffEvaluation {
  readonly snapshot: EngineeringWorkflowSnapshot | null;
  readonly diff: EngineeringWorkflowFileDiff | null;
  readonly diagnostics: readonly EngineeringWorkflowSnapshotDiagnostic[];
  readonly reason: string;
}

export class EngineeringWorkflowFileDiffPlanner {
  readonly #store: EngineeringWorkflowSnapshotStore;

  constructor(store: EngineeringWorkflowSnapshotStore) {
    this.#store = store;
  }

  evaluate(
    input: EngineeringWorkflowFileDiffEvaluationInput,
  ): EngineeringWorkflowFileDiffEvaluation {
    const baseline = this.#store.readLatest(input.projectRoot);
    if (!baseline.snapshot) {
      return {
        snapshot: null,
        diff: null,
        diagnostics: baseline.diagnostics,
        reason: "无历史快照，需要全量冷启动",
      };
    }

    const diff = computeEngineeringWorkflowFileDiff({
      projectRoot: input.projectRoot,
      snapshot: baseline.snapshot,
      currentFiles: input.currentFiles,
    });

    return {
      snapshot: baseline.snapshot,
      diff,
      diagnostics: [...baseline.diagnostics, ...diff.diagnostics],
      reason:
        diff.added.length === 0 &&
        diff.modified.length === 0 &&
        diff.deleted.length === 0 &&
        diff.moved.length === 0
          ? "无文件变更，所有工程快照可复用"
          : `Detected ${changedFileCount(diff)} engineering workflow file change(s)`,
    };
  }

  saveSnapshot(
    input: EngineeringWorkflowSnapshotWriteInput,
  ): EngineeringWorkflowSnapshotWriteResult {
    return this.#store.writeSnapshot(input);
  }
}

export function computeEngineeringWorkflowFileDiff(
  input: EngineeringWorkflowFileDiffInput,
): EngineeringWorkflowFileDiff {
  const current = buildWorkflowFileFingerprints(input.currentFiles, input.projectRoot);
  const diagnostics: EngineeringWorkflowSnapshotDiagnostic[] = [...current.diagnostics];

  if (
    normalizeWorkflowProjectRoot(input.snapshot.projectRoot) !==
    normalizeWorkflowProjectRoot(input.projectRoot)
  ) {
    diagnostics.push({
      code: "project_root_mismatch",
      severity: "warn",
      message: `Snapshot project root ${input.snapshot.projectRoot} does not match current root ${input.projectRoot}`,
    });
  }

  const reconciled = reconcileWorkflowSnapshotFiles(
    input.snapshot.files,
    Object.keys(current.fingerprints),
  );
  const remappedPaths = Object.entries(reconciled.remapped);
  if (remappedPaths.length > 0) {
    diagnostics.push({
      code: "path_reconciled",
      severity: "info",
      message: `Reconciled ${remappedPaths.length} legacy snapshot path(s) with current scan paths`,
      paths: remappedPaths.map(([from, to]) => `${from} -> ${to}`),
    });
  }
  if (reconciled.ambiguous.length > 0) {
    diagnostics.push({
      code: "path_reconcile_ambiguous",
      severity: "warn",
      message: `Skipped ${reconciled.ambiguous.length} ambiguous legacy snapshot path remap(s)`,
      paths: reconciled.ambiguous,
    });
  }

  const rawAdded: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];
  const oldFiles = reconciled.files;
  const newFiles = current.fingerprints;

  for (const [relativePath, fingerprint] of Object.entries(newFiles)) {
    const previous = oldFiles[relativePath];
    if (!previous) {
      rawAdded.push(relativePath);
    } else if (previous.hash !== fingerprint.hash) {
      modified.push(relativePath);
    } else {
      unchanged.push(relativePath);
    }
  }

  const rawDeleted = Object.keys(oldFiles).filter((relativePath) => !newFiles[relativePath]);
  const moveResolution = detectMovedFiles(rawAdded, rawDeleted, oldFiles, newFiles);
  const totalFiles = Object.keys(newFiles).length || 1;
  const changedCount =
    moveResolution.added.length +
    modified.length +
    moveResolution.deleted.length +
    moveResolution.moved.length;

  return {
    added: moveResolution.added.sort(),
    modified: modified.sort(),
    deleted: moveResolution.deleted.sort(),
    moved: moveResolution.moved.sort((left, right) => left.from.localeCompare(right.from)),
    unchanged: unchanged.sort(),
    generatedSkipped: current.generatedSkipped,
    changeRatio: changedCount / totalFiles,
    diagnostics,
  };
}

export function changedFileCount(diff: EngineeringWorkflowFileDiff): number {
  return diff.added.length + diff.modified.length + diff.deleted.length + diff.moved.length;
}

function detectMovedFiles(
  added: readonly string[],
  deleted: readonly string[],
  oldFiles: Readonly<Record<string, EngineeringWorkflowFileFingerprint>>,
  newFiles: Readonly<Record<string, EngineeringWorkflowFileFingerprint>>,
): {
  readonly added: string[];
  readonly deleted: string[];
  readonly moved: EngineeringWorkflowFileMove[];
} {
  const remainingAdded = new Set(added);
  const remainingDeleted = new Set(deleted);
  const addedByHash = new Map<string, string[]>();

  for (const addedPath of added) {
    const fingerprint = newFiles[addedPath];
    if (!fingerprint) {
      continue;
    }
    addedByHash.set(fingerprint.hash, [...(addedByHash.get(fingerprint.hash) ?? []), addedPath]);
  }

  const moved: EngineeringWorkflowFileMove[] = [];
  for (const deletedPath of deleted) {
    const oldFingerprint = oldFiles[deletedPath];
    if (!oldFingerprint) {
      continue;
    }
    const candidates = addedByHash.get(oldFingerprint.hash) ?? [];
    const nextPath = candidates.find((candidate) => remainingAdded.has(candidate));
    if (!nextPath) {
      continue;
    }
    remainingAdded.delete(nextPath);
    remainingDeleted.delete(deletedPath);
    moved.push({ from: deletedPath, to: nextPath, hash: oldFingerprint.hash });
  }

  return {
    added: [...remainingAdded],
    deleted: [...remainingDeleted],
    moved,
  };
}

export { isSameWorkflowSnapshotPath };
