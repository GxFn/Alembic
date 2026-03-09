/**
 * ClipboardManager - 跨平台剪贴板读写
 *
 * macOS: pbcopy / pbpaste
 * Linux: xclip 或 xsel (X11)，wl-copy / wl-paste (Wayland)
 * Windows: PowerShell Get-Clipboard / Set-Clipboard
 *
 * 支持保存/恢复剪贴板内容，避免破坏用户原有剪贴板。
 * V2 ESM 版本。
 */

import { execSync } from 'node:child_process';

const TIMEOUT = 3000;

const PLATFORM = process.platform;

/** 检测 Linux 剪贴板后端 */
function _linuxBackend() {
  // Wayland
  if (process.env.WAYLAND_DISPLAY) {
    try {
      execSync('which wl-copy', { stdio: 'ignore', timeout: TIMEOUT });
      return 'wl';
    } catch {
      /* fallthrough */
    }
  }
  // X11
  try {
    execSync('which xclip', { stdio: 'ignore', timeout: TIMEOUT });
    return 'xclip';
  } catch {
    /* fallthrough */
  }
  try {
    execSync('which xsel', { stdio: 'ignore', timeout: TIMEOUT });
    return 'xsel';
  } catch {
    /* fallthrough */
  }
  return null;
}

/** 缓存 Linux 后端检测结果 */
let _cachedLinuxBackend: 'xclip' | 'xsel' | 'wl' | null | undefined;
function getLinuxBackend() {
  if (_cachedLinuxBackend === undefined) {
    _cachedLinuxBackend = _linuxBackend();
  }
  return _cachedLinuxBackend;
}

/**
 * 读取剪贴板内容
 * @returns 剪贴板文本，失败返回空字符串
 */
export function read() {
  try {
    if (PLATFORM === 'darwin') {
      return execSync('pbpaste', { encoding: 'utf8', timeout: TIMEOUT });
    }
    if (PLATFORM === 'win32') {
      return execSync('powershell.exe -NoProfile -Command Get-Clipboard', {
        encoding: 'utf8',
        timeout: TIMEOUT,
      }).replace(/\r?\n$/, '');
    }
    // Linux
    const backend = getLinuxBackend();
    if (backend === 'wl') {
      return execSync('wl-paste --no-newline 2>/dev/null', { encoding: 'utf8', timeout: TIMEOUT });
    }
    if (backend === 'xclip') {
      return execSync('xclip -selection clipboard -o', { encoding: 'utf8', timeout: TIMEOUT });
    }
    if (backend === 'xsel') {
      return execSync('xsel --clipboard --output', { encoding: 'utf8', timeout: TIMEOUT });
    }
    return '';
  } catch {
    return '';
  }
}

/** 写入内容到剪贴板 */
export function write(text: string) {
  try {
    if (PLATFORM === 'darwin') {
      execSync('pbcopy', { input: text, timeout: TIMEOUT, stdio: ['pipe', 'ignore', 'ignore'] });
      return true;
    }
    if (PLATFORM === 'win32') {
      execSync('powershell.exe -NoProfile -Command "$input | Set-Clipboard"', {
        input: text,
        timeout: TIMEOUT,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      return true;
    }
    // Linux
    const backend = getLinuxBackend();
    if (backend === 'wl') {
      execSync('wl-copy', { input: text, timeout: TIMEOUT, stdio: ['pipe', 'ignore', 'ignore'] });
      return true;
    }
    if (backend === 'xclip') {
      execSync('xclip -selection clipboard', {
        input: text,
        timeout: TIMEOUT,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      return true;
    }
    if (backend === 'xsel') {
      execSync('xsel --clipboard --input', {
        input: text,
        timeout: TIMEOUT,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 保存当前剪贴板 → 执行回调 → 恢复剪贴板
 *
 * @param fn 在剪贴板保存期间执行的函数
 * @returns fn 的返回值
 */
export async function withClipboardSave(fn: () => Promise<unknown>) {
  const saved = read();
  try {
    return await fn();
  } finally {
    if (saved) {
      write(saved);
    }
  }
}
