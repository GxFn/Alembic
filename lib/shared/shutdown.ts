/**
 * shutdown.ts — 统一 Graceful Shutdown 协调器
 *
 * 所有入口（mcp-server / api-server / cli）共用同一个 shutdown 协调器，
 * 避免各入口重复编写 signal handler 并确保：
 *   1. 防重入 — 多次信号只执行一轮 shutdown
 *   2. 倒序执行 — 后注册的 hook 先关闭（类似栈 LIFO）
 *   3. 强制超时 — 超过 TIMEOUT 强杀进程（默认 10 秒）
 *   4. WAL checkpoint — DB 关闭前刷盘
 *   5. hook 隔离 — 单个 hook 失败不阻断后续 hook 执行
 *
 * @module shared/shutdown
 *
 * @example
 *   import { shutdown } from '#shared/shutdown.js';
 *
 *   shutdown.install();
 *   shutdown.register(() => db.close());
 *   shutdown.register(async () => await server.drain());
 */

/** Async or sync cleanup function */
type ShutdownHook = () => Promise<void> | void;

const DEFAULT_TIMEOUT_MS = 10_000;

class ShutdownCoordinator {
  /** Registered hooks executed in LIFO order */
  readonly #hooks: { label: string; fn: ShutdownHook }[] = [];

  /** Guard against re-entrant execution */
  #shutting = false;

  /** Configurable timeout (milliseconds) */
  #timeoutMs: number = DEFAULT_TIMEOUT_MS;

  /**
   * Register a shutdown hook.
   *
   * Hooks execute in **reverse** registration order (LIFO):
   * last registered = first executed.
   *
   * @param fn   Cleanup function (sync or async)
   * @param label  Human-readable label for logging (e.g. 'database', 'http-server')
   */
  register(fn: ShutdownHook, label = 'anonymous') {
    this.#hooks.push({ label, fn });
  }

  /**
   * Set the forced-exit timeout.
   * @default 10_000 (10 seconds)
   */
  setTimeout(ms: number) {
    this.#timeoutMs = ms;
  }

  /**
   * Execute all registered hooks in reverse order, then exit.
   * Safe to call multiple times — only the first invocation runs.
   *
   * @param signal The signal or reason string (for logging)
   */
  async execute(signal: string) {
    if (this.#shutting) {
      return;
    }
    this.#shutting = true;

    process.stderr.write(`[shutdown] ${signal} received, draining…\n`);

    // Hard timeout safeguard
    const timer = setTimeout(() => {
      process.stderr.write('[shutdown] Timeout reached, forcing exit\n');
      process.exit(1);
    }, this.#timeoutMs);
    timer.unref(); // Don't keep the event loop alive

    // Execute hooks in reverse order (LIFO)
    const reversed = [...this.#hooks].reverse();
    let hasFailure = false;
    for (const { label, fn } of reversed) {
      try {
        await fn();
        process.stderr.write(`[shutdown] ✓ ${label}\n`);
      } catch (err: unknown) {
        hasFailure = true;
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[shutdown] ✗ ${label}: ${msg}\n`);
      }
    }

    clearTimeout(timer);
    process.stderr.write(`[shutdown] Complete, exiting (code=${hasFailure ? 1 : 0})\n`);
    process.exit(hasFailure ? 1 : 0);
  }

  /**
   * Install SIGTERM + SIGINT handlers on the current process.
   * Call this once, early in the entry's lifecycle.
   */
  install() {
    const handler = (signal: string) => {
      // Use void to suppress unhandled promise warning —
      // the execute() method self-terminates with process.exit()
      void this.execute(signal);
    };
    process.on('SIGTERM', () => handler('SIGTERM'));
    process.on('SIGINT', () => handler('SIGINT'));
  }

  /** Whether a shutdown is currently in progress */
  get isShuttingDown() {
    return this.#shutting;
  }

  /** Number of registered hooks (for testing / diagnostics) */
  get hookCount() {
    return this.#hooks.length;
  }
}

/**
 * Singleton shutdown coordinator.
 * Import and use across all entry points and modules.
 */
export const shutdown = new ShutdownCoordinator();
