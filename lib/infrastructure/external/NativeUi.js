/**
 * NativeUi - macOS 原生 UI 交互层
 *
 * 三层降级策略：
 * 1. Swift Helper 二进制 (resources/native-ui/native-ui)
 * 2. AppleScript 回退 (choose from list / display alert)
 * 3. 控制台输出回退 (非 macOS 或非 TTY)
 *
 * V2 ESM 版本，对应 V1 NativeUi.js
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const NATIVE_UI_PATH = join(__dirname, '../../../resources/native-ui/native-ui');
const NATIVE_UI_SRC = join(__dirname, '../../../resources/native-ui/main.swift');
const NATIVE_UI_COMBINED = join(__dirname, '../../../resources/native-ui/combined-window.swift');

/** 记录是否已尝试过 lazy build，避免重复 */
let _lazyBuildAttempted = false;

/**
 * 尝试即时编译 native-ui（仅 macOS + swiftc 可用时）
 * 只调用一次，结果缓存到 _lazyBuildAttempted
 */
function _tryLazyBuild() {
  if (_lazyBuildAttempted) return;
  _lazyBuildAttempted = true;

  if (process.platform !== 'darwin') return;
  if (!existsSync(NATIVE_UI_SRC) || !existsSync(NATIVE_UI_COMBINED)) return;

  try {
    execSync('which swiftc', { stdio: 'pipe' });
  } catch {
    return;
  }

  try {
    execSync(
      `swiftc "${NATIVE_UI_SRC}" "${NATIVE_UI_COMBINED}" -o "${NATIVE_UI_PATH}" -framework AppKit`,
      { stdio: 'pipe', timeout: 120_000 }
    );
  } catch {
    // 编译失败 — 静默降级
  }
}

/**
 * 检查 Swift Helper 是否可用
 */
export function isNativeUiAvailable() {
  if (process.platform !== 'darwin') {
    return false;
  }
  try {
    if (existsSync(NATIVE_UI_PATH)) {
      return true;
    }
    // 二进制不存在 — 尝试即时编译
    _tryLazyBuild();
    return existsSync(NATIVE_UI_PATH);
  } catch {
    return false;
  }
}

/**
 * 用组合窗口展示搜索结果（列表 + 预览）
 *
 * @param {Array<{title: string, code: string, explanation?: string, groupSize?: number}>} items
 * @param {string} keyword 搜索关键词
 * @returns {number} 选中的索引（0-based），-1 表示取消
 */
