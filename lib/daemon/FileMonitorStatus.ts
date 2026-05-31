export type DaemonFileMonitorRuntimeState =
  | 'disabled'
  | 'unsupported'
  | 'starting'
  | 'running'
  | 'degraded'
  | 'error';

export type DaemonFileMonitorActiveEventSource = 'native-watch' | 'git-worktree' | null;

export interface DaemonFileMonitorRuntimeStatus {
  activeEventSource: DaemonFileMonitorActiveEventSource;
  degradedReason: string | null;
  fallback: {
    active: boolean;
    eventSource: 'git-worktree';
    reason: string | null;
  };
  intervalMs: number | null;
  lastDispatchAt: string | null;
  lastError: string | null;
  lastScanAt: string | null;
  nativeWatcher: {
    status: 'running' | 'unsupported' | 'error';
    reason: string | null;
  };
  producerKind: 'alembic-file-monitor';
  state: DaemonFileMonitorRuntimeState;
}

export function createDisabledFileMonitorStatus(
  reason: string,
  options: Partial<DaemonFileMonitorRuntimeStatus> = {}
): DaemonFileMonitorRuntimeStatus {
  return {
    activeEventSource: null,
    degradedReason: null,
    fallback: {
      active: false,
      eventSource: 'git-worktree',
      reason,
    },
    intervalMs: null,
    lastDispatchAt: null,
    lastError: null,
    lastScanAt: null,
    nativeWatcher: {
      status: 'unsupported',
      reason: 'native watcher is not running',
    },
    producerKind: 'alembic-file-monitor',
    state: 'disabled',
    ...options,
  };
}

export function createStartingFileMonitorStatus(
  reason: string,
  options: Partial<DaemonFileMonitorRuntimeStatus> = {}
): DaemonFileMonitorRuntimeStatus {
  return {
    ...createDisabledFileMonitorStatus(reason),
    fallback: {
      active: false,
      eventSource: 'git-worktree',
      reason,
    },
    state: 'starting',
    ...options,
  };
}

export function createUnsupportedFileMonitorStatus(
  reason: string,
  options: Partial<DaemonFileMonitorRuntimeStatus> = {}
): DaemonFileMonitorRuntimeStatus {
  return {
    ...createDisabledFileMonitorStatus(reason),
    state: 'unsupported',
    ...options,
  };
}

export function createGitFallbackFileMonitorStatus(
  options: Partial<DaemonFileMonitorRuntimeStatus> = {}
): DaemonFileMonitorRuntimeStatus {
  return {
    activeEventSource: 'git-worktree',
    degradedReason: 'native watcher unavailable; using git worktree fallback',
    fallback: {
      active: true,
      eventSource: 'git-worktree',
      reason: 'git worktree fallback collector is active',
    },
    intervalMs: null,
    lastDispatchAt: null,
    lastError: null,
    lastScanAt: null,
    nativeWatcher: {
      status: 'unsupported',
      reason: 'native watcher is unavailable',
    },
    producerKind: 'alembic-file-monitor',
    state: 'degraded',
    ...options,
  };
}

export function createNativeFileMonitorStatus(
  options: Partial<DaemonFileMonitorRuntimeStatus> = {}
): DaemonFileMonitorRuntimeStatus {
  return {
    activeEventSource: 'native-watch',
    degradedReason: null,
    fallback: {
      active: false,
      eventSource: 'git-worktree',
      reason: null,
    },
    intervalMs: null,
    lastDispatchAt: null,
    lastError: null,
    lastScanAt: null,
    nativeWatcher: {
      status: 'running',
      reason: null,
    },
    producerKind: 'alembic-file-monitor',
    state: 'running',
    ...options,
  };
}

export function createErroredFileMonitorStatus(
  error: string,
  options: Partial<DaemonFileMonitorRuntimeStatus> = {}
): DaemonFileMonitorRuntimeStatus {
  return {
    ...createGitFallbackFileMonitorStatus(options),
    lastError: error,
    state: 'error',
  };
}

export function isFileMonitorRuntimeAvailable(status: DaemonFileMonitorRuntimeStatus): boolean {
  return status.state === 'running' || status.state === 'degraded';
}

export function cloneFileMonitorStatus(
  status: DaemonFileMonitorRuntimeStatus
): DaemonFileMonitorRuntimeStatus {
  return {
    ...status,
    fallback: { ...status.fallback },
    nativeWatcher: { ...status.nativeWatcher },
  };
}
