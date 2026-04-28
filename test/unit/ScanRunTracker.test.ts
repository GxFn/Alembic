import { describe, expect, test, vi } from 'vitest';
import type { ScanEvidencePackRepository } from '../../lib/repository/scan/ScanEvidencePackRepository.js';
import type {
  ScanRunRecord,
  ScanRunRepository,
} from '../../lib/repository/scan/ScanRunRepository.js';
import {
  ScanRunTracker,
  TrackedScanRunError,
} from '../../lib/workflows/scan/lifecycle/ScanRunTracker.js';
import type { KnowledgeEvidencePack } from '../../lib/workflows/scan/ScanTypes.js';

function makeRun(overrides: Partial<ScanRunRecord> = {}): ScanRunRecord {
  return {
    id: 'scan-1',
    projectRoot: '/repo',
    mode: 'cold-start',
    depth: 'standard',
    status: 'running',
    reason: 'build baseline',
    activeDimensions: ['architecture'],
    scope: { dimensions: ['architecture'] },
    changeSet: null,
    budgets: {},
    summary: {},
    errorMessage: null,
    parentSnapshotId: null,
    baselineSnapshotId: null,
    startedAt: 100,
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
}

function makePack(): KnowledgeEvidencePack {
  return {
    project: { root: '/repo', primaryLang: 'typescript', fileCount: 1, modules: [] },
    files: [{ relativePath: 'src/index.ts', language: 'typescript', role: 'evidence' }],
    knowledge: [],
    graph: { entities: [], edges: [] },
    gaps: [],
    diagnostics: { truncated: false, warnings: [], retrievalMs: 3 },
  };
}

describe('ScanRunTracker', () => {
  test('creates a run and stores an evidence pack', () => {
    const run = makeRun();
    const evidenceRecord = {
      id: 'pack-1',
      runId: 'scan-1',
      packKind: 'cold-start',
      pack: makePack(),
      summary: { fileCount: 1 },
      charCount: 10,
      truncated: false,
      createdAt: 101,
    };
    const runRepository = {
      create: vi.fn(() => run),
    } as unknown as ScanRunRepository;
    const evidenceRepository = {
      create: vi.fn(() => evidenceRecord),
    } as unknown as ScanEvidencePackRepository;

    const result = new ScanRunTracker({ runRepository, evidenceRepository }).create(
      {
        projectRoot: '/repo',
        mode: 'cold-start',
        depth: 'standard',
        reason: 'build baseline',
        activeDimensions: ['architecture'],
        scope: { dimensions: ['architecture'] },
        budgets: { maxFiles: 10, maxKnowledgeItems: 20, maxTotalChars: 30_000 },
      },
      { packKind: 'cold-start', pack: makePack(), summary: { fileCount: 1 } }
    );

    expect(result.run?.id).toBe('scan-1');
    expect(result.evidencePackRecord?.id).toBe('pack-1');
    expect(runRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'cold-start', activeDimensions: ['architecture'] })
    );
    expect(evidenceRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'scan-1', packKind: 'cold-start' })
    );
  });

  test('tracks execution and completes the run with evidence summary', async () => {
    const run = makeRun({ mode: 'incremental-correction' });
    const completed = makeRun({ status: 'completed', completedAt: 150, durationMs: 50 });
    const runRepository = {
      create: vi.fn(() => run),
      complete: vi.fn(() => completed),
    } as unknown as ScanRunRepository;
    const evidenceRepository = {
      create: vi.fn(() => ({ id: 'pack-1' })),
    } as unknown as ScanEvidencePackRepository;

    const result = await new ScanRunTracker({ runRepository, evidenceRepository }).track({
      input: { projectRoot: '/repo', mode: 'incremental-correction', depth: 'standard' },
      execute: async () => ({ evidencePack: makePack(), fixed: 1 }),
      summarize: () => ({ fixed: 1, evidence: { fileCount: 1 } }),
      evidencePack: (value) => value.evidencePack,
      evidenceKind: 'incremental-correction',
    });

    expect(result.run).toBe(completed);
    expect(runRepository.complete).toHaveBeenCalledWith('scan-1', {
      fixed: 1,
      evidence: { fileCount: 1 },
    });
    expect(evidenceRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ summary: { fileCount: 1 } })
    );
  });

  test('fails the run and exposes the terminal run on execution error', async () => {
    const run = makeRun();
    const failed = makeRun({ status: 'failed', errorMessage: 'boom' });
    const runRepository = {
      create: vi.fn(() => run),
      fail: vi.fn(() => failed),
    } as unknown as ScanRunRepository;

    await expect(
      new ScanRunTracker({ runRepository }).track({
        input: { projectRoot: '/repo', mode: 'maintenance', depth: 'light' },
        execute: async () => {
          throw new Error('boom');
        },
        summarize: () => ({}),
      })
    ).rejects.toMatchObject({ name: 'TrackedScanRunError', run: failed });
    expect(runRepository.fail).toHaveBeenCalledWith('scan-1', 'boom');
  });

  test('cancels the run when the abort signal is set', async () => {
    const run = makeRun();
    const cancelled = makeRun({ status: 'cancelled' });
    const runRepository = {
      create: vi.fn(() => run),
      cancel: vi.fn(() => cancelled),
    } as unknown as ScanRunRepository;
    const controller = new AbortController();
    controller.abort();

    const result = await new ScanRunTracker({ runRepository }).track({
      input: { projectRoot: '/repo', mode: 'maintenance', depth: 'light' },
      execute: async () => ({ ok: true }),
      summarize: () => ({ ok: true }),
      signal: controller.signal,
    });

    expect(result.run).toBe(cancelled);
    expect(runRepository.cancel).toHaveBeenCalledWith('scan-1', { ok: true, cancelled: true });
  });

  test('returns null run data when repositories are unavailable', async () => {
    const tracker = ScanRunTracker.fromContainer({ get: () => null });

    expect(tracker.create({ projectRoot: '/repo', mode: 'maintenance', depth: 'light' })).toEqual({
      run: null,
      evidencePackRecord: null,
    });
    await expect(
      tracker.track({
        input: { projectRoot: '/repo', mode: 'maintenance', depth: 'light' },
        execute: async () => ({ ok: true }),
        summarize: () => ({ ok: true }),
      })
    ).resolves.toMatchObject({ run: null, evidencePackRecord: null });
  });

  test('wraps non-error failures consistently', async () => {
    const tracker = new ScanRunTracker();

    await expect(
      tracker.track({
        input: { projectRoot: '/repo', mode: 'maintenance', depth: 'light' },
        execute: () => Promise.reject('boom'),
        summarize: () => ({}),
      })
    ).rejects.toBeInstanceOf(TrackedScanRunError);
  });
});
