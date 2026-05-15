export interface CodeChangeMonitorTuningOptions {
  dispatchDebounceMs?: number;
  dispatchMaxBatchSize?: number;
  eventDedupeCooldownMs?: number;
  gitPollIntervalMs?: number;
  watcherFallbackToPolling?: boolean;
  watcherPollingIntervalMs?: number;
  watcherReadyTimeoutMs?: number;
  watcherUsePolling?: boolean;
  watchSettleMs?: number;
}

export interface CodeChangeMonitorResolvedTuning {
  dispatchDebounceMs: number;
  dispatchMaxBatchSize: number;
  eventDedupeCooldownMs: number;
  gitPollIntervalMs: number;
  watcherFallbackToPolling: boolean;
  watcherPollingIntervalMs: number;
  watcherReadyTimeoutMs: number;
  watcherUsePolling: boolean;
  watchSettleMs: number;
}

export const DEFAULT_CODE_CHANGE_MONITOR_TUNING: CodeChangeMonitorResolvedTuning = {
  dispatchDebounceMs: 3000,
  dispatchMaxBatchSize: 500,
  eventDedupeCooldownMs: 30_000,
  gitPollIntervalMs: 60_000,
  watcherFallbackToPolling: true,
  watcherPollingIntervalMs: 500,
  watcherReadyTimeoutMs: 5000,
  watcherUsePolling: false,
  watchSettleMs: 5000,
};

export function resolveCodeChangeMonitorTuning(
  options: CodeChangeMonitorTuningOptions = {}
): CodeChangeMonitorResolvedTuning {
  return {
    dispatchDebounceMs: normalizePositiveInt(
      options.dispatchDebounceMs,
      DEFAULT_CODE_CHANGE_MONITOR_TUNING.dispatchDebounceMs
    ),
    dispatchMaxBatchSize: normalizePositiveInt(
      options.dispatchMaxBatchSize,
      DEFAULT_CODE_CHANGE_MONITOR_TUNING.dispatchMaxBatchSize
    ),
    eventDedupeCooldownMs: normalizePositiveInt(
      options.eventDedupeCooldownMs,
      DEFAULT_CODE_CHANGE_MONITOR_TUNING.eventDedupeCooldownMs
    ),
    gitPollIntervalMs: normalizePositiveInt(
      options.gitPollIntervalMs,
      DEFAULT_CODE_CHANGE_MONITOR_TUNING.gitPollIntervalMs
    ),
    watcherFallbackToPolling:
      options.watcherFallbackToPolling ??
      DEFAULT_CODE_CHANGE_MONITOR_TUNING.watcherFallbackToPolling,
    watcherPollingIntervalMs: normalizePositiveInt(
      options.watcherPollingIntervalMs,
      DEFAULT_CODE_CHANGE_MONITOR_TUNING.watcherPollingIntervalMs
    ),
    watcherReadyTimeoutMs: normalizePositiveInt(
      options.watcherReadyTimeoutMs,
      DEFAULT_CODE_CHANGE_MONITOR_TUNING.watcherReadyTimeoutMs
    ),
    watcherUsePolling:
      options.watcherUsePolling ?? DEFAULT_CODE_CHANGE_MONITOR_TUNING.watcherUsePolling,
    watchSettleMs: normalizePositiveInt(
      options.watchSettleMs,
      DEFAULT_CODE_CHANGE_MONITOR_TUNING.watchSettleMs
    ),
  };
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}
