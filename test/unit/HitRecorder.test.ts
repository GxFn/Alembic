import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Signal } from '../../lib/infrastructure/signal/SignalBus.js';
import { SignalBus } from '../../lib/infrastructure/signal/SignalBus.js';
import { HitRecorder } from '../../lib/service/signal/HitRecorder.js';

/* ════════════════════════════════════════════
 *  HitRecorder 单元测试
 * ════════════════════════════════════════════ */

/** Mock database — 模拟 better-sqlite3 的 prepare().run() */
function createMockDb() {
  const runFn = vi.fn();
  const prepare = vi.fn(() => ({ run: runFn }));
  return { prepare, runFn };
}

describe('HitRecorder', () => {
  let bus: SignalBus;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    bus = new SignalBus();
    mockDb = createMockDb();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('record() emits signal immediately', () => {
    const recorder = new HitRecorder(bus, mockDb);
    const handler = vi.fn();
    bus.subscribe('guard', handler);

    recorder.record('recipe-1', 'guardHit');

    expect(handler).toHaveBeenCalledOnce();
    const signal = handler.mock.calls[0][0] as Signal;
    expect(signal.type).toBe('guard');
    expect(signal.target).toBe('recipe-1');
  });

  test('record() buffers events without immediate DB write', () => {
    const recorder = new HitRecorder(bus, mockDb);

    recorder.record('recipe-1', 'guardHit');
    recorder.record('recipe-2', 'searchHit');

    expect(mockDb.prepare).not.toHaveBeenCalled();
    expect(recorder.bufferSize).toBe(2);
  });

  test('flush() writes buffered events to DB', async () => {
    const recorder = new HitRecorder(bus, mockDb);

    recorder.record('recipe-1', 'guardHit');
    recorder.record('recipe-1', 'guardHit');
    recorder.record('recipe-2', 'searchHit');

    const flushed = await recorder.flush();

    expect(mockDb.prepare).toHaveBeenCalledOnce();
    // recipe-1:guardHit aggregated to count=2, recipe-2:searchHit count=1
    expect(mockDb.runFn).toHaveBeenCalledTimes(2);
    expect(flushed).toBe(3); // total count: 2+1
    expect(recorder.bufferSize).toBe(0);
  });

  test('flush() is no-op when buffer is empty', async () => {
    const recorder = new HitRecorder(bus, mockDb);
    const flushed = await recorder.flush();

    expect(flushed).toBe(0);
    expect(mockDb.prepare).not.toHaveBeenCalled();
  });

  test('aggregates same recipe+eventType in buffer', () => {
    const recorder = new HitRecorder(bus, mockDb);

    recorder.record('recipe-1', 'guardHit');
    recorder.record('recipe-1', 'guardHit');
    recorder.record('recipe-1', 'guardHit');

    expect(recorder.bufferSize).toBe(1); // single key
    expect(recorder.totalRecorded).toBe(3);
  });

  test('different event types for same recipe are separate buffer entries', () => {
    const recorder = new HitRecorder(bus, mockDb);

    recorder.record('recipe-1', 'guardHit');
    recorder.record('recipe-1', 'searchHit');

    expect(recorder.bufferSize).toBe(2);
  });

  test('auto-flushes when buffer reaches maxBufferSize', async () => {
    const recorder = new HitRecorder(bus, mockDb, { maxBufferSize: 3 });

    recorder.record('r1', 'guardHit');
    recorder.record('r2', 'guardHit');
    // At this point buffer size = 2, no flush yet
    expect(mockDb.prepare).not.toHaveBeenCalled();

    recorder.record('r3', 'guardHit');
    // buffer size = 3 → triggers flush
    // Need to wait for the async flush
    await vi.runAllTimersAsync();
    expect(recorder.bufferSize).toBe(0);
  });

  test('start() schedules periodic flush', async () => {
    const recorder = new HitRecorder(bus, mockDb, { flushIntervalMs: 1000 });
    recorder.start();

    recorder.record('r1', 'guardHit');

    // Advance timer by flush interval
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockDb.prepare).toHaveBeenCalled();
    expect(recorder.bufferSize).toBe(0);
  });

  test('stop() clears timer and does final flush', async () => {
    const recorder = new HitRecorder(bus, mockDb, { flushIntervalMs: 1000 });
    recorder.start();

    recorder.record('r1', 'guardHit');
    await recorder.stop();

    expect(recorder.bufferSize).toBe(0);
    expect(recorder.totalFlushed).toBe(1);
  });

  test('start() is idempotent', () => {
    const recorder = new HitRecorder(bus, mockDb);
    recorder.start();
    recorder.start(); // second call should not create another timer
    // No error thrown
  });

  test('maps eventType to correct stats field', async () => {
    const recorder = new HitRecorder(bus, mockDb);

    recorder.record('r1', 'guardHit');
    recorder.record('r2', 'searchHit');
    recorder.record('r3', 'view');
    recorder.record('r4', 'adoption');
    recorder.record('r5', 'application');

    await recorder.flush();

    // Check that prepare was called with the UPDATE statement
    expect(mockDb.prepare).toHaveBeenCalledOnce();

    // Check each run call has correct field name
    const calls = mockDb.runFn.mock.calls as unknown[][];
    const fields = calls.map((c) => c[0]);
    expect(fields).toContain('guardHits');
    expect(fields).toContain('searchHits');
    expect(fields).toContain('views');
    expect(fields).toContain('adoptions');
    expect(fields).toContain('applications');
  });

  test('maps eventType to correct signal type', () => {
    const recorder = new HitRecorder(bus, mockDb);
    const received: Signal[] = [];
    bus.subscribe('*', (s) => received.push(s));

    recorder.record('r1', 'guardHit');
    recorder.record('r2', 'searchHit');
    recorder.record('r3', 'view');
    recorder.record('r4', 'adoption');

    expect(received[0].type).toBe('guard');
    expect(received[1].type).toBe('search');
    expect(received[2].type).toBe('usage');
    expect(received[3].type).toBe('usage');
  });

  test('DB prepare failure causes buffer rollback', async () => {
    const failDb = {
      prepare: vi.fn(() => {
        throw new Error('DB closed');
      }),
    };
    const recorder = new HitRecorder(bus, failDb);

    recorder.record('r1', 'guardHit');
    recorder.record('r2', 'guardHit');

    await recorder.flush();

    // Buffer should be restored
    expect(recorder.bufferSize).toBe(2);
    expect(recorder.totalFlushed).toBe(0);
  });

  test('individual run() failure is silently ignored', async () => {
    const failRunDb = {
      prepare: vi.fn(() => ({
        run: vi.fn(() => {
          throw new Error('recipe deleted');
        }),
      })),
    };
    const recorder = new HitRecorder(bus, failRunDb);

    recorder.record('r1', 'guardHit');
    const flushed = await recorder.flush();

    // run failed but buffer was cleared
    expect(recorder.bufferSize).toBe(0);
    expect(flushed).toBe(0); // nothing actually flushed
  });

  test('totalRecorded and totalFlushed track correctly', async () => {
    const recorder = new HitRecorder(bus, mockDb);

    recorder.record('r1', 'guardHit');
    recorder.record('r1', 'guardHit');
    recorder.record('r2', 'searchHit');

    expect(recorder.totalRecorded).toBe(3);
    expect(recorder.totalFlushed).toBe(0);

    await recorder.flush();

    expect(recorder.totalRecorded).toBe(3);
    expect(recorder.totalFlushed).toBe(3);
  });

  test('accepts DatabaseConnection-like object with getDb()', () => {
    const rawDb = createMockDb();
    const dbConnection = { getDb: () => rawDb };
    const recorder = new HitRecorder(bus, dbConnection);

    recorder.record('r1', 'guardHit');
    expect(recorder.bufferSize).toBe(1);
  });
});
