/**
 * ClipboardManager - 剪贴板读写（macOS pbcopy/pbpaste）
 *
 * 支持保存/恢复剪贴板内容，避免破坏用户原有剪贴板。
 * V2 ESM 版本。
 */

import { execSync } from 'node:child_process';

const TIMEOUT = 3000;

/**
 * 读取剪贴板内容
 * @returns {string} 剪贴板文本，失败返回空字符串
 */
export function read() {
  if (process.platform !== 'darwin') {
    return '';
  }
  try {
    return execSync('pbpaste', { encoding: 'utf8', timeout: TIMEOUT });
  } catch {
    return '';
  }
}

/**
 * 写入内容到剪贴板
 * @param {string} text
 * @returns {boolean}
 */
export function write(text) {
  if (process.platform !== 'darwin') {
    return false;
  }
  try {
    execSync('pbcopy', { input: text, timeout: TIMEOUT, stdio: ['pipe', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * 保存当前剪贴板 → 执行回调 → 恢复剪贴板
 *
 * @param {Function} fn 在剪贴板保存期间执行的函数
 * @returns {*} fn 的返回值
 */
export async function withClipboardSave(fn) {
  const saved = read();
  try {
    return await fn();
  } finally {
    if (saved) {
      write(saved);
    }
  }
}
