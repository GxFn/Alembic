import { describe, expect, test } from 'vitest';
import { ScanJobQueue } from '../../lib/workflows/scan/ScanJobQueue.js';

describe('ScanJobQueue', () => {
  test('runs queued jobs with the configured concurrency', async () => {
    const queue = new ScanJobQueue({ concurrency: 1 });
    const firstGate = deferred<void>();
    const events: string[] = [];

    const first = queue.enqueue({
      mode: 'maintenance',
      request: { id: 'first' },
      execute: async () => {
        events.push('first-start');
        await firstGate.promise;
        events.push('first-finish');
        return { ok: 'first' };
      },
    });
    const second = queue.enqueue({
      mode: 'deep-mining',
      request: { id: 'second' },
      execute: async () => {
        events.push('second-start');
        return { ok: 'second' };
      },
    });

    await Promise.resolve();

    expect(queue.get(first.id)?.status).toBe('running');
    expect(queue.get(second.id)?.status).toBe('queued');

    firstGate.resolve();
    const firstDone = await queue.waitFor(first.id);
    const secondDone = await queue.waitFor(second.id);

    expect(firstDone?.status).toBe('completed');
    expect(secondDone?.status).toBe('completed');
    expect(events).toEqual(['first-start', 'first-finish', 'second-start']);
  });

  test('cancels queued jobs before they start', async () => {
    const queue = new ScanJobQueue({ concurrency: 1 });
    const firstGate = deferred<void>();

    const first = queue.enqueue({
      mode: 'maintenance',
      request: { id: 'first' },
      execute: async () => {
        await firstGate.promise;
        return { ok: true };
      },
    });
    const second = queue.enqueue({
      mode: 'incremental-correction',
      request: { id: 'second' },
      execute: async () => ({ shouldNotRun: true }),
    });

    await Promise.resolve();

    const cancelled = queue.cancel(second.id, 'No longer needed');
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.errorMessage).toBe('No longer needed');

    firstGate.resolve();
    await queue.waitFor(first.id);

    expect(queue.get(second.id)?.status).toBe('cancelled');
  });

  test('marks running jobs as cancelling and then cancelled after completion', async () => {
    const queue = new ScanJobQueue({ concurrency: 1 });
    const gate = deferred<void>();
    let signalWasAborted = false;

    const job = queue.enqueue({
      mode: 'maintenance',
      request: { id: 'running' },
      execute: async ({ signal }) => {
        await gate.promise;
        signalWasAborted = signal.aborted;
        return { finishedAfterCancel: true };
      },
    });

    await Promise.resolve();

    const cancelling = queue.cancel(job.id, 'Stop current scan');
    expect(cancelling?.status).toBe('cancelling');
    expect(cancelling?.cancelRequested).toBe(true);

    gate.resolve();
    const cancelled = await queue.waitFor(job.id);

    expect(signalWasAborted).toBe(true);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.result).toBeNull();
  });

  test('retries failed jobs automatically up to maxAttempts', async () => {
    const queue = new ScanJobQueue();
    let attempts = 0;

    const job = queue.enqueue({
      mode: 'deep-mining',
      request: { scope: 'api' },
      maxAttempts: 2,
      execute: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('transient failure');
        }
        return { ok: true };
      },
    });

    const completed = await queue.waitFor(job.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.attempts).toBe(2);
    expect(completed?.result).toEqual({ ok: true });
  });

  test('supports manual retry for failed terminal jobs', async () => {
    const queue = new ScanJobQueue();
    let shouldFail = true;

    const job = queue.enqueue({
      mode: 'maintenance',
      request: { repair: true },
      execute: async () => {
        if (shouldFail) {
          throw new Error('broken index');
        }
        return { repaired: true };
      },
    });

    const failed = await queue.waitFor(job.id);
    expect(failed?.status).toBe('failed');

    shouldFail = false;
    const retried = queue.retry(job.id);
    expect(retried?.status).toBe('queued');

    const completed = await queue.waitFor(job.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.result).toEqual({ repaired: true });
  });
});

function deferred<T>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
