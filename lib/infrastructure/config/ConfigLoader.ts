import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * ConfigLoader - 配置加载器
 * 直接读取 JSON 配置文件，避免 node-config 模块在 import 阶段就读取配置目录的时序问题
 */
export class ConfigLoader {
  static instance: any = null;
  static config: any = null;

  static load(env = process.env.NODE_ENV || 'development') {
    if (!this.config) {
      const configDir = path.join(__dirname, '../../../config');

      // 加载默认配置
      const defaultPath = path.join(configDir, 'default.json');
      let merged: any = {};
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
      this.config = merged;
    }

    return this.config;
  }

  static _deepMerge(target, source) {
    const output = { ...target };
    for (const key of Object.keys(source)) {
      if (
        source[key] &&
        typeof source[key] === 'object' &&
        !Array.isArray(source[key]) &&
        target[key] &&
        typeof target[key] === 'object' &&
        !Array.isArray(target[key])
      ) {
        output[key] = this._deepMerge(target[key], source[key]);
      } else {
        output[key] = source[key];
      }
    }
    return output;
  }

  static get(key) {
    if (!this.config) {
      this.load();
    }

    const keys = key.split('.');
    let value = this.config;

    for (const k of keys) {
      value = value?.[k];
      if (value === undefined) {
        throw new Error(`Config key not found: ${key}`);
      }
    }

    return value;
  }

  static has(key) {
    try {
      this.get(key);
      return true;
    } catch {
      return false;
    }
  }

  static set(key, value) {
    if (!this.config) {
      this.load();
    }

    const keys = key.split('.');
    let obj: any = this.config;

    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!obj[k]) {
        obj[k] = {};
      }
      obj = obj[k];
    }

    obj[keys[keys.length - 1]] = value;
  }
}

export default ConfigLoader;
