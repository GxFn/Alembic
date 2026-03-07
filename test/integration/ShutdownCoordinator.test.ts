/**
 * 集成测试：ShutdownCoordinator — 优雅退出协调器
 *
 * 覆盖范围:
 *   - register / hookCount
 *   - LIFO 倒序执行
 *   - 防重入 (re-entrancy guard)
 *   - hook 隔离（单个 hook 失败不阻断后续）
 *   - isShuttingDown 状态
 *   - setTimeout 可配置
 *   - process.exit mock
 *
 * 注意: shutdown.ts 导出的是单例，测试中需要创建新的独立实例
 *       来避免影响全局状态。我们通过直接 import class 来测试。
 */

// ShutdownCoordinator 类没有直接导出，所以我们通过测试 singleton export 来验证行为
// 但为了隔离性，我们需要解决重入问题

describe('Integration: ShutdownCoordinator', () => {
  // 由于 ShutdownCoordinator class 未直接导出，我们需要每个测试一个新 module
  // 使用动态 import 搭配 vi.resetModules 来获取独立实例

  let shutdown: typeof import('../../lib/shared/shutdown.js').shutdown;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../lib/shared/shutdown.js');
    shutdown = mod.shutdown;

    // Mock process.exit to prevent test runner from exiting
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe('register / hookCount', () => {
    test('should start with 0 hooks', () => {
      expect(shutdown.hookCount).toBe(0);
    });

    test('should increment hookCount on register', () => {
      shutdown.register(() => {}, 'hook-1');
      expect(shutdown.hookCount).toBe(1);

      shutdown.register(() => {}, 'hook-2');
      expect(shutdown.hookCount).toBe(2);
    });

    test('should accept async hooks', () => {
      shutdown.register(async () => {
        await new Promise((r) => setTimeout(r, 1));
      }, 'async-hook');
      expect(shutdown.hookCount).toBe(1);
    });

    test('should use default label "anonymous"', () => {
      // Just ensures no error with default label
      shutdown.register(() => {});
      expect(shutdown.hookCount).toBe(1);
    });
  });

  describe('isShuttingDown', () => {
    test('should be false initially', () => {
      expect(shutdown.isShuttingDown).toBe(false);
    });

    test('should be true during execution', async () => {
      shutdown.register(() => {
        expect(shutdown.isShuttingDown).toBe(true);
      }, 'check-state');

      await shutdown.execute('TEST');
      expect(shutdown.isShuttingDown).toBe(true);
    });
  });

  describe('execute', () => {
    test('should execute registered hooks', async () => {
      const executed: string[] = [];
      shutdown.register(() => {
        executed.push('a');
      }, 'a');
      shutdown.register(() => {
        executed.push('b');
      }, 'b');

      await shutdown.execute('TEST');

      expect(executed).toContain('a');
      expect(executed).toContain('b');
    });

    test('should execute hooks in LIFO order', async () => {
      const order: string[] = [];
      shutdown.register(() => {
        order.push('first');
      }, 'first');
      shutdown.register(() => {
        order.push('second');
      }, 'second');
      shutdown.register(() => {
        order.push('third');
      }, 'third');

      await shutdown.execute('TEST');

      expect(order).toEqual(['third', 'second', 'first']);
    });

    test('should call process.exit(0) on success', async () => {
      shutdown.register(() => {}, 'noop');
      await shutdown.execute('TEST');

      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test('should call process.exit(1) on hook failure', async () => {
      shutdown.register(() => {
        throw new Error('boom');
      }, 'fail');
      await shutdown.execute('TEST');

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    test('should log to stderr', async () => {
      shutdown.register(() => {}, 'test-hook');
      await shutdown.execute('SIGTERM');

      expect(stderrSpy).toHaveBeenCalled();
      const allOutput = stderrSpy.mock.calls.map((c: [string, ...unknown[]]) => c[0]).join('');
      expect(allOutput).toContain('SIGTERM');
      expect(allOutput).toContain('test-hook');
    });
  });

  describe('re-entrancy guard', () => {
    test('should only execute once on multiple calls', async () => {
      let count = 0;
      shutdown.register(() => {
        count++;
      }, 'counter');

      // Call execute twice concurrently
      await Promise.all([shutdown.execute('SIGTERM'), shutdown.execute('SIGINT')]);

      expect(count).toBe(1);
    });
  });

  describe('hook isolation', () => {
    test('should continue after hook failure', async () => {
      const executed: string[] = [];

      // Registered first → executed last (LIFO)
      shutdown.register(() => {
        executed.push('survivor');
      }, 'survivor');
      // Registered second → executed first (LIFO)
      shutdown.register(() => {
        throw new Error('💥');
      }, 'crasher');

      await shutdown.execute('TEST');

      // survivor should still execute despite crasher failing
      expect(executed).toContain('survivor');
    });

    test('should continue after async hook failure', async () => {
      const executed: string[] = [];

      shutdown.register(() => {
        executed.push('ok');
      }, 'ok');
      shutdown.register(async () => {
        throw new Error('async fail');
      }, 'async-fail');

      await shutdown.execute('TEST');

      expect(executed).toContain('ok');
    });
  });

  describe('setTimeout', () => {
    test('should accept custom timeout', () => {
      // Should not throw
      shutdown.setTimeout(5000);
      expect(shutdown.hookCount).toBe(0); // just verify no side effects
    });

    test('should work with very short timeout', async () => {
      shutdown.setTimeout(100);
      shutdown.register(() => {}, 'quick');
      await shutdown.execute('TEST');
      expect(exitSpy).toHaveBeenCalled();
    });
  });

  describe('install', () => {
    test('should register SIGTERM and SIGINT handlers', () => {
      const onSpy = vi.spyOn(process, 'on');

      shutdown.install();

      const signalCalls = onSpy.mock.calls.filter(
        ([event]) => event === 'SIGTERM' || event === 'SIGINT'
      );
      expect(signalCalls.length).toBe(2);

      onSpy.mockRestore();
    });
  });
});
