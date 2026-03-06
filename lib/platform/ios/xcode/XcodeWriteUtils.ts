/**
 * XcodeWriteUtils — Xcode 写入与插入工具函数
 *
 * 从 XcodeIntegration.js 拆分，负责：
 *   - 通用工具函数（sleep, withAutoSnippetNote）
 *   - SPM 依赖决策逻辑
 *   - Xcode osascript 写入
 *   - 文件写入回退
 *   - 粘贴行号偏移计算
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { saveEventFilter } from './SaveEventFilter.js';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 在 import 行末尾附加来源标记注释
 */
export function withAutoSnippetNote(importLine) {
  if (!importLine) {
    return importLine;
  }
  const note = '// AutoSnippet: 自动插入';
  if (importLine.includes(note)) {
    return importLine;
  }
  return `${importLine} ${note}`;
}

/**
 * 将 SpmHelper.ensureDependency 返回值映射为三种动作：
 *   continue — 依赖已存在
 *   block    — 循环/反向依赖，禁止插入
 *   review   — 依赖缺失但可添加，需用户确认
 */
export function evaluateDepResult(ensureResult, from, to) {
  if (ensureResult.exists) {
    return { action: 'continue' };
  }
  if (!ensureResult.canAdd) {
    return { action: 'block', reason: ensureResult.reason || 'cycleBlocked', from, to };
  }
  return { action: 'review', reason: ensureResult.reason || 'missingDependency', from, to };
}

/**
 * 公共依赖审查弹窗逻辑（insertHeaders 和 _preflightDeps 共享）
 *
 * @param {object} ctx - { spmService, currentTarget, mod, ensureResult, NU, depWarnings, label }
 * @returns {{ blocked: boolean }}
 */
export function handleDepReview(ctx) {
  const { spmService, currentTarget, mod, ensureResult, NU, depWarnings, label = '' } = ctx;

  const fixMode = spmService.getFixMode();
  const buttons =
    fixMode === 'fix'
      ? ['直接插入（信任架构）', '提示操作插入', '自动修复依赖', '取消操作']
      : ['直接插入（信任架构）', '提示操作插入', '取消操作'];

  const crossTag = ensureResult.crossPackage ? ' (跨包)' : '';
  const prefix = label ? `[${label}] ` : '';

  const userChoice = NU.promptWithButtons(
    `检测到依赖缺失：${currentTarget} -> ${mod}${crossTag}\n\n请选择处理方式：`,
    buttons,
    'AutoSnippet SPM 依赖决策'
  );

  if (
    userChoice === '取消操作' ||
    (!userChoice && !['直接插入（信任架构）', '提示操作插入', '自动修复依赖'].includes(userChoice))
  ) {
    return { blocked: true };
  }

  if (userChoice === '提示操作插入') {
    depWarnings.set(mod, `${currentTarget} -> ${mod}`);
  }

  if (userChoice === '自动修复依赖') {
    const fixResult = spmService.addDependency(currentTarget, mod);
    if (fixResult.ok) {
      NU.notify(`已补齐依赖：${currentTarget} -> ${mod}`, 'AutoSnippet SPM');
    } else {
      console.warn(`  ⚠️ ${prefix}自动修复失败: ${fixResult.error}，继续插入`);
      depWarnings.set(mod, `${currentTarget} -> ${mod}`);
    }
  }

  return { blocked: false };
}

// ═══════════════════════════════════════════════════════════════
// Xcode osascript 单条 import 写入
// ═══════════════════════════════════════════════════════════════

/**
 * 通过 Xcode 自动化插入一条 import，保持 Xcode Undo 可用。
 *
 * 流程：保存剪贴板 → 写入 import 内容 → osascript 跳转+粘贴 → 恢复剪贴板
 *
 * @param {string} importLine  完整的 import 文本
 * @param {number} insertLine  1-based 行号
 * @param {object} XA          XcodeAutomation 模块
 * @param {object} CM          ClipboardManager 模块
 * @returns {boolean}
 */
export function writeImportLineXcode(importLine, insertLine, XA, CM) {
  if (!XA.isXcodeRunning()) {
    return false;
  }
  try {
    const contentToWrite = `${String(importLine).trim()}\n`;
    const previousClipboard = CM.read();

    CM.write(contentToWrite);
    const ok = XA.insertAtLineStartInXcode(insertLine);

    // 始终恢复剪贴板
    if (typeof previousClipboard === 'string') {
      CM.write(previousClipboard);
    }
    return ok;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// 文件写入回退
// ═══════════════════════════════════════════════════════════════

/**
 * 纯文件写入插入单条 import。
 * Xcode 会因文件变更而自动 reload。
 */
export function writeImportLineFile(filePath, importLine, isSwift) {
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    let lastImportIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (isSwift) {
        if (t.startsWith('import ') && !t.startsWith('import (')) {
          lastImportIdx = i;
        }
      } else {
        if (t.startsWith('#import ') || t.startsWith('#include ') || t.startsWith('@import ')) {
          lastImportIdx = i;
        }
      }
    }
    const insertAt = lastImportIdx >= 0 ? lastImportIdx + 1 : 0;
    lines.splice(insertAt, 0, importLine);
    const newContent = lines.join('\n');
    saveEventFilter.markWrite(filePath, newContent);
    writeFileSync(filePath, newContent, 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// 粘贴行号偏移计算
// ═══════════════════════════════════════════════════════════════

/**
 * 查找文件中最后一个 import 行的行号（1-based，0 表示无 import）
 */
export function getLastImportLine(filePath) {
  try {
    if (!existsSync(filePath)) {
      return 0;
    }
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    let lastIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (
        t.startsWith('#import ') ||
        t.startsWith('@import ') ||
        t.startsWith('#include ') ||
        t.startsWith('import ')
      ) {
        lastIdx = i;
      }
    }
    return lastIdx >= 0 ? lastIdx + 1 : 0;
  } catch {
    return 0;
  }
}

/**
 * 计算代码粘贴行号
 *
 * 如果 headers 插入在 trigger 行之前（import 区），trigger 行号需要向下偏移。
 */
export function computePasteLineNumber(
  triggerLineNumber,
  headerInsertCount,
  filePath,
  options: any = {}
) {
  const expectedCount = Number.isFinite(options.expectedHeaderCount)
    ? options.expectedHeaderCount
    : headerInsertCount;
  if (expectedCount > 0) {
    if (options.forceOffset) {
      return triggerLineNumber + expectedCount;
    }
    const headerInsertPosition = getLastImportLine(filePath);
    if (headerInsertPosition > 0 && headerInsertPosition < triggerLineNumber) {
      return triggerLineNumber + expectedCount;
    }
  }
  return triggerLineNumber;
}
