/**
 * XcodeAutomation — Xcode AppleScript 自动化
 *
 * 通过 osascript 向 Xcode 发送键盘事件，实现行级操作：
 *   跳转行、选中行内容、剪切行、粘贴、在行首插入、删除行内容、保存文档。
 *
 * 所有操作都带超时保护（OSASCRIPT_TIMEOUT），Xcode 未运行时安全跳过。
 * 仅支持 macOS。
 */

import { execSync, spawnSync } from 'node:child_process';

const OSASCRIPT_TIMEOUT = 5000;

// ─────────────────────────────────────────────
// 内部辅助
// ─────────────────────────────────────────────

/**
 * 将行号限制为有效正整数（最小值 1）
 * @param {number} n 原始行号
 * @returns {number} 安全的 1-based 行号
 */
function _safeLine(n: number) {
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * 执行 osascript 并返回是否成功
 * @param {string[]} args  osascript 参数数组（每对 `-e`, `script`）
 * @returns {boolean}
 */
function _run(args: string[]) {
  try {
    const res = spawnSync('osascript', args, { stdio: 'ignore', timeout: OSASCRIPT_TIMEOUT });
    return res.status === 0;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// 状态查询
// ─────────────────────────────────────────────

/**
 * 检查 Xcode 是否正在运行（不会启动 Xcode）
 */
export function isXcodeRunning() {
  if (process.platform !== 'darwin') {
    return false;
  }
  try {
    const result = execSync('pgrep -x Xcode', {
      encoding: 'utf8',
      timeout: 2000,
      stdio: 'pipe',
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * 检查 Xcode 是否为当前前台应用
 */
export function isXcodeFrontmost() {
  if (!isXcodeRunning()) {
    return false;
  }
  try {
    const result = execSync(
      'osascript -e \'tell application "System Events" to get name of first process whose frontmost is true\'',
      { encoding: 'utf8', timeout: OSASCRIPT_TIMEOUT, stdio: 'pipe' }
    );
    return result.trim() === 'Xcode';
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// 行操作
// ─────────────────────────────────────────────

/**
 * 跳转到指定行
 *
 * 按键序列：Cmd+L → 输入行号 → Return
 *
 * @param {number} lineNumber 1-based 行号
 * @returns {boolean} 是否成功
 */
export function jumpToLineInXcode(lineNumber: number) {
  if (!isXcodeRunning()) {
    return false;
  }
  const n = _safeLine(lineNumber);
  return _run([
    '-e',
    'tell application "Xcode" to activate',
    '-e',
    'delay 0.2',
    '-e',
    'tell application "System Events"',
    '-e',
    '  keystroke "l" using command down',
    '-e',
    '  delay 0.2',
    '-e',
    `  keystroke "${String(n)}"`,
    '-e',
    '  delay 0.2',
    '-e',
    '  key code 36',
    '-e',
    'end tell',
  ]);
}

/**
 * 剪切指定行的文本内容（不含换行符）
 *
 * 按键序列：Cmd+L 跳转 → Cmd+← 行首 → Cmd+Shift+→ 选到行尾 → Cmd+X 剪切
 *
 * @param {number} lineNumber 1-based 行号
 * @returns {boolean} 是否成功
 */
export function cutLineInXcode(lineNumber: number) {
  if (!isXcodeRunning()) {
    return false;
  }
  const n = _safeLine(lineNumber);
  return _run([
    '-e',
    'tell application "Xcode" to activate',
    '-e',
    'delay 0.5',
    '-e',
    'tell application "System Events"',
    '-e',
    '  keystroke "l" using command down', // Cmd+L: Go to Line
    '-e',
    '  delay 0.5',
    '-e',
    `  keystroke "${String(n)}"`, // 输入行号
    '-e',
    '  delay 0.5',
    '-e',
    '  key code 36', // Return
    '-e',
    '  delay 0.5',
    '-e',
    '  key code 123 using command down', // Cmd+← 行首
    '-e',
    '  delay 0.5',
    '-e',
    '  key code 124 using {command down, shift down}', // Cmd+Shift+→ 选到行尾
    '-e',
    '  delay 0.5',
    '-e',
    '  keystroke "x" using command down', // Cmd+X
    '-e',
    'end tell',
  ]);
}

/**
 * 删除指定行的文本内容（保留空行，不删除行本身）
 *
 * 按键序列：Cmd+L 跳转 → Cmd+← 行首 → Cmd+Shift+→ 选到行尾 → Delete
 *
 * @param {number} lineNumber 1-based 行号
 * @returns {boolean} 是否成功
 */
export function deleteLineContentInXcode(lineNumber: number) {
  if (!isXcodeRunning()) {
    return false;
  }
  const n = _safeLine(lineNumber);
  return _run([
    '-e',
    'tell application "Xcode" to activate',
    '-e',
    'delay 0.3',
    '-e',
    'tell application "System Events"',
    '-e',
    '  keystroke "l" using command down',
    '-e',
    '  delay 0.3',
    '-e',
    `  keystroke "${String(n)}"`,
    '-e',
    '  delay 0.3',
    '-e',
    '  key code 36',
    '-e',
    '  delay 0.3',
    '-e',
    '  key code 123 using command down', // Cmd+← 行首
    '-e',
    '  delay 0.2',
    '-e',
    '  key code 124 using {command down, shift down}', // Cmd+Shift+→ 选到行尾
    '-e',
    '  delay 0.2',
    '-e',
    '  key code 51', // Delete 键
    '-e',
    '  delay 0.3',
    '-e',
    'end tell',
  ]);
}

// ─────────────────────────────────────────────
// 粘贴操作
// ─────────────────────────────────────────────

/**
 * 执行粘贴（Cmd+V）
 *
 * 调用前须确保剪贴板已写入目标内容。
 * @returns {boolean} 是否成功
 */
export function pasteInXcode() {
  if (!isXcodeRunning()) {
    return false;
  }
  return _run([
    '-e',
    'tell application "Xcode" to activate',
    '-e',
    'delay 0.2',
    '-e',
    'tell application "System Events"',
    '-e',
    '  keystroke "v" using command down',
    '-e',
    'end tell',
  ]);
}

/**
 * 选中当前行内容后粘贴替换
 *
 * 假设光标已在目标行（通常由 jumpToLineInXcode 定位后调用）。
 * 按键序列：Cmd+← 行首 → Cmd+Shift+→ 选到行尾 → Cmd+V 粘贴替换
 *
 * @returns {boolean} 是否成功
 */
export function selectAndPasteInXcode() {
  if (!isXcodeRunning()) {
    return false;
  }
  return _run([
    '-e',
    'tell application "Xcode" to activate',
    '-e',
    'delay 0.5',
    '-e',
    'tell application "System Events"',
    '-e',
    '  key code 123 using command down', // Cmd+← 行首
    '-e',
    '  delay 0.1',
    '-e',
    '  key code 124 using {command down, shift down}', // Cmd+Shift+→ 选到行尾
    '-e',
    '  delay 0.2',
    '-e',
    '  keystroke "v" using command down', // Cmd+V 粘贴替换
    '-e',
    'end tell',
  ]);
}

/**
 * 跳转到指定行行首并粘贴剪贴板内容
 *
 * 用于在 import 区域插入新行。
 * 按键序列：Cmd+L → 输入行号 → Return → Cmd+← 行首 → Cmd+V 粘贴
 *
 * @param {number} lineNumber 1-based 行号
 * @returns {boolean} 是否成功
 */
export function insertAtLineStartInXcode(lineNumber: number) {
  if (!isXcodeRunning()) {
    return false;
  }
  const n = _safeLine(lineNumber);
  return _run([
    '-e',
    'tell application "Xcode" to activate',
    '-e',
    'delay 0.3',
    '-e',
    'tell application "System Events"',
    '-e',
    '  keystroke "l" using command down', // Cmd+L: Go to Line
    '-e',
    '  delay 0.3',
    '-e',
    `  keystroke "${String(n)}"`, // 输入行号
    '-e',
    '  delay 0.3',
    '-e',
    '  key code 36', // Return
    '-e',
    '  delay 0.3',
    '-e',
    '  key code 123 using command down', // Cmd+← 行首
    '-e',
    '  delay 0.2',
    '-e',
    '  keystroke "v" using command down', // Cmd+V 粘贴
    '-e',
    '  delay 0.3',
    '-e',
    'end tell',
  ]);
}

// ─────────────────────────────────────────────
// 文档操作
// ─────────────────────────────────────────────

/**
 * 保存 Xcode 当前活动文档（Cmd+S）
 * @returns {boolean} 是否成功
 */
export function saveActiveDocumentInXcode() {
  if (!isXcodeRunning()) {
    return false;
  }
  return _run([
    '-e',
    'tell application "Xcode" to activate',
    '-e',
    'delay 0.1',
    '-e',
    'tell application "System Events"',
    '-e',
    '  keystroke "s" using command down',
    '-e',
    'end tell',
  ]);
}
