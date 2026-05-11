import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheCoordinator } from '../../lib/infrastructure/cache/CacheCoordinator.js';

/**
 * CacheCoordinator 单元测试
 *
 * 用 mock SqliteDatabase 模拟 data_version 变化，验证跨进程失效逻辑。
 */

function makeMockDb(initialVersion = 1) {
  let version = initialVersion;
  return {
    pragma(_stmt: string, _opts?: { simple: boolean }) {
      return version;
    },
    /** 测试辅助：模拟其他进程写入导致 data_version 递增 */
    bumpVersion() {
      version++;
    },
  };
}

describe('CacheCoordinator', () => {
  let db: ReturnType<typeof makeMockDb>;
  let coordinator: CacheCoordinator;

  beforeEach(() => {
    db = makeMockDb();
    coordinator = new CacheCoordinator(db as never, 100);
  });

  afterEach(() => {
    coordinator.stop();
  });

  it('should not fire on initial check when version unchanged', () => {
    const handler = vi.fn();
    coordinator.subscribe('test', handler);

    const changed = coordinator.check();

    expect(changed).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('should fire all subscribers when data_version changes', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    coordinator.subscribe('svc1', handler1);
    coordinator.subscribe('svc2', handler2);

    db.bumpVersion();
    const changed = coordinator.check();

    expect(changed).toBe(true);
    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('should not fire again if version unchanged after previous fire', () => {
    const handler = vi.fn();
    coordinator.subscribe('test', handler);

    db.bumpVersion();
    coordinator.check();
    coordinator.check(); // same version

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should fire again on second version bump', () => {
    const handler = vi.fn();
    coordinator.subscribe('test', handler);

    db.bumpVersion();
    coordinator.check();
    db.bumpVersion();
    coordinator.check();

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('should handle subscriber errors without affecting others', () => {
    const failing = vi.fn(() => {
      throw new Error('boom');
    });
    const ok = vi.fn();
    coordinator.subscribe('failing', failing);
    coordinator.subscribe('ok', ok);

    db.bumpVersion();
    coordinator.check();

    expect(failing).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('should unsubscribe correctly', () => {
    const handler = vi.fn();
    const unsub = coordinator.subscribe('temp', handler);

    unsub();
    db.bumpVersion();
    coordinator.check();

    expect(handler).not.toHaveBeenCalled();
  });

  it('should report correct subscriberCount', () => {
    expect(coordinator.subscriberCount).toBe(0);

    const unsub1 = coordinator.subscribe('a', vi.fn());
    coordinator.subscribe('b', vi.fn());
    expect(coordinator.subscriberCount).toBe(2);

    unsub1();
    expect(coordinator.subscriberCount).toBe(1);
  });

  it('should auto-poll when started', async () => {
    const handler = vi.fn();
    coordinator.subscribe('test', handler);
    coordinator.start();

    // 模拟其他进程写入
    db.bumpVersion();

    // 等待至少一个 poll 周期 (100ms)
    await new Promise((r) => setTimeout(r, 200));

    expect(handler).toHaveBeenCalled();
  });

  it('should stop polling on stop()', async () => {
    const handler = vi.fn();
    coordinator.subscribe('test', handler);
    coordinator.start();
    coordinator.stop();

    db.bumpVersion();
    await new Promise((r) => setTimeout(r, 200));

    expect(handler).not.toHaveBeenCalled();
  });
});
