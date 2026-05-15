import {
  type CodeChangeMonitorResolvedTuning,
  DEFAULT_CODE_CHANGE_MONITOR_TUNING,
} from './CodeChangeMonitorConfig.js';

export type CodeChangeMonitorErrorCode =
  | 'DISPATCH_FAILED'
  | 'GIT_UNAVAILABLE'
  | 'PROJECT_ROOT_UNRESOLVED'
  | 'PROJECT_ROOT_UNTRUSTED'
  | 'RECONCILE_FAILED'
  | 'WATCHER_RESOURCE_LIMIT'
  | 'WATCHER_START_FAILED';

export interface CodeChangeMonitorError {
  at: string;
  code: CodeChangeMonitorErrorCode;
  message: string;
}

export interface CodeChangeWatcherStatus {
  backend: 'chokidar';
  healthy: boolean;
  lastError: string | null;
  lastEventAt: string | null;
  mode: 'native' | 'polling';
  ready: boolean;
  watchedDirectoryCount: number;
}

export interface CodeChangeReconcilerStatus {
  backend: 'git';
  baselineReady: boolean;
  dirtyPathCount: number;
  healthy: boolean;
  lastError: string | null;
  lastEventCount: number;
  lastHead: string | null;
  lastScanAt: string | null;
}

export interface CodeChangeLastDispatchStatus {
  at: string | null;
  eventCount: number;
  source: string | null;
  truncated: boolean;
}

export interface CodeChangeMonitorStatus {
  active: boolean;
  enabled: boolean;
  errors: CodeChangeMonitorError[];
  healthy: boolean;
  lastDispatch: CodeChangeLastDispatchStatus;
  mode: 'daemon-chokidar-git';
  pipeline: {
    gitSourceOfTruth: boolean;
    mode: 'watch-hints-git-truth';
    pendingWatchPathCount: number;
  };
  projectRoot: string;
  reason: string | null;
  reconciler: CodeChangeReconcilerStatus;
  surface: 'codex-plugin';
  tuning: CodeChangeMonitorResolvedTuning;
  watcher: CodeChangeWatcherStatus;
}

export function createInactiveCodeChangeMonitorStatus(
  projectRoot: string,
  reason: string | null,
  enabled = true,
  tuning: CodeChangeMonitorResolvedTuning = DEFAULT_CODE_CHANGE_MONITOR_TUNING
): CodeChangeMonitorStatus {
  return {
    active: false,
    enabled,
    errors: [],
    healthy: false,
    lastDispatch: {
      at: null,
      eventCount: 0,
      source: null,
      truncated: false,
    },
    mode: 'daemon-chokidar-git',
    pipeline: {
      gitSourceOfTruth: false,
      mode: 'watch-hints-git-truth',
      pendingWatchPathCount: 0,
    },
    projectRoot,
    reason,
    reconciler: {
      backend: 'git',
      baselineReady: false,
      dirtyPathCount: 0,
      healthy: false,
      lastError: null,
      lastEventCount: 0,
      lastHead: null,
      lastScanAt: null,
    },
    surface: 'codex-plugin',
    tuning,
    watcher: {
      backend: 'chokidar',
      healthy: false,
      lastError: null,
      lastEventAt: null,
      mode: tuning.watcherUsePolling ? 'polling' : 'native',
      ready: false,
      watchedDirectoryCount: 0,
    },
  };
}
