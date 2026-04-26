import { describe, expect, test } from 'vitest';
import { InMemoryTerminalSessionManager } from '../../lib/tools/adapters/TerminalSessionManager.js';

describe('InMemoryTerminalSessionManager', () => {
  test('leases ephemeral sessions without retaining them', () => {
    const manager = new InMemoryTerminalSessionManager();

    const acquired = manager.acquire(
      {
        mode: 'ephemeral',
        id: null,
        cwdPersistence: 'none',
        envPersistence: 'none',
        processPersistence: 'none',
      },
      {
        callId: 'call-1',
        projectRoot: '/repo',
        cwd: '/repo',
        now: new Date('2026-04-25T00:00:00.000Z'),
      }
    );

    expect(acquired.ok).toBe(true);
    if (!acquired.ok) {
      return;
    }
    expect(acquired.lease.record).toMatchObject({
      id: 'ephemeral:call-1',
      mode: 'ephemeral',
      status: 'busy',
      activeCallId: 'call-1',
    });

    const released = acquired.lease.release({ now: new Date('2026-04-25T00:00:01.000Z') });
    expect(released).toMatchObject({
      status: 'closed',
      activeCallId: null,
      commandCount: 1,
    });
    expect(manager.snapshot('ephemeral:call-1')).toBeNull();
  });

  test('enforces exclusive persistent session leases', () => {
    const manager = new InMemoryTerminalSessionManager();
    const plan = {
      mode: 'persistent' as const,
      id: 'build',
      cwdPersistence: 'none' as const,
      envPersistence: 'none' as const,
      processPersistence: 'none' as const,
    };

    const first = manager.acquire(plan, {
      callId: 'call-1',
      projectRoot: '/repo',
      cwd: '/repo',
      now: new Date('2026-04-25T00:00:00.000Z'),
    });
    expect(first.ok).toBe(true);

    const second = manager.acquire(plan, {
      callId: 'call-2',
      projectRoot: '/repo',
      cwd: '/repo',
    });
    expect(second).toEqual({
      ok: false,
      error: expect.stringContaining('already running'),
    });

    if (!first.ok) {
      return;
    }
    first.lease.release({
      cwd: '/repo/packages/app',
      now: new Date('2026-04-25T00:00:01.000Z'),
    });

    expect(manager.snapshot('build')).toMatchObject({
      id: 'build',
      status: 'idle',
      activeCallId: null,
      commandCount: 1,
      cwd: '/repo/packages/app',
    });
  });

  test('cleans up expired persistent sessions', () => {
    const manager = new InMemoryTerminalSessionManager({ persistentTtlMs: 1000 });
    const acquired = manager.acquire(
      {
        mode: 'persistent',
        id: 'short-lived',
        cwdPersistence: 'none',
        envPersistence: 'none',
        processPersistence: 'none',
      },
      {
        callId: 'call-1',
        projectRoot: '/repo',
        cwd: '/repo',
        now: new Date('2026-04-25T00:00:00.000Z'),
      }
    );

    if (!acquired.ok) {
      throw new Error(acquired.error);
    }
    acquired.lease.release({ now: new Date('2026-04-25T00:00:00.500Z') });

    expect(manager.cleanup(new Date('2026-04-25T00:00:01.400Z'))).toBe(0);
    expect(manager.cleanup(new Date('2026-04-25T00:00:01.500Z'))).toBe(1);
    expect(manager.snapshot('short-lived')).toBeNull();
  });

  test('persists explicit environment metadata without exposing values in records', () => {
    const manager = new InMemoryTerminalSessionManager();
    const plan = {
      mode: 'persistent' as const,
      id: 'env-session',
      cwdPersistence: 'none' as const,
      envPersistence: 'explicit' as const,
      processPersistence: 'none' as const,
    };

    const first = manager.acquire(plan, {
      callId: 'call-1',
      projectRoot: '/repo',
      cwd: '/repo',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.lease.record.envKeys).toEqual([]);
    first.lease.release({ env: { ALEMBIC_TEST_ENV: 'secret-value' } });

    const second = manager.acquire(plan, {
      callId: 'call-2',
      projectRoot: '/repo',
      cwd: '/repo',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.lease.env).toEqual({ ALEMBIC_TEST_ENV: 'secret-value' });
    expect(second.lease.record).toMatchObject({
      envKeys: ['ALEMBIC_TEST_ENV'],
    });
    expect(JSON.stringify(second.lease.record)).not.toContain('secret-value');
  });
});
