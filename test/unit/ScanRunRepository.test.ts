import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  getDrizzle,
  initDrizzle,
  resetDrizzle,
} from '../../lib/infrastructure/database/drizzle/index.js';
import migrate009 from '../../lib/infrastructure/database/migrations/009_scan_runs.js';
import { ScanRunRepository } from '../../lib/repository/scan/ScanRunRepository.js';

describe('ScanRunRepository', () => {
  let sqlite: InstanceType<typeof Database>;
  let now: number;
  let repository: ScanRunRepository;

  beforeEach(() => {
    resetDrizzle();
    sqlite = new Database(':memory:');
    migrate009(sqlite);
    initDrizzle(sqlite);
    now = 1_000;
    repository = new ScanRunRepository(getDrizzle(), () => now);
  });

  afterEach(() => {
    resetDrizzle();
    sqlite.close();
  });

  test('creates and completes a scan run', () => {
    const run = repository.create({
      projectRoot: '/repo',
      mode: 'maintenance',
      depth: 'light',
      reason: 'manual maintenance',
      scope: { modules: ['api'] },
    });

    expect(run.id).toMatch(/^scan-1000-[0-9a-f]+$/);
    expect(run.status).toBe('running');
    expect(run.scope).toEqual({ modules: ['api'] });

    now = 1_250;
    const completed = repository.complete(run.id, { staleSourceRefs: 2 });

    expect(completed?.status).toBe('completed');
    expect(completed?.durationMs).toBe(250);
    expect(completed?.summary).toEqual({ staleSourceRefs: 2 });
  });

  test('links a completed cold-start run to its baseline snapshot', () => {
    const run = repository.create({
      projectRoot: '/repo',
      mode: 'cold-start',
      depth: 'standard',
    });

    now = 1_300;
    const completed = repository.complete(
      run.id,
      { baselineSnapshotId: 'snap_baseline' },
      { baselineSnapshotId: 'snap_baseline' }
    );

    expect(completed?.status).toBe('completed');
    expect(completed?.baselineSnapshotId).toBe('snap_baseline');
    expect(repository.findById(run.id)?.baselineSnapshotId).toBe('snap_baseline');
  });

  test('marks a running scan as failed', () => {
    const run = repository.create({
      projectRoot: '/repo',
      mode: 'incremental-correction',
      depth: 'standard',
      changeSet: { added: [], modified: ['src/api.ts'], deleted: [] },
    });

    now = 1_100;
    const failed = repository.fail(run.id, 'boom');

    expect(failed?.status).toBe('failed');
    expect(failed?.errorMessage).toBe('boom');
    expect(failed?.changeSet?.modified).toEqual(['src/api.ts']);
  });

  test('filters runs by project, mode and status', () => {
    const first = repository.create({ projectRoot: '/repo', mode: 'maintenance', depth: 'light' });
    now = 2_000;
    repository.create({ projectRoot: '/repo', mode: 'deep-mining', depth: 'deep' });
    now = 3_000;
    repository.create({ projectRoot: '/other', mode: 'maintenance', depth: 'light' });
    repository.complete(first.id);

    const maintenanceRuns = repository.find({
      projectRoot: '/repo',
      mode: 'maintenance',
      status: 'completed',
    });

    expect(maintenanceRuns).toHaveLength(1);
    expect(maintenanceRuns[0].id).toBe(first.id);
    expect(repository.latest('/repo')?.mode).toBe('deep-mining');
  });
});
