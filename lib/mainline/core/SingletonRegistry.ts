export type MainlineSingletonFactory<T> = () => T;

export interface MainlineSingletonRegistration<T> {
  readonly key: string;
  readonly factory: MainlineSingletonFactory<T>;
  readonly description?: string;
}

export interface MainlineSingletonSnapshot {
  registeredKeys: string[];
  initializedKeys: string[];
}

/**
 * MainlineSingletonRegistry 是新主线的小型单例容器。
 * 它只负责惰性创建和缓存对象，不做模块自动注册、不读环境变量、
 * 不启动后台任务，也不承载旧 ServiceContainer 的平台职责。
 */
export class MainlineSingletonRegistry {
  readonly #factories = new Map<string, MainlineSingletonRegistration<unknown>>();
  readonly #instances = new Map<string, unknown>();

  register<T>(registration: MainlineSingletonRegistration<T>): void {
    if (this.#factories.has(registration.key)) {
      throw new Error(`Mainline singleton already registered: ${registration.key}`);
    }
    this.#factories.set(registration.key, registration);
  }

  set<T>(key: string, value: T): void {
    this.#instances.set(key, value);
  }

  get<T>(key: string): T {
    if (this.#instances.has(key)) {
      return this.#instances.get(key) as T;
    }

    const registration = this.#factories.get(key);
    if (!registration) {
      throw new Error(`Mainline singleton not registered: ${key}`);
    }

    const value = registration.factory();
    this.#instances.set(key, value);
    return value as T;
  }

  has(key: string): boolean {
    return this.#factories.has(key) || this.#instances.has(key);
  }

  reset(key?: string): void {
    if (key) {
      this.#instances.delete(key);
      return;
    }
    this.#instances.clear();
  }

  snapshot(): MainlineSingletonSnapshot {
    return {
      registeredKeys: [...this.#factories.keys()].sort(),
      initializedKeys: [...this.#instances.keys()].sort(),
    };
  }
}
