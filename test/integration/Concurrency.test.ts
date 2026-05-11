/**
 * 集成测试：Concurrency — p-limit 并发控制
 *
 * 覆盖范围:
 *   - ioLimit 预设 (concurrency = 20)
 *   - cpuLimit 预设 (concurrency = 4)
 *   - createLimit() 自定义并发
 *   - createLimit() 参数校验 (RangeError)
 *   - 实际并发限制行为验证
 */

import { cpuLimit, createLimit, ioLimit } from '../../lib/shared/concurrency.js';

describe('Integration: Concurrency (p-limit)', () => {
  describe('presets', () => {
    test('ioLimit should be a function', () => {
      expect(typeof ioLimit).toBe('function');
    });

    test('cpuLimit should be a function', () => {
      expect(typeof cpuLimit).toBe('function');
    });

    test('ioLimit should execute tasks', async () => {
      const result = await ioLimit(() => 42);
      expect(result).toBe(42);
    });

    test('cpuLimit should execute tasks', async () => {
      const result = await cpuLimit(() => 'done');
      expect(result).toBe('done');
    });

    test('ioLimit should handle async tasks', async () => {
      const result = await ioLimit(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 'async-result';
      });
      expect(result).toBe('async-result');
    });
  });

  describe('createLimit()', () => {
    test('should create a working limit function', async () => {
      const limit = createLimit(2);
      expect(typeof limit).toBe('function');

      const result = await limit(() => 'ok');
      expect(result).toBe('ok');
    });

    test('should accept concurrency of 1', () => {
      expect(() => createLimit(1)).not.toThrow();
    });

    test('should accept large concurrency', () => {
      expect(() => createLimit(1000)).not.toThrow();
    });

    test('should throw RangeError for 0', () => {
      expect(() => createLimit(0)).toThrow(RangeError);
    });

    test('should throw RangeError for negative', () => {
      expect(() => createLimit(-1)).toThrow(RangeError);
    });

    test('should throw RangeError for NaN', () => {
      expect(() => createLimit(NaN)).toThrow(RangeError);
    });

    test('should throw RangeError for Infinity', () => {
      expect(() => createLimit(Infinity)).toThrow(RangeError);
    });

    test('should throw RangeError for -Infinity', () => {
      expect(() => createLimit(-Infinity)).toThrow(RangeError);
    });

    test('should throw RangeError for fractional < 1', () => {
      expect(() => createLimit(0.5)).toThrow(RangeError);
    });
  });

  describe('actual concurrency limiting', () => {
    test('should limit concurrent execution to specified count', async () => {
      const limit = createLimit(2);
      let running = 0;
      let maxRunning = 0;

      const task = () =>
        limit(async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((r) => setTimeout(r, 50));
          running--;
        });

      // Start 6 tasks that should be limited to 2 concurrent
      await Promise.all(Array.from({ length: 6 }, () => task()));

      expect(maxRunning).toBe(2);
    });

    test('should allow full concurrency within limit', async () => {
      const limit = createLimit(10);
      let running = 0;
      let maxRunning = 0;

      const task = () =>
        limit(async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((r) => setTimeout(r, 30));
          running--;
        });

      // 5 tasks with limit 10 → all 5 should run concurrently
      await Promise.all(Array.from({ length: 5 }, () => task()));

      expect(maxRunning).toBe(5);
    });

    test('ioLimit should limit to 20 concurrent', async () => {
      let running = 0;
      let maxRunning = 0;

      const task = () =>
        ioLimit(async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((r) => setTimeout(r, 20));
          running--;
        });

      await Promise.all(Array.from({ length: 30 }, () => task()));

      expect(maxRunning).toBe(20);
    });

    test('cpuLimit should limit to 4 concurrent', async () => {
      let running = 0;
      let maxRunning = 0;

      const task = () =>
        cpuLimit(async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((r) => setTimeout(r, 20));
          running--;
        });

      await Promise.all(Array.from({ length: 10 }, () => task()));

      expect(maxRunning).toBe(4);
    });

    test('should propagate errors from tasks', async () => {
      const limit = createLimit(2);

      await expect(
        limit(async () => {
          throw new Error('task failed');
        })
      ).rejects.toThrow('task failed');
    });

    test('should return task results in order', async () => {
      const limit = createLimit(2);

      const results = await Promise.all([
        limit(async () => {
          await new Promise((r) => setTimeout(r, 30));
          return 'a';
        }),
        limit(async () => {
          await new Promise((r) => setTimeout(r, 10));
          return 'b';
        }),
        limit(async () => {
          return 'c';
        }),
      ]);

      expect(results).toEqual(['a', 'b', 'c']);
    });
  });
});
