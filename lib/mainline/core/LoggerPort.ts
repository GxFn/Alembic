export type MainlineLogLevel = "debug" | "info" | "warn" | "error";
export type MainlineLogMetadata = Record<string, unknown>;

export interface MainlineLogRecord {
  readonly level: MainlineLogLevel;
  readonly message: string;
  readonly scope?: string;
  readonly timestamp: string;
  readonly metadata?: MainlineLogMetadata;
}

export interface MainlineLogger {
  child(scope: string): MainlineLogger;
  debug(message: string, metadata?: MainlineLogMetadata): void;
  info(message: string, metadata?: MainlineLogMetadata): void;
  warn(message: string, metadata?: MainlineLogMetadata): void;
  error(message: string, metadata?: MainlineLogMetadata): void;
}

/**
 * NoopMainlineLogger 是新主线的默认日志端口。
 * 它让底层模块可以稳定依赖日志接口，但不会在没有 adapter 时写文件或污染 stdout。
 */
export class NoopMainlineLogger implements MainlineLogger {
  child(_scope: string): MainlineLogger {
    return this;
  }

  debug(_message: string, _metadata?: MainlineLogMetadata): void {}

  info(_message: string, _metadata?: MainlineLogMetadata): void {}

  warn(_message: string, _metadata?: MainlineLogMetadata): void {}

  error(_message: string, _metadata?: MainlineLogMetadata): void {}
}

/**
 * MemoryMainlineLogger 用于测试和上层调试面板。
 * 子 logger 共享同一个 records 数组，便于完整观察一次流程的日志轨迹。
 */
export class MemoryMainlineLogger implements MainlineLogger {
  readonly #scope?: string;
  readonly #records: MainlineLogRecord[];

  constructor(options: { scope?: string; records?: MainlineLogRecord[] } = {}) {
    if (options.scope !== undefined) {
      this.#scope = options.scope;
    }
    this.#records = options.records ?? [];
  }

  get records(): readonly MainlineLogRecord[] {
    return [...this.#records];
  }

  child(scope: string): MainlineLogger {
    return new MemoryMainlineLogger({
      scope: joinScope(this.#scope, scope),
      records: this.#records,
    });
  }

  debug(message: string, metadata?: MainlineLogMetadata): void {
    this.#push("debug", message, metadata);
  }

  info(message: string, metadata?: MainlineLogMetadata): void {
    this.#push("info", message, metadata);
  }

  warn(message: string, metadata?: MainlineLogMetadata): void {
    this.#push("warn", message, metadata);
  }

  error(message: string, metadata?: MainlineLogMetadata): void {
    this.#push("error", message, metadata);
  }

  #push(level: MainlineLogLevel, message: string, metadata?: MainlineLogMetadata): void {
    this.#records.push({
      level,
      message,
      timestamp: new Date().toISOString(),
      ...(this.#scope === undefined ? {} : { scope: this.#scope }),
      ...(metadata ? { metadata: { ...metadata } } : {}),
    });
  }
}

function joinScope(parent: string | undefined, child: string): string {
  return parent ? `${parent}.${child}` : child;
}