export function showCombinedWindow(items, keyword = '') {
  if (!items || items.length === 0) {
    return -1;
  }

  // 1. 尝试 Swift Helper
  if (isNativeUiAvailable()) {
    try {
      const safeKeyword = keyword.replace(/'/g, "'\\''");
      const json = JSON.stringify(items);
      const safeJson = json.replace(/'/g, "'\\''");
      const result = execFileSync(NATIVE_UI_PATH, ['combined', safeKeyword, safeJson], {
        encoding: 'utf8',
        timeout: 60000,
      }).trim();
      const index = parseInt(result, 10);
      return Number.isNaN(index) ? -1 : index;
    } catch (err) {
      // exit(1) = 用户取消，直接返回 -1，不降级
      if (err.status === 1) {
        return -1;
      }
      // 其他错误（崩溃等）才降级到 AppleScript
    }
  }

  // 2. macOS AppleScript 回退（choose from list → display dialog 预览）
  if (process.platform === 'darwin') {
    try {
      return _appleScriptCombinedWindow(items, keyword);
    } catch {
      // 回退
    }
  }

  // 3. 控制台输出回退
  return _consoleFallback(items, keyword);
}

/**
 * 简单列表选择弹窗
 *
 * @param {string[]} items 选项列表
 * @param {string} title 窗口标题
 * @param {string} prompt 提示文本
 * @returns {number} 选中索引（0-based），-1 取消
 */
export function showListSelection(items, title = 'AutoSnippet', prompt = '请选择：') {
  if (!items || items.length === 0) {
    return -1;
  }

  // 1. Swift Helper
  if (isNativeUiAvailable()) {
    try {
      const args = ['list', ...items];
      const result = execFileSync(NATIVE_UI_PATH, args, {
        encoding: 'utf8',
        timeout: 60000,
      }).trim();
      const index = parseInt(result, 10);
      return Number.isNaN(index) ? -1 : index;
    } catch (err) {
      // exit(1) = 用户取消，直接返回
      if (err.status === 1) {
        return -1;
      }
      // 其他错误才降级
    }
  }

  // 2. AppleScript
  if (process.platform === 'darwin') {
    try {
      const listStr = items.map((i) => `"${i.replace(/"/g, '\\"')}"`).join(', ');
      const script = `choose from list {${listStr}} with title "${_escAS(title)}" with prompt "${_escAS(prompt)}" default items {"${_escAS(items[0])}"}`;
      const result = execSync(`osascript -e '${script}'`, {
        encoding: 'utf8',
        timeout: 30000,
      }).trim();
      if (result === 'false') {
        return -1;
      }
      return items.indexOf(result);
    } catch {
      return -1;
    }
  }

  return -1;
}

/**
 * 代码预览确认弹窗
 *
 * @param {string} title 标题
 * @param {string} code 代码内容
 * @returns {boolean} 用户是否确认
 */
export function showPreviewConfirm(title, code) {
  // 1. Swift Helper
  if (isNativeUiAvailable()) {
    try {
      const _result = execFileSync(NATIVE_UI_PATH, ['preview', title, code], {
        encoding: 'utf8',
        timeout: 60000,
      });
      return true; // exit 0 = confirmed
    } catch {
      return false;
    }
  }

  // 2. AppleScript
  if (process.platform === 'darwin') {
    try {
      const preview = code.length > 300 ? `${code.substring(0, 297)}...` : code;
      const script = `display dialog "${_escAS(title)}\\n\\n${_escAS(preview)}" with title "AutoSnippet" buttons {"取消", "确认"} default button "确认"`;
      const result = execSync(`osascript -e '${script}'`, { encoding: 'utf8', timeout: 30000 });
      return result.includes('确认');
    } catch {
      return false;
    }
  }

  return true; // 非 macOS 默认确认
}

/**
 * macOS / Linux / Windows 系统通知
 * @param {string} message 通知内容
 * @param {string} [title='AutoSnippet']
 */
export function notify(message, title = 'AutoSnippet') {
  try {
    if (process.platform === 'darwin') {
      const safeMsg = message.replace(/"/g, '\\"').replace(/\n/g, '\\n');
      const safeTitle = title.replace(/"/g, '\\"');
      execSync(`osascript -e 'display notification "${safeMsg}" with title "${safeTitle}"'`, {
        timeout: 5000,
        stdio: 'ignore',
      });
      return;
    }
    if (process.platform === 'linux') {
      // notify-send (libnotify) — 绝大多数 Linux 桌面都有
      const safeMsg = message.replace(/'/g, "'\\''");
      const safeTitle = title.replace(/'/g, "'\\''");
      execSync(`notify-send '${safeTitle}' '${safeMsg}' 2>/dev/null`, {
        timeout: 5000,
        stdio: 'ignore',
      });
      return;
    }
    if (process.platform === 'win32') {
      // PowerShell toast notification
      const safeMsg = message.replace(/'/g, "''");
      const safeTitle = title.replace(/'/g, "''");
      const ps = `
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;
        $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);
        $textNodes = $template.GetElementsByTagName('text');
        $textNodes.Item(0).AppendChild($template.CreateTextNode('${safeTitle}')) | Out-Null;
        $textNodes.Item(1).AppendChild($template.CreateTextNode('${safeMsg}')) | Out-Null;
        $toast = [Windows.UI.Notifications.ToastNotification]::new($template);
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('AutoSnippet').Show($toast);
      `.replace(/\n\s+/g, ' ');
      execSync(`powershell.exe -NoProfile -Command "${ps}"`, {
        timeout: 5000,
        stdio: 'ignore',
      });
    }
  } catch {
    /* Windows toast notification is best-effort */
  }
}

/**
 * macOS 带按钮的对话框
 * @param {string} message
 * @param {string[]} buttons 按钮列表（从右到左排列）
 * @param {string} [title='AutoSnippet']
 * @returns {string|null} 点击的按钮名，或 null 表示取消
 */
export function promptWithButtons(message, buttons = ['确认', '取消'], title = 'AutoSnippet') {
  if (process.platform !== 'darwin') {
    return null;
  }
  try {
    const btnStr = buttons.map((b) => `"${_escAS(b)}"`).join(', ');
    const script = `display dialog "${_escAS(message)}" with title "${_escAS(title)}" buttons {${btnStr}} default button "${_escAS(buttons[0])}"`;
    const result = execSync(`osascript -e '${script}'`, { encoding: 'utf8', timeout: 30000 });
    const match = result.match(/button returned:(.+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/* ────────── 内部实现 ────────── */

function _escAS(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function _appleScriptCombinedWindow(items, keyword) {
  // 两步：先选择，再预览确认
  const titles = items.map((it, i) => `${i + 1}. ${it.title || 'Recipe'}`);
  const idx = showListSelection(titles, 'AutoSnippet Search', `搜索: ${keyword}`);
  if (idx < 0 || idx >= items.length) {
    return -1;
  }

  const item = items[idx];
  const confirmed = showPreviewConfirm(item.title || 'Recipe', item.code || item.explanation || '');
  return confirmed ? idx : -1;
}

function _consoleFallback(items, keyword) {
  items.forEach((item, i) => {});
  return -1;
}
