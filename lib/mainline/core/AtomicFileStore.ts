import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { MainlineZonedPath } from "./WriteBoundary.js";

export interface MainlineAtomicJsonlReadOptions {
  readonly limit?: number;
}

/**
 * MainlineAtomicFileStore 提供最小安全文件持久化能力。
 * JSON 使用 tmp+rename 原子写；JSONL 使用追加写，适合日志、事件、候选记录。
 */
export class MainlineAtomicFileStore {
  async readText(target: MainlineZonedPath): Promise<string | null> {
    try {
      return await fs.readFile(target.absolute, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async writeTextAtomic(target: MainlineZonedPath, content: string | Buffer): Promise<void> {
    await fs.mkdir(path.dirname(target.absolute), { recursive: true });
    const tmpPath = `${target.absolute}.${process.pid}.${randomUUID()}.tmp`;
    // 先写同目录临时文件再 rename，保证读者不会看到半截 JSON；同目录也避免跨设备 rename 失败。
    await fs.writeFile(tmpPath, content, { mode: 0o600 });
    await fs.rename(tmpPath, target.absolute);
  }

  async appendText(target: MainlineZonedPath, content: string): Promise<void> {
    await fs.mkdir(path.dirname(target.absolute), { recursive: true });
    await fs.appendFile(target.absolute, content, "utf8");
  }

  async readJson<T>(target: MainlineZonedPath): Promise<T | null> {
    const raw = await this.readText(target);
    if (raw === null) {
      return null;
    }
    return JSON.parse(raw) as T;
  }

  async writeJsonAtomic(target: MainlineZonedPath, value: unknown): Promise<void> {
    await this.writeTextAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
  }

  async appendJsonl(target: MainlineZonedPath, value: unknown): Promise<void> {
    await this.appendText(target, `${JSON.stringify(value)}\n`);
  }

  async readJsonl<T>(
    target: MainlineZonedPath,
    options: MainlineAtomicJsonlReadOptions = {},
  ): Promise<T[]> {
    const raw = await this.readText(target);
    if (raw === null) {
      return [];
    }

    const entries: T[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      entries.push(JSON.parse(trimmed) as T);
    }

    return options.limit ? entries.slice(-options.limit) : entries;
  }
}
