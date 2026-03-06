/**
 * AsyncPersistence — WAL (Write-Ahead Log) + 异步写入
 *
 * 设计:
 * - 写操作先追加到 WAL 文件 (NDJSON + CRC32), 再应用到内存
 * - 定时 (2s) 或积累 100 条操作后 flush: 写入完整 .asvec + 清理 WAL
 * - 启动时: 加载 .asvec 主文件, 然后 replay WAL 中未刷盘的操作
 * - WAL 条目带 CRC32 校验, 损坏条目跳过 (数据最终由 .asvec 兜底)
 *
 * WAL 格式 (NDJSON):
 *   每行: JSON\tCRC32_HEX\n
 *   JSON: { "t": 1, "id": "doc_1", "c": "content", "v": [...], "m": {...} }
 *   t=1: upsert, t=2: remove, t=3: clear
 *
 * @module infrastructure/vector/AsyncPersistence
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

// ── WAL 操作类型 ──
export const WAL_OP = Object.freeze({
  UPSERT: 1,
  REMOVE: 2,
  CLEAR: 3,
});

/**
 * CRC32 校验 (ISO 3309 / ITU-T V.42 polynomial)
 * 纯 JS 实现, 零依赖
 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    table[i] = crc;
  }
  return table;
})();

/**
 * 计算字符串的 CRC32 校验值
 * @param {string} str
 * @returns {string} 8 位十六进制字符串
 */
