export interface SqliteDataVersionReader {
  readDataVersion(): number;
}

export interface ContextIndexInvalidationEvent {
  readonly kind: "sqlite-data-version";
  readonly previousDataVersion: number;
  readonly currentDataVersion: number;
}

export interface ContextIndexInvalidationHandlerError {
  readonly name: string;
  readonly error: unknown;
}

export interface ContextIndexInvalidationCheck {
  readonly changed: boolean;
  readonly previousDataVersion: number;
  readonly currentDataVersion: number;
  readonly handlerErrors: readonly ContextIndexInvalidationHandlerError[];
}

export type ContextIndexInvalidationHandler = (
  event: ContextIndexInvalidationEvent,
) => void | Promise<void>;

/**
 * SqliteDataVersionWatcher 只观察 SQLite 连接级 data_version。
 * 失效边界：它只处理跨连接/跨进程提交后的缓存失效，不替代写入方自己的同步更新。
 */
export class SqliteDataVersionWatcher {
  readonly #reader: SqliteDataVersionReader;
  readonly #handlers = new Map<string, ContextIndexInvalidationHandler>();
  #lastDataVersion: number;

  constructor(reader: SqliteDataVersionReader) {
    this.#reader = reader;
    this.#lastDataVersion = reader.readDataVersion();
  }

  readDataVersion(): number {
    return this.#reader.readDataVersion();
  }

  subscribe(name: string, handler: ContextIndexInvalidationHandler): () => void {
    this.#handlers.set(name, handler);
    return () => {
      this.#handlers.delete(name);
    };
  }

  get subscriberCount(): number {
    return this.#handlers.size;
  }

  async check(): Promise<ContextIndexInvalidationCheck> {
    const currentDataVersion = this.#reader.readDataVersion();
    if (currentDataVersion === this.#lastDataVersion) {
      return {
        changed: false,
        previousDataVersion: this.#lastDataVersion,
        currentDataVersion,
        handlerErrors: [],
      };
    }

    const previousDataVersion = this.#lastDataVersion;
    this.#lastDataVersion = currentDataVersion;
    const event: ContextIndexInvalidationEvent = {
      kind: "sqlite-data-version",
      previousDataVersion,
      currentDataVersion,
    };
    const handlerErrors: ContextIndexInvalidationHandlerError[] = [];

    for (const [name, handler] of this.#handlers) {
      try {
        await handler(event);
      } catch (error) {
        handlerErrors.push({ name, error });
      }
    }

    return { changed: true, previousDataVersion, currentDataVersion, handlerErrors };
  }
}
