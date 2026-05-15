import type { FileChangeEventSource } from '../../../types/reactive-evolution.js';

export type GitDiffCheckpointErrorCode =
  | 'DISPATCH_FAILED'
  | 'GIT_UNAVAILABLE'
  | 'PROJECT_ROOT_UNRESOLVED'
  | 'SCAN_FAILED';

export interface GitDiffCheckpointError {
  at: string;
  code: GitDiffCheckpointErrorCode;
  message: string;
}

export interface GitDiffScanStatus {
  backend: 'git';
  dirtyPathCount: number;
  healthy: boolean;
  lastError: string | null;
  lastEventCount: number;
  lastHead: string | null;
  lastScanAt: string | null;
  lastSignature: string | null;
}

export interface GitDiffLastDispatchStatus {
  at: string | null;
  batchCount: number;
  eventCount: number;
  source: FileChangeEventSource | null;
}

export interface GitDiffCheckpointStatus {
  enabled: boolean;
  errors: GitDiffCheckpointError[];
  healthy: boolean;
  lastCheckpointAt: string | null;
  lastDispatch: GitDiffLastDispatchStatus;
  mode: 'git-diff-checkpoint';
  projectRoot: string;
  reason: string | null;
  scanner: GitDiffScanStatus;
  surface: 'codex-plugin';
}

export function createInactiveGitDiffCheckpointStatus(
  projectRoot: string,
  reason: string | null,
  enabled = true
): GitDiffCheckpointStatus {
  return {
    enabled,
    errors: [],
    healthy: false,
    lastCheckpointAt: null,
    lastDispatch: {
      at: null,
      batchCount: 0,
      eventCount: 0,
      source: null,
    },
    mode: 'git-diff-checkpoint',
    projectRoot,
    reason,
    scanner: {
      backend: 'git',
      dirtyPathCount: 0,
      healthy: false,
      lastError: null,
      lastEventCount: 0,
      lastHead: null,
      lastScanAt: null,
      lastSignature: null,
    },
    surface: 'codex-plugin',
  };
}
