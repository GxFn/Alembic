/**
 * lifecycle.ts — 统一生命周期接口
 *
 * 所有持有定时器、连接、文件句柄等资源的组件应实现 Disposable 或 Startable。
 * 配合 TimerRegistry 和 ShutdownCoordinator 实现统一资源回收。
 *
 * @module shared/lifecycle
 */

/**
 * 可释放资源的统一接口。
 *
 * 所有持有定时器、连接、文件句柄的组件必须实现此接口。
 * `dispose()` 必须幂等 — 多次调用安全。
 */
export interface Disposable {
  dispose(): Promise<void> | void;
}

/**
 * 可启停的服务接口（Disposable 的超集）。
 *
 * 适用于需要显式 start/stop 生命周期的组件（如 HitRecorder、SignalAggregator）。
 */
export interface Startable extends Disposable {
  start(): void;
  stop(): Promise<void> | void;
}
