import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { JobStore } from '../../lib/daemon/JobStore.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;

function useTempAlembicHome(): void {
  process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-job-home-'));
}

function makeProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-job-project-'));
}

afterEach(() => {
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
});

describe('JobStore', () => {
  test('persists daemon jobs and lists newest first', () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const store = new JobStore({ projectRoot });

    const first = store.create({
      actor: { role: 'external_agent', user: 'codex-user' },
      channelId: 'codex',
      client: 'codex-plugin',
      createdByTool: 'alembic_codex_bootstrap',
      kind: 'bootstrap',
      request: { maxFiles: 10 },
      sessionId: 'codex-session',
      source: 'codex',
    });
    store.markRunning(first.id);
    const completed = store.complete(
      first.id,
      { bootstrapSession: { id: 'bs_1' } },
      {
        bootstrapSessionId: 'bs_1',
      }
    );
    const second = store.create({
      kind: 'rescan',
      request: { reason: 'test' },
      source: 'dashboard',
    });

    expect(completed).toMatchObject({
      actor: { role: 'external_agent', user: 'codex-user' },
      channelId: 'codex',
      client: 'codex-plugin',
      createdByTool: 'alembic_codex_bootstrap',
      id: first.id,
      sessionId: 'codex-session',
      status: 'completed',
      bootstrapSessionId: 'bs_1',
    });
    expect(store.get(first.id)?.result).toMatchObject({ bootstrapSession: { id: 'bs_1' } });
    expect(new Set(store.list({ limit: 2 }).map((job) => job.id))).toEqual(
      new Set([first.id, second.id])
    );
    expect(store.list({ kind: 'bootstrap' }).map((job) => job.id)).toEqual([first.id]);
  });

  test('rejects unsafe job ids and records failures', () => {
    useTempAlembicHome();
    const store = new JobStore({ projectRoot: makeProjectRoot() });
    const job = store.create({ kind: 'bootstrap' });

    expect(store.get('../bad')).toBeNull();

    const failed = store.fail(job.id, new Error('boom'));

    expect(failed).toMatchObject({ status: 'failed', error: { message: 'boom' } });
  });

  test('does not allow terminal jobs to be overwritten by late workers', () => {
    useTempAlembicHome();
    const store = new JobStore({ projectRoot: makeProjectRoot() });
    const job = store.create({ kind: 'bootstrap' });

    const cancelled = store.cancel(job.id, 'user cancelled');
    const running = store.markRunning(job.id);
    const completed = store.complete(job.id, { ok: true });
    const failed = store.fail(job.id, new Error('late failure'));

    expect(cancelled).toMatchObject({ status: 'cancelled', error: { message: 'user cancelled' } });
    expect(running).toBeNull();
    expect(completed).toMatchObject({ status: 'cancelled', error: { message: 'user cancelled' } });
    expect(failed).toMatchObject({ status: 'cancelled', error: { message: 'user cancelled' } });
    expect(store.get(job.id)).toMatchObject({
      status: 'cancelled',
      error: { message: 'user cancelled' },
    });
  });

  test('marks queued and running jobs interrupted without touching terminal jobs', () => {
    useTempAlembicHome();
    const store = new JobStore({ projectRoot: makeProjectRoot() });
    const queued = store.create({ kind: 'bootstrap', source: 'codex' });
    const running = store.create({ kind: 'rescan', source: 'dashboard' });
    store.markRunning(running.id);
    const completed = store.create({ kind: 'bootstrap' });
    store.markRunning(completed.id);
    store.complete(completed.id, { ok: true });
    const cancelled = store.create({ kind: 'rescan' });
    store.cancel(cancelled.id, 'user cancelled');

    const interrupted = store.markActiveInterrupted({
      code: 'DAEMON_RESTARTED',
      reason: 'daemon restarted before completion',
    });

    expect(interrupted.map((job) => job.id)).toEqual([queued.id, running.id]);
    expect(store.get(queued.id)).toMatchObject({
      status: 'failed',
      error: { code: 'DAEMON_RESTARTED', message: 'daemon restarted before completion' },
    });
    expect(store.get(running.id)).toMatchObject({
      status: 'failed',
      error: { code: 'DAEMON_RESTARTED', message: 'daemon restarted before completion' },
    });
    expect(store.get(completed.id)).toMatchObject({ status: 'completed' });
    expect(store.get(cancelled.id)).toMatchObject({
      status: 'cancelled',
      error: { message: 'user cancelled' },
    });
  });
});
