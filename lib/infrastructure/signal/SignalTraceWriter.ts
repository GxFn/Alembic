/**
 * SignalTraceWriter — 全类型信号 JSONL 留痕
 *
 * 订阅 SignalBus 全量信号，按类型分文件写入 JSONL。
 * 替代 SignalModule 中 intent-only 的 JSONL 写入逻辑，统一处理全部类型。
 *
 * @module infrastructure/signal/SignalTraceWriter
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DataPath, WriteZone } from '#infra/io/WriteZone.js';
import type { Signal, SignalBus } from './SignalBus.js';

export interface SignalTraceQueryOptions {
  type?: string[];
  source?: string;
  target?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

export class SignalTraceWriter {
  readonly #baseDir: string;
  readonly #wz: WriteZone | null;

  constructor(signalBus: SignalBus, baseDir: string, writeZone?: WriteZone) {
    this.#baseDir = baseDir;
    this.#wz = writeZone ?? null;

    if (this.#wz) {
      this.#wz.ensureDir(this.#runtimePath(baseDir));
    } else {
      fs.mkdirSync(baseDir, { recursive: true });
    }

    signalBus.subscribe('*', (signal) => {
      this.#write(signal);
    });
  }

  #write(signal: Signal): void {
    try {
      const fileName = this.#resolveFile(signal.type);
      const line = `${JSON.stringify({
        type: signal.type,
        source: signal.source,
        value: signal.value,
        target: signal.target,
        metadata: signal.metadata,
        timestamp: signal.timestamp,
      })}\n`;

      if (this.#wz) {
        this.#wz.appendFile(this.#runtimePath(fileName), line);
      } else {
        fs.appendFileSync(fileName, line, 'utf8');
      }
    } catch {
      // 写入失败不阻断信号分发
    }
  }

  /** 查询历史信号 */
  async query(opts: SignalTraceQueryOptions = {}): Promise<{ signals: Signal[]; total: number }> {
    const types = opts.type?.length ? opts.type : this.#listTypes();
    const all: Signal[] = [];

    for (const t of types) {
      const filePath = this.#resolveFile(t);
      if (!fs.existsSync(filePath)) {
        continue;
      }
      const entries = this.#readJsonl(filePath);
      all.push(...entries);
    }

    // 过滤
    let filtered = all;
    if (opts.source) {
      filtered = filtered.filter((s) => s.source === opts.source);
    }
    if (opts.target) {
      filtered = filtered.filter((s) => s.target === opts.target);
    }
    if (opts.from) {
      filtered = filtered.filter((s) => s.timestamp >= opts.from!);
    }
    if (opts.to) {
      filtered = filtered.filter((s) => s.timestamp <= opts.to!);
    }

    // 按时间倒序
    filtered.sort((a, b) => b.timestamp - a.timestamp);

    const total = filtered.length;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 50;
    const signals = filtered.slice(offset, offset + limit);

    return { signals, total };
  }

  /** 统计信息 */
  async stats(opts: { from?: number; to?: number } = {}): Promise<{
    total: number;
    byType: Record<string, number>;
    bySource: Record<string, number>;
  }> {
    const types = this.#listTypes();
    const byType: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    let total = 0;

    for (const t of types) {
      const filePath = this.#resolveFile(t);
      if (!fs.existsSync(filePath)) {
        continue;
      }
      const entries = this.#readJsonl(filePath);
      for (const e of entries) {
        if (opts.from && e.timestamp < opts.from) {
          continue;
        }
        if (opts.to && e.timestamp > opts.to) {
          continue;
        }
        total++;
        byType[e.type] = (byType[e.type] ?? 0) + 1;
        bySource[e.source] = (bySource[e.source] ?? 0) + 1;
      }
    }

    return { total, byType, bySource };
  }

  // ── Private ───────────────────────────────────────

  #runtimePath(absPath: string): DataPath {
    const asdRoot = path.join(this.#wz!.dataRoot, '.asd');
    return this.#wz!.runtime(path.relative(asdRoot, absPath));
  }

  #resolveFile(type: string): string {
    return path.join(this.#baseDir, `${type}.jsonl`);
  }

  #listTypes(): string[] {
    try {
      return fs
        .readdirSync(this.#baseDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => f.replace('.jsonl', ''));
    } catch {
      return [];
    }
  }

  #readJsonl(filePath: string): Signal[] {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim());
      const entries: Signal[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as Signal);
        } catch {
          // 跳过损坏行
        }
      }
      return entries;
    } catch {
      return [];
    }
  }
}
