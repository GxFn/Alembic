/**
 * ScreenCaptureService — macOS 原生截图服务
 *
 * 使用 ScreenCaptureKit (via Swift CLI) 截取窗口/屏幕画面。
 * 息屏可用，无需 OBS。
 *
 * 依赖：resources/native-ui/screenshot.swift 编译产物
 */

import { existsSync, mkdirSync, statSync as fstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Logger from '../infrastructure/logging/Logger.js';

const logger = Logger.getInstance();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Swift 源文件路径 */
const SWIFT_SRC = join(__dirname, '../../resources/native-ui/screenshot.swift');
/** 编译产物路径 */
const BINARY_PATH = join(__dirname, '../../resources/native-ui/screenshot');

let _binaryReady = false;

/**
 * 确保 Swift 截图工具已编译
 * @returns {{ready: boolean, error?: string}}
 */
function ensureBinary() {
  if (_binaryReady && existsSync(BINARY_PATH)) return { ready: true };

  if (!existsSync(SWIFT_SRC)) {
    return { ready: false, error: `Swift source not found: ${SWIFT_SRC}` };
  }

  // 检查是否需要重新编译（源文件比二进制新）
  const needsBuild = !existsSync(BINARY_PATH) ||
    (() => {
      try {
        const srcTime = fstatSync(SWIFT_SRC).mtimeMs;
        const binTime = fstatSync(BINARY_PATH).mtimeMs;
        return srcTime > binTime;
      } catch {
        return true;
      }
    })();

  if (needsBuild) {
    logger.info('[Screenshot] Compiling screenshot tool...');
    try {
      execSync(
        `swiftc -O -framework ScreenCaptureKit -framework AppKit "${SWIFT_SRC}" -o "${BINARY_PATH}"`,
        { timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      logger.info('[Screenshot] ✅ Compiled successfully');
    } catch (err) {
      const stderr = err.stderr?.toString() || err.message;
      logger.error(`[Screenshot] Compilation failed: ${stderr}`);
      return { ready: false, error: `Swift compilation failed: ${stderr.slice(0, 200)}` };
    }
  }

  _binaryReady = true;
  return { ready: true };
}

/**
 * 执行截图工具
 * @param {string[]} args - CLI 参数
 * @returns {{success: boolean, data?: object, error?: string}}
 */
function exec(args = []) {
  const check = ensureBinary();
  if (!check.ready) return { success: false, error: check.error };

  try {
    const stdout = execFileSync(BINARY_PATH, args, {
      timeout: 15000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const result = JSON.parse(stdout.trim());
    return { success: true, data: result };
  } catch (err) {
    // 尝试从 stderr 中解析 JSON 错误
    const stderr = err.stderr?.toString() || '';
    try {
      const errObj = JSON.parse(stderr.trim());
      return { success: false, error: errObj.error || stderr };
    } catch {
      return { success: false, error: stderr || err.message };
    }
  }
}

// ═══════════════════════════════════════════════════════
//  公开 API
// ═══════════════════════════════════════════════════════

/**
 * 截取屏幕或窗口画面（核心功能 — 息屏可用）
 *
 * @param {object} opts
 * @param {string} [opts.windowTitle] 窗口标题关键词（模糊匹配），默认截整屏
 * @param {string} [opts.format] - 'jpeg' | 'png'
 * @param {number} [opts.scale] 缩放因子 (0.25-2.0)
 * @param {string} [opts.outputPath] 输出路径，默认临时目录
 * @returns {Promise<{success: boolean, path?: string, width?: number, height?: number, error?: string}>}
 */
export async function screenshot(opts = {}) {
  const args = [];

  if (opts.windowTitle) {
    args.push('--window', opts.windowTitle);
  }
  if (opts.format) {
    args.push('--format', opts.format);
  }
  if (opts.scale) {
    args.push('--scale', String(opts.scale));
  }
  if (opts.outputPath) {
    args.push('--output', opts.outputPath);
  }

  const result = exec(args);

  if (result.success && result.data) {
    logger.info(`[Screenshot] ✅ Captured: ${result.data.path} (${result.data.width}x${result.data.height})`);
    return {
      success: true,
      path: result.data.path,
      width: result.data.width,
      height: result.data.height,
      format: result.data.format,
      bytes: result.data.bytes,
    };
  }

  logger.warn(`[Screenshot] ❌ Failed: ${result.error}`);
  return { success: false, error: result.error };
}

/**
 * 列出所有可截取的窗口
 * @returns {Promise<{success: boolean, windows?: Array, error?: string}>}
 */
export async function listWindows() {
  const result = exec(['--list-windows']);

  if (result.success && result.data) {
    return { success: true, windows: result.data };
  }

  return { success: false, error: result.error };
}

/**
 * 检查截图服务是否可用
 * @returns {{available: boolean, error?: string}}
 */
export function isScreenCaptureAvailable() {
  const check = ensureBinary();
  if (!check.ready) return { available: false, error: check.error };

  // 尝试列出窗口来验证权限
  const result = exec(['--list-windows']);
  return {
    available: result.success,
    error: result.success ? undefined : result.error,
  };
}
