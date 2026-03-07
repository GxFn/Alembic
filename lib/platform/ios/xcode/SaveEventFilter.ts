/**
 * SaveEventFilter - 区分用户保存与 Xcode 自动保存
 *
 * 三层过滤策略：
 * 1. Self-write 冷却期：AutoSnippet 自身写入的文件在冷却期内忽略变更
 * 2. 内容哈希去重：文件内容未变时跳过处理
 * 3. Xcode 焦点检测：Xcode 不是前台应用时跳过（典型的切窗口自动保存场景）
 *
 * 使用方式：
 *   import { saveEventFilter } from './SaveEventFilter.js';
 *
 *   // 在 handler 写文件时标记
 *   saveEventFilter.markSelfWrite(filePath);
 *   fs.writeFileSync(filePath, content);
 *
 *   // 在 FileWatcher 处理前判断
 *   const verdict = saveEventFilter.shouldProcess(filePath, content);
 *   if (!verdict.process) { console.log(verdict.reason); return; }
 */

import { createHash } from 'node:crypto';
import { isXcodeFrontmost } from './XcodeAutomation.js';

/* ────────── 配置 ────────── */

/** Self-write 冷却期（ms） */
const SELF_WRITE_COOLDOWN = 2000;

/** 是否启用 Xcode 焦点过滤（可通过 ASD_SAVE_FILTER=0 关闭） */
function isFilterEnabled() {
  return process.env.ASD_SAVE_FILTER !== '0';
}

/** 是否启用 Xcode 焦点检测（可通过 ASD_XCODE_FOCUS_CHECK=0 单独关闭） */
function isFocusCheckEnabled() {
  return process.env.ASD_XCODE_FOCUS_CHECK !== '0';
}

/* ────────── SaveEventFilter ────────── */

class SaveEventFilter {
  _cleanupInterval: ReturnType<typeof setInterval>;
  _contentHashes: Map<string, string>;
  _selfWrites: Map<string, number>;
  constructor() {
    /** @type {Map<string, number>} filePath → 最后一次 self-write 的时间戳 */
    this._selfWrites = new Map();

    /** @type {Map<string, string>} filePath → 上次处理时的内容 MD5 哈希 */
    this._contentHashes = new Map();

    // 定期清理过期条目，防止内存泄漏
    this._cleanupInterval = setInterval(() => this._cleanup(), 60_000);
    if (this._cleanupInterval.unref) {
      this._cleanupInterval.unref();
    }
  }

  /**
   * 标记 AutoSnippet 即将写入某个文件
   * 在 fs.writeFile / writeFileSync 之前调用本方法
   *
   * @param {string} filePath 绝对路径
   */
  markSelfWrite(filePath: string) {
    this._selfWrites.set(filePath, Date.now());
  }

  /**
   * 判断是否应该处理该文件的变更事件
   *
   * @param {string} filePath 绝对路径
   * @param {string} content  文件当前的完整内容
   * @returns {{ process: boolean, reason: string }}
   */
  shouldProcess(filePath: string, content: string) {
    if (!isFilterEnabled()) {
      return { process: true, reason: 'filter-disabled' };
    }

    // ── Layer 1: Self-write 冷却期 ──
    const lastSelfWrite = this._selfWrites.get(filePath);
    if (lastSelfWrite && Date.now() - lastSelfWrite < SELF_WRITE_COOLDOWN) {
      if (process.env.ASD_DEBUG === '1') {
      }
      return { process: false, reason: 'self-write-cooldown' };
    }

    // ── Layer 2: 内容哈希去重 ──
    const hash = this._hash(content);
    const prevHash = this._contentHashes.get(filePath);
    if (prevHash && prevHash === hash) {
      if (process.env.ASD_DEBUG === '1') {
      }
      return { process: false, reason: 'content-unchanged' };
    }

    // ── Layer 3: Xcode 焦点检测 ──
    if (process.platform === 'darwin' && isFocusCheckEnabled()) {
      if (!isXcodeFrontmost()) {
        if (process.env.ASD_DEBUG === '1') {
        }
        return { process: false, reason: 'xcode-not-frontmost' };
      }
    }

    return { process: true, reason: 'ok' };
  }

  /**
   * 处理完成后更新内容哈希
   * 在文件指令处理完毕后调用
   *
   * @param {string} filePath 绝对路径
   * @param {string} content 处理后的文件内容
   */
  updateHash(filePath: string, content: string) {
    this._contentHashes.set(filePath, this._hash(content));
  }

  /**
   * 在 handler 写文件之前同时标记 self-write + 更新哈希
   * 方便一步完成
   *
   * @param {string} filePath 绝对路径
   * @param {string} newContent 即将写入的新内容
   */
  markWrite(filePath: string, newContent: string) {
    this.markSelfWrite(filePath);
    this._contentHashes.set(filePath, this._hash(newContent));
  }

  /**
   * 清除某文件的所有状态（通常不需要调用）
   */
  clear(filePath: string) {
    this._selfWrites.delete(filePath);
    this._contentHashes.delete(filePath);
  }

  /* ────────── 内部方法 ────────── */

  _hash(content: string) {
    return createHash('md5').update(content).digest('hex');
  }

  _cleanup() {
    const now = Date.now();
    const expiry = 10 * 60 * 1000; // 10 分钟

    for (const [k, ts] of this._selfWrites) {
      if (now - ts > expiry) {
        this._selfWrites.delete(k);
      }
    }

    // 内容哈希保留更长时间，只清理明显过期的
    // （文件仍被监听期间不应清理，所以这里保守处理）
    if (this._contentHashes.size > 1000) {
      // 超过 1000 个文件说明有泄漏，全部清理
      this._contentHashes.clear();
    }
  }
}

/** 单例 */
export const saveEventFilter = new SaveEventFilter();
export default saveEventFilter;
