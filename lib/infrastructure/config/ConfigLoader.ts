import fs from 'node:fs';
import path from 'node:path';
import { AppConfigSchema } from '../../shared/schemas/config.js';

/**
 * ConfigLoader - 配置加载器
 * 直接读取 JSON 配置文件，避免 node-config 模块在 import 阶段就读取配置目录的时序问题
 */
export class ConfigLoader {
  static instance: ConfigLoader | null = null;
  static config: Record<string, unknown> | null = null;

  /**
   * 沿目录树向上查找包含 package.json（name=autosnippet）的目录。
   * ConfigLoader 是最早加载的模块之一，不能依赖 package-root.ts，因此内联实现。
   */
  static _findPackageRoot(): string {
    let dir = import.meta.dirname;
    for (let i = 0; i < 10; i++) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
          if (pkg.name === 'autosnippet') {
            return dir;
          }
        } catch {
          /* continue */
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    throw new Error('[ConfigLoader] Could not locate package root');
  }

  static load(env = process.env.NODE_ENV || 'development') {
    if (!this.config) {
      // 使用包根自动发现，避免硬编码 ../../../.. 层级
      const configDir = path.join(ConfigLoader._findPackageRoot(), 'config');

      // 加载默认配置
      const defaultPath = path.join(configDir, 'default.json');
      let merged: Record<string, unknown> = {};
      if (fs.existsSync(defaultPath)) {
        merged = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
      }

      // 加载环境专用配置（覆盖默认）
      const envPath = path.join(configDir, `${env}.json`);
      if (fs.existsSync(envPath)) {
        const envConfig = JSON.parse(fs.readFileSync(envPath, 'utf8'));
        merged = this._deepMerge(merged, envConfig);
      }

      // 加载 local 配置（开发者覆盖，不入版本控制）
      const localPath = path.join(configDir, 'local.json');
      if (fs.existsSync(localPath)) {
        const localConfig = JSON.parse(fs.readFileSync(localPath, 'utf8'));
        merged = this._deepMerge(merged, localConfig);
      }

      merged.env = env;

      // Zod 运行时校验（非阻塞，仅警告）
      const result = AppConfigSchema.safeParse(merged);
      if (!result.success) {
        const issues = result.error.issues
          .map((i) => `  ${i.path.join('.')}: ${i.message}`)
          .join('\n');
        process.stderr.write(`[ConfigLoader] ⚠️ Config validation warnings:\n${issues}\n`);
      }

      this.config = merged;
    }

    return this.config;
  }

  static _deepMerge(
    target: Record<string, unknown>,
    source: Record<string, unknown>
  ): Record<string, unknown> {
    const output: Record<string, unknown> = { ...target };
    for (const key of Object.keys(source)) {
      if (
        source[key] &&
        typeof source[key] === 'object' &&
        !Array.isArray(source[key]) &&
        target[key] &&
        typeof target[key] === 'object' &&
        !Array.isArray(target[key])
      ) {
        output[key] = this._deepMerge(
          target[key] as Record<string, unknown>,
          source[key] as Record<string, unknown>
        );
      } else {
        output[key] = source[key];
      }
    }
    return output;
  }

  static get(key: string): unknown {
    if (!this.config) {
      this.load();
    }

    const keys = key.split('.');
    let value: unknown = this.config;

    for (const k of keys) {
      value = (value as Record<string, unknown>)?.[k];
      if (value === undefined) {
        throw new Error(`Config key not found: ${key}`);
      }
    }

    return value;
  }

  static has(key: string) {
    try {
      this.get(key);
      return true;
    } catch {
      return false;
    }
  }

  static set(key: string, value: unknown) {
    if (!this.config) {
      this.load();
    }

    const keys = key.split('.');
    let obj: Record<string, unknown> = this.config as Record<string, unknown>;

    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!obj[k]) {
        obj[k] = {};
      }
      obj = obj[k] as Record<string, unknown>;
    }

    obj[keys[keys.length - 1]] = value;
  }
}

export default ConfigLoader;
