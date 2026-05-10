export type MainlineEnvValue = string | undefined;
export type MainlineEnvRecord = Record<string, MainlineEnvValue>;

export interface MainlineEnvironmentSnapshot {
  values: Record<string, string>;
  redactedValues: Record<string, string>;
}

const SECRET_KEY_PATTERN = /key|token|secret|password|credential/i;

/**
 * MainlineEnvironment 统一管理新主线能看到的环境数据。
 * mainline 内部应该依赖它，而不是在各层散落读取 process.env。
 */
export class MainlineEnvironment {
  readonly #values: MainlineEnvRecord;

  constructor(values: MainlineEnvRecord = {}) {
    this.#values = { ...values };
  }

  get(key: string): string | undefined {
    const value = this.#values[key];
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
  }

  require(key: string): string {
    const value = this.get(key);
    if (!value) {
      throw new Error(`Mainline environment value missing: ${key}`);
    }
    return value;
  }

  getBoolean(key: string, fallback = false): boolean {
    const value = this.get(key)?.toLowerCase();
    if (!value) {
      return fallback;
    }
    return value === "1" || value === "true" || value === "yes" || value === "on";
  }

  getNumber(key: string, fallback: number): number {
    const value = Number(this.get(key));
    return Number.isFinite(value) ? value : fallback;
  }

  getList(key: string): string[] {
    return uniqueStrings((this.get(key) ?? "").split(","));
  }

  withOverrides(overrides: MainlineEnvRecord): MainlineEnvironment {
    return new MainlineEnvironment({ ...this.#values, ...overrides });
  }

  snapshot(keys?: readonly string[]): MainlineEnvironmentSnapshot {
    const selectedKeys = keys ?? Object.keys(this.#values);
    const values: Record<string, string> = {};
    const redactedValues: Record<string, string> = {};

    for (const key of selectedKeys) {
      const value = this.get(key);
      if (!value) {
        continue;
      }
      values[key] = value;
      redactedValues[key] = SECRET_KEY_PATTERN.test(key) ? redact(value) : value;
    }

    return { values, redactedValues };
  }
}

export function createMainlineEnvironment(values: MainlineEnvRecord): MainlineEnvironment {
  return new MainlineEnvironment(values);
}

function redact(value: string): string {
  if (value.length <= 6) {
    return "***";
  }
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}
