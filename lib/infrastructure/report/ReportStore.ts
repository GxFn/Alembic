/**
 * ReportStore — 报告持久化服务
 *
 * 管道产物（governance / compliance / metrics / analysis）写入 JSONL，
 * 供 API 查询历史报告。
 *
 * @module infrastructure/report/ReportStore
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DataPath, WriteZone } from '#infra/io/WriteZone.js';

// ── Types ───────────────────────────────────────────

export type ReportCategory = 'governance' | 'compliance' | 'metrics' | 'analysis';

export interface ReportEntry {
  /** 自动生成 `rpt-{date}-{rand}` */
  id: string;
  category: ReportCategory;
  /** 如 'metabolism_cycle', 'redundancy_report' */
  type: string;
  /** 生产者类名 */
  producer: string;
  data: Record<string, unknown>;
  timestamp: number;
  duration_ms?: number;
}

export interface ReportQueryOptions {
  category?: ReportCategory[];
  type?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

// ── Constants ───────────────────────────────────────

const VALID_CATEGORIES: ReadonlySet<string> = new Set<ReportCategory>([
  'governance',
  'compliance',
  'metrics',
  'analysis',
]);

// ── ReportStore ─────────────────────────────────────

export class ReportStore {
  readonly #baseDir: string;
  readonly #wz: WriteZone | null;

  constructor(baseDir: string, writeZone?: WriteZone) {
    this.#baseDir = baseDir;
    this.#wz = writeZone ?? null;
  }

  /** 写入一条报告（追加 JSONL） */
  async write(entry: Omit<ReportEntry, 'id'>): Promise<ReportEntry> {
    const id = ReportStore.#generateId(entry.timestamp);
    const full: ReportEntry = { id, ...entry };
    const filePath = this.#resolveFile(entry.category, entry.timestamp);

    if (this.#wz) {
      const target = this.#runtimePath(filePath);
      this.#wz.ensureDir(this.#runtimePath(path.dirname(filePath)));
      this.#wz.appendFile(target, `${JSON.stringify(full)}\n`);
    } else {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(filePath, `${JSON.stringify(full)}\n`, 'utf8');
    }
    return full;
  }

  /** 查询报告列表 */
  async query(opts: ReportQueryOptions = {}): Promise<{ reports: ReportEntry[]; total: number }> {
    const categories = opts.category?.length
      ? opts.category.filter((c) => VALID_CATEGORIES.has(c))
      : ([...VALID_CATEGORIES] as ReportCategory[]);

    const all: ReportEntry[] = [];

    for (const cat of categories) {
      const catDir = path.join(this.#baseDir, cat);
      if (!fs.existsSync(catDir)) {
        continue;
      }
      const files = fs
        .readdirSync(catDir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .reverse();
      for (const file of files) {
        const entries = this.#readJsonl(path.join(catDir, file));
        all.push(...entries);
      }
    }

    // 过滤
    let filtered = all;
    if (opts.type) {
      filtered = filtered.filter((e) => e.type === opts.type);
    }
    if (opts.from) {
      filtered = filtered.filter((e) => e.timestamp >= opts.from!);
    }
    if (opts.to) {
      filtered = filtered.filter((e) => e.timestamp <= opts.to!);
    }

    // 按时间倒序
    filtered.sort((a, b) => b.timestamp - a.timestamp);

    const total = filtered.length;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 20;
    const reports = filtered.slice(offset, offset + limit);

    return { reports, total };
  }

  /** 分类统计 */
  async stats(opts: { from?: number; to?: number } = {}): Promise<Record<string, number>> {
    const result: Record<string, number> = {};

    for (const cat of VALID_CATEGORIES) {
      const catDir = path.join(this.#baseDir, cat);
      if (!fs.existsSync(catDir)) {
        result[cat] = 0;
        continue;
      }
      const files = fs.readdirSync(catDir).filter((f) => f.endsWith('.jsonl'));
      let count = 0;
      for (const file of files) {
        const entries = this.#readJsonl(path.join(catDir, file));
        for (const e of entries) {
          if (opts.from && e.timestamp < opts.from) {
            continue;
          }
          if (opts.to && e.timestamp > opts.to) {
            continue;
          }
          count++;
        }
      }
      result[cat] = count;
    }

    return result;
  }

  // ── Private ───────────────────────────────────────

  /** 将绝对路径转换为 WriteZone runtime DataPath */
  #runtimePath(absPath: string): DataPath {
    const asdRoot = path.join(this.#wz!.dataRoot, '.asd');
    return this.#wz!.runtime(path.relative(asdRoot, absPath));
  }

  #resolveFile(category: string, timestamp: number): string {
    const d = new Date(timestamp);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return path.join(this.#baseDir, category, `${dateStr}.jsonl`);
  }

  #readJsonl(filePath: string): ReportEntry[] {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim());
      const entries: ReportEntry[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as ReportEntry);
        } catch {
          // 跳过损坏行
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  static #generateId(timestamp: number): string {
    const d = new Date(timestamp);
    const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const rand = randomBytes(4).toString('hex');
    return `rpt-${dateStr}-${rand}`;
  }
}
