import type { ScanRunRecord, ScanRunRepository } from '#repo/scan/ScanRunRepository.js';
import type { ScanBaselineRef } from '#workflows/scan/ScanTypes.js';

export interface ScanBaselineResolverContainer {
  get?: (name: string) => unknown;
}

export interface ResolveScanBaselineOptions {
  projectRoot: string;
  requestedRunId?: string | null;
  requestedSnapshotId?: string | null;
}

export interface ResolvedScanBaseline extends ScanBaselineRef {
  available: boolean;
  reason: string | null;
}

export function resolveScanBaselineAnchor(
  container: ScanBaselineResolverContainer,
  options: ResolveScanBaselineOptions
): ResolvedScanBaseline {
  const requestedRunId = normalizeId(options.requestedRunId);
  const requestedSnapshotId = normalizeId(options.requestedSnapshotId);
  const repository = readScanRunRepository(container);

  if (requestedRunId || requestedSnapshotId) {
    const requestedRun = requestedRunId ? repository?.findById(requestedRunId) : null;
    return {
      runId: requestedRunId ?? requestedRun?.id ?? null,
      snapshotId: requestedSnapshotId ?? requestedRun?.baselineSnapshotId ?? null,
      source: 'request',
      available: true,
      reason: null,
    };
  }

  const latestBaseline = findLatestColdStartBaseline(repository, options.projectRoot);
  if (latestBaseline) {
    return {
      runId: latestBaseline.id,
      snapshotId: latestBaseline.baselineSnapshotId,
      source: 'latest-cold-start',
      available: true,
      reason: null,
    };
  }

  return {
    runId: null,
    snapshotId: null,
    source: 'missing',
    available: false,
    reason: 'deep-mining requires an existing cold-start baseline',
  };
}

export function projectScanBaselineRef(anchor: ResolvedScanBaseline): ScanBaselineRef | null {
  if (!anchor.available) {
    return null;
  }
  return {
    runId: anchor.runId,
    snapshotId: anchor.snapshotId,
    source: anchor.source,
  };
}

function findLatestColdStartBaseline(
  repository: ScanRunRepository | null,
  projectRoot: string
): ScanRunRecord | null {
  const runs =
    repository?.find({
      projectRoot,
      mode: 'cold-start',
      status: 'completed',
      limit: 20,
    }) ?? [];
  return runs.find((run) => Boolean(run.baselineSnapshotId)) ?? null;
}

function readScanRunRepository(container: ScanBaselineResolverContainer): ScanRunRepository | null {
  try {
    const repository = container.get?.('scanRunRepository') as ScanRunRepository | undefined;
    return repository && typeof repository.find === 'function' ? repository : null;
  } catch {
    return null;
  }
}

function normalizeId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
