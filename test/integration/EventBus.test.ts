/**
 * 集成测试：EventBus — 应用事件总线
 *
 * 覆盖范围:
 *   - 同步 emit / 异步 emitAsync
 *   - 事件历史记录 & 限制
 *   - 统计信息
 *   - 历史清理
 */

import { EventBus } from '../../lib/infrastructure/event/EventBus.js';

describe('Integration: EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus({ maxListeners: 50, historyLimit: 20 });
  });

  describe('Synchronous emit', () => {
    test('should deliver events to listeners', () => {
      const received: unknown[] = [];
      bus.on('test:event', (data) => received.push(data));

      bus.emit('test:event', { value: 1 });
      bus.emit('test:event', { value: 2 });

      expect(received).toEqual([{ value: 1 }, { value: 2 }]);
    });

    test('should support multiple listeners on same event', () => {
      let count = 0;
      bus.on('multi', () => count++);
      bus.on('multi', () => count++);

      bus.emit('multi');
      expect(count).toBe(2);
    });

    test('should return true if listeners exist', () => {
      bus.on('has', () => {});
      expect(bus.emit('has')).toBe(true);
    });

    test('should return false if no listeners', () => {
      expect(bus.emit('nobody')).toBe(false);
    });
  });

  describe('Asynchronous emitAsync', () => {
    test('should await all async listeners', async () => {
      const order: number[] = [];

      bus.on('async:test', async () => {
        await new Promise((r) => setTimeout(r, 50));
        order.push(1);
      });
      bus.on('async:test', async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(2);
      });

      await bus.emitAsync('async:test');

      // 应该按注册顺序依次 await
      expect(order).toEqual([1, 2]);
    });
  });

  describe('Event history', () => {
    test('should record event history', () => {
      bus.emit('ev:a', 1, 2);
      bus.emit('ev:b');

      const history = bus.getHistory(10);
      expect(history).toHaveLength(2);
      expect(history[0].event).toBe('ev:a');
      expect(history[0].argCount).toBe(2);
      expect(history[1].event).toBe('ev:b');
      expect(history[1].argCount).toBe(0);
    });

    test('should limit by requested count', () => {
      for (let i = 0; i < 10; i++) {
        bus.emit(`e${i}`);
      }
      const recent = bus.getHistory(3);
      expect(recent).toHaveLength(3);
    });

    test('should enforce historyLimit', () => {
      // historyLimit = 20
      for (let i = 0; i < 30; i++) {
        bus.emit(`overflow:${i}`);
      }
      const history = bus.getHistory(100);
      expect(history.length).toBeLessThanOrEqual(20);
    });

    test('should clear history', () => {
      bus.emit('to:clear');
      bus.emit('to:clear');
      bus.clearHistory();
      expect(bus.getHistory()).toHaveLength(0);
    });
  });

  describe('Statistics', () => {
    test('should report event stats', () => {
      bus.on('x', () => {});
      bus.on('y', () => {});

      bus.emit('x');
      bus.emit('x');
      bus.emit('y');
      bus.emit('z'); // no listener

      const stats = bus.getStats();
      expect(stats.totalEvents).toBe(4);
      expect(stats.uniqueEvents).toBe(3);
      expect(stats.byEvent.x).toBe(2);
      expect(stats.byEvent.y).toBe(1);
      expect(stats.byEvent.z).toBe(1);
      expect(stats.activeListeners).toBe(2);
    });
  });

  describe('Max listeners', () => {
    test('should accept configured maxListeners without warning', () => {
      const largeBus = new EventBus({ maxListeners: 100 });
      for (let i = 0; i < 100; i++) {
        largeBus.on('event', () => {});
      }
      expect(largeBus.getMaxListeners()).toBe(100);
    });
  });
});