function crc32(str) {
  const bytes = Buffer.from(str, 'utf-8');
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

export class AsyncPersistence {
  /** @type {string} 主索引文件路径 (.asvec) */
  #indexPath;
  /** @type {string} WAL 文件路径 (.wal) */
  #walPath;
  /** @type {Array<object>} 待刷盘操作队列 */
  #pendingOps = [];
  /** @type {ReturnType<typeof setTimeout>|null} */
  #flushTimer = null;
  /** @type {boolean} */
  #flushing = false;
  /** @type {number} flush 间隔 (ms) */
  #flushIntervalMs;
  /** @type {number} 触发立即 flush 的操作数 */
  #flushBatchSize;
  /** @type {function} 外部提供的 persist 回调: () => Promise<void> */
  #onPersist;
  /** @type {function} 外部提供的 replay 回调: (op) => void */
  #onReplay;
  /** @type {boolean} WAL 是否启用 */
  #enabled;

  /**
   * @param {object} options
   * @param {string} options.indexPath - 主索引文件路径 (.asvec)
   * @param {function} options.onPersist - persist 回调: async () => void (写完整 .asvec)
   * @param {function} options.onReplay - replay 回调: (op) => void (重放单条操作)
   * @param {boolean}  [options.enabled=true] - 是否启用 WAL
   * @param {number}   [options.flushIntervalMs=2000]
   * @param {number}   [options.flushBatchSize=100]
   */
  constructor(options) {
    this.#indexPath = options.indexPath;
    this.#walPath = options.indexPath.replace(/\.asvec$/, '.wal');
    this.#onPersist = options.onPersist;
    this.#onReplay = options.onReplay;
    this.#enabled = options.enabled !== false;
    this.#flushIntervalMs = options.flushIntervalMs || 2000;
    this.#flushBatchSize = options.flushBatchSize || 100;

    // 确保目录存在
    const dir = dirname(this.#walPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** WAL 文件路径 (供外部测试/调试) */
  get walPath() {
    return this.#walPath;
  }

  /** 当前待刷盘操作数量 */
  get pendingCount() {
    return this.#pendingOps.length;
  }

  /** 是否正在刷盘 */
  get isFlushing() {
    return this.#flushing;
  }

  /**
   * 追加操作到 WAL
   * 操作同时写入磁盘 WAL 文件 (append) 和内存队列
   *
   * @param {object} op - WAL 操作
   * @param {number} op.t - 操作类型: 1=upsert, 2=remove, 3=clear
   * @param {string} [op.id] - 文档 ID
   * @param {string} [op.c] - 内容 (upsert)
   * @param {number[]} [op.v] - 向量 (upsert)
   * @param {object} [op.m] - metadata (upsert)
   */
  appendWal(op) {
    if (!this.#enabled) {
      return;
    }

    this.#pendingOps.push(op);
    this.#writeWalEntry(op);
    this.#scheduleFlush();
  }

  /**
   * 将单条 WAL 条目追加到磁盘 WAL 文件
   * 格式: JSON\tCRC32_HEX\n
   */
  #writeWalEntry(op) {
    try {
      const json = JSON.stringify(op);
      const checksum = crc32(json);
      const entry = `${json}\t${checksum}\n`;
      appendFileSync(this.#walPath, entry, 'utf-8');
    } catch {
      // 写入失败非致命: 操作已在内存队列, flush 时会写入完整文件
    }
  }

  /**
   * 调度 flush (debounced)
   */
  #scheduleFlush() {
    if (this.#flushing) {
      return;
    }

    // 积累够多操作时立即 flush
    if (this.#pendingOps.length >= this.#flushBatchSize) {
      this.#doFlush();
      return;
    }

    // 否则 debounced
    if (this.#flushTimer) {
      return;
    }
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#doFlush();
    }, this.#flushIntervalMs);
    if (this.#flushTimer?.unref) {
      this.#flushTimer.unref();
    }
  }

  /**
   * 执行 flush: 写入完整 .asvec + 清理 WAL
   */
  async #doFlush() {
    if (this.#flushing) {
      return;
    }
    if (this.#pendingOps.length === 0) {
      return;
    }

    this.#flushing = true;
    const ops = this.#pendingOps.splice(0);

    try {
      // 调用外部 persist 回调写入完整 .asvec
      await this.#onPersist();

      // 成功后清理 WAL 文件
      this.#clearWal();
    } catch {
      // persist 失败: WAL 文件保留, 下次启动时可以 replay
      // 将 ops 放回队列头部
      this.#pendingOps.unshift(...ops);
    } finally {
      this.#flushing = false;
    }
  }

  /**
   * 手动触发 flush (用于关闭/测试)
   */
  async flush() {
    // 取消待执行的定时器
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    await this.#doFlush();
  }

  /**
   * 启动时恢复: 读取 WAL 文件, replay 有效条目
   * WAL 条目带 CRC32 校验, 损坏条目跳过
   *
   * @returns {{ replayed: number, skipped: number }}
   */
  recover() {
    if (!this.#enabled) {
      return { replayed: 0, skipped: 0 };
    }
    if (!existsSync(this.#walPath)) {
      return { replayed: 0, skipped: 0 };
    }

    let replayed = 0;
    let skipped = 0;

    try {
      const content = readFileSync(this.#walPath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.length > 0);

      for (const line of lines) {
        const tabIdx = line.lastIndexOf('\t');
        if (tabIdx === -1) {
          skipped++;
          continue;
        }

        const json = line.slice(0, tabIdx);
        const expectedCrc = line.slice(tabIdx + 1);

        // CRC 校验
        const actualCrc = crc32(json);
        if (actualCrc !== expectedCrc) {
          skipped++;
          continue;
        }

        // 解析并 replay
        try {
          const op = JSON.parse(json);
          this.#onReplay(op);
          replayed++;
        } catch {
          skipped++;
        }
      }

      // replay 完成后清理 WAL
      if (replayed > 0 || skipped > 0) {
        this.#clearWal();
      }
    } catch {
      // WAL 文件读取失败, 跳过恢复
    }

    return { replayed, skipped };
  }

  /**
   * 清理 WAL 文件
   */
  #clearWal() {
    try {
      if (existsSync(this.#walPath)) {
        unlinkSync(this.#walPath);
      }
    } catch {
      // 删除失败非致命
    }
  }

  /**
   * 销毁: 清理定时器
   */
  destroy() {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
  }

  /**
   * 同步 flush (用于进程退出时)
   * 注意: 只清理定时器, 不执行实际 persist (由调用方负责)
   */
  destroySync() {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
  }
}

// 导出 CRC32 工具函数 (用于测试)
export { crc32 };
