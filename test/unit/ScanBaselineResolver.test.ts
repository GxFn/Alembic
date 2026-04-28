import { describe, expect, test, vi } from 'vitest';
import {
  projectScanBaselineRef,
  resolveScanBaselineAnchor,
} from '../../lib/workflows/scan/lifecycle/ScanBaselineResolver.js';

describe('ScanBaselineResolver', () => {
  test('prefers explicit request baseline ids', () => {
    const repository = { find: vi.fn(), findById: vi.fn() };

    const anchor = resolveScanBaselineAnchor(
      { get: (name: string) => (name === 'scanRunRepository' ? repository : null) },
      {
        projectRoot: '/repo',
        requestedRunId: 'baseline-run-1',
        requestedSnapshotId: 'snap_1',
      }
    );

    expect(anchor).toMatchObject({
      available: true,
      runId: 'baseline-run-1',
      snapshotId: 'snap_1',
      source: 'request',
    });
    expect(repository.find).not.toHaveBeenCalled();
  });

  test('uses the latest completed cold-start run with a baseline snapshot', () => {
    const repository = {
      find: vi.fn(() => [
        { id: 'scan-without-snapshot', baselineSnapshotId: null },
        { id: 'baseline-run-1', baselineSnapshotId: 'snap_1' },
      ]),
    };

    const anchor = resolveScanBaselineAnchor(
      { get: (name: string) => (name === 'scanRunRepository' ? repository : null) },
      { projectRoot: '/repo' }
    );

    expect(anchor).toMatchObject({
      available: true,
      runId: 'baseline-run-1',
      snapshotId: 'snap_1',
      source: 'latest-cold-start',
    });
    expect(projectScanBaselineRef(anchor)).toEqual({
      runId: 'baseline-run-1',
      snapshotId: 'snap_1',
      source: 'latest-cold-start',
    });
    expect(repository.find).toHaveBeenCalledWith({
      projectRoot: '/repo',
      mode: 'cold-start',
      status: 'completed',
      limit: 20,
    });
  });

  test('returns an unavailable anchor when no baseline exists', () => {
    const anchor = resolveScanBaselineAnchor(
      { get: () => ({ find: vi.fn(() => []) }) },
      { projectRoot: '/repo' }
    );

    expect(anchor.available).toBe(false);
    expect(projectScanBaselineRef(anchor)).toBeNull();
  });
});
