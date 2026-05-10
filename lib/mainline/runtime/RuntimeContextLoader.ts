import type { ContextIndexReader } from "../data/index.js";
import type { MainlineSearchIndex } from "../search/index.js";

export interface RuntimeContextHandle {
  readonly contextIndex: ContextIndexReader;
  readonly searchIndex: MainlineSearchIndex;
  dispose?(): Promise<void> | void;
}

export interface RuntimeContextProvider {
  loadRuntimeContext(): Promise<RuntimeContextHandle> | RuntimeContextHandle;
  dispose?(): Promise<void> | void;
}

export interface RuntimeContextLoaderOptions {
  readonly contextIndex?: ContextIndexReader | undefined;
  readonly searchIndex?: MainlineSearchIndex | undefined;
  readonly provider?: RuntimeContextProvider | undefined;
}

/**
 * RuntimeContextLoader 只装配已经构造好的只读运行期依赖。
 * 中文注释：这里不创建 SQLite adapter、不扫 Markdown、不恢复文件索引。
 */
export class RuntimeContextLoader {
  readonly #contextIndex: ContextIndexReader | undefined;
  readonly #searchIndex: MainlineSearchIndex | undefined;
  readonly #provider: RuntimeContextProvider | undefined;
  #handle: RuntimeContextHandle | undefined;
  #disposed = false;

  constructor(options: RuntimeContextLoaderOptions = {}) {
    this.#contextIndex = options.contextIndex;
    this.#searchIndex = options.searchIndex;
    this.#provider = options.provider;
  }

  async load(): Promise<RuntimeContextHandle> {
    if (this.#disposed) {
      throw new Error("RuntimeContextLoader is disposed");
    }
    if (this.#handle) {
      return this.#handle;
    }
    if (this.#provider) {
      this.#handle = await this.#provider.loadRuntimeContext();
      return this.#handle;
    }
    if (!this.#contextIndex || !this.#searchIndex) {
      throw new Error("RuntimeContextLoader requires contextIndex and searchIndex");
    }
    this.#handle = {
      contextIndex: this.#contextIndex,
      searchIndex: this.#searchIndex,
    };
    return this.#handle;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    await this.#handle?.dispose?.();
    await this.#provider?.dispose?.();
  }
}
