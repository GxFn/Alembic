import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  getDrizzle,
  initDrizzle,
  resetDrizzle,
} from '../../lib/infrastructure/database/drizzle/index.js';
import migrate009 from '../../lib/infrastructure/database/migrations/009_scan_runs.js';
import migrate011 from '../../lib/infrastructure/database/migrations/011_scan_recommendations.js';
import { ScanRecommendationRepository } from '../../lib/repository/scan/ScanRecommendationRepository.js';
import { ScanRunRepository } from '../../lib/repository/scan/ScanRunRepository.js';

describe('ScanRecommendationRepository', () => {
  let sqlite: InstanceType<typeof Database>;
  let now: number;
  let runRepository: ScanRunRepository;
  let recommendationRepository: ScanRecommendationRepository;

  beforeEach(() => {
    resetDrizzle();
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate009(sqlite);
    migrate011(sqlite);
    initDrizzle(sqlite);
    now = 1_000;
    const drizzle = getDrizzle();
    runRepository = new ScanRunRepository(drizzle, () => now);
    recommendationRepository = new ScanRecommendationRepository(drizzle, () => now);
  });

  afterEach(() => {
    resetDrizzle();
    sqlite.close();
  });

  test('stores pending recommendations from a maintenance run', () => {
    const sourceRun = runRepository.create({
      projectRoot: '/repo',
      mode: 'maintenance',
      depth: 'light',
    });

    const created = recommendationRepository.create({
      projectRoot: '/repo',
      sourceRunId: sourceRun.id,
      mode: 'deep-mining',
      reason: '2 enhancement suggestions found',
      scope: { dimensions: ['architecture'] },
      priority: 'high',
    });

    expect(created.id).toMatch(/^scanrec-1000-[0-9a-f]+$/);
    expect(created.status).toBe('pending');
    expect(created.sourceRunId).toBe(sourceRun.id);

    const pending = recommendationRepository.find({ projectRoot: '/repo', status: 'pending' });
    expect(pending).toEqual([expect.objectContaining({ targetMode: 'deep-mining' })]);
  });

  test('tracks queued and executed states without running scans', () => {
    const recommendation = recommendationRepository.create({
      projectRoot: '/repo',
      mode: 'incremental-correction',
      reason: 'source refs stale',
      scope: {},
    });

    now = 1_100;
    const queued = recommendationRepository.markQueued(recommendation.id, 'job-1');
    expect(queued).toMatchObject({ status: 'queued', queuedJobId: 'job-1', updatedAt: 1_100 });

    now = 1_200;
    const executedRun = runRepository.create({
      projectRoot: '/repo',
      mode: 'incremental-correction',
      depth: 'standard',
    });
    const executed = recommendationRepository.markExecuted(recommendation.id, executedRun.id);
    expect(executed).toMatchObject({ status: 'executed', executedRunId: executedRun.id });
  });

  test('dismisses pending recommendations with a reason', () => {
    const recommendation = recommendationRepository.create({
      projectRoot: '/repo',
      mode: 'deep-mining',
      reason: 'not useful now',
      scope: {},
    });

    const dismissed = recommendationRepository.dismiss(recommendation.id, 'manual triage');

    expect(dismissed).toMatchObject({
      status: 'dismissed',
      dismissedReason: 'manual triage',
    });
  });
});
