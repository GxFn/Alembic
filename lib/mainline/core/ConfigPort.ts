export interface MainlineConfigSnapshot {
  readonly source: string;
  readonly values: Record<string, unknown>;
  readonly redactedValues: Record<string, unknown>;
}

export interface MainlineConfigPort {
  source(): string;
  has(key: string): boolean;
  get<T = unknown>(key: string): T | undefined;
  require<T = unknown>(key: string): T;
  snapshot(): MainlineConfigSnapshot;
}

const SECRET_KEY_PATTERN = /key|token|secret|password|credential/i;

/**
 * ObjectMainlineConfig 是新主线的不可变配置端口实现。
 * 它保留 deep merge 与点路径读取能力，但不读取 package config、不写 stderr、不改 process.env。
 */
export class ObjectMainlineConfig implements MainlineConfigPort {
  readonly #source: string;
  readonly #values: Record<string, unknown>;

  constructor(values: Record<string, unknown> = {}, source = "object") {
    this.#source = source;
    this.#values = cloneRecord(values);
  }

  static fromLayers(
    layers: readonly Record<string, unknown>[],
    source = "layers",
  ): ObjectMainlineConfig {
    return new ObjectMainlineConfig(
      layers.reduce((merged, layer) => deepMerge(merged, layer), {}),
      source,
    );
  }

  source(): string {
    return this.#source;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  get<T = unknown>(key: string): T | undefined {
    return readPath(this.#values, key) as T | undefined;
  }

  require<T = unknown>(key: string): T {
    const value = this.get<T>(key);
    if (value === undefined) {
      throw new Error(`Mainline config key missing: ${key}`);
    }
    return value;
  }

  snapshot(): MainlineConfigSnapshot {
    const values = cloneRecord(this.#values);
    return {
      source: this.#source,
      values,
      redactedValues: redactRecord(values),
    };
  }
}

function readPath(values: Record<string, unknown>, key: string): unknown {
  let current: unknown = values;
  for (const segment of key.split(".")) {
    if (!segment || typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const output = cloneRecord(target);
  for (const [key, value] of Object.entries(source)) {
    const existing = output[key];
    output[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>)
        : cloneValue(value);
  }
  return output;
}

function redactRecord(values: Record<string, unknown>, parentKey = ""): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const fullKey = parentKey ? `${parentKey}.${key}` : key;
    if (typeof value === "string" && SECRET_KEY_PATTERN.test(fullKey)) {
      output[key] = redactString(value);
    } else if (isPlainObject(value)) {
      output[key] = redactRecord(value as Record<string, unknown>, fullKey);
    } else {
      output[key] = cloneValue(value);
    }
  }
  return output;
}

function redactString(value: string): string {
  if (value.length <= 6) {
    return "***";
  }
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function cloneRecord(values: Record<string, unknown>): Record<string, unknown> {
  return cloneValue(values) as Record<string, unknown>;
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        cloneValue(nested),
      ]),
    );
  }
  return value;
}

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
