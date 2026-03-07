/**
 * XcodeIntegration — Xcode IDE 代码自动插入服务
 *
 * 核心能力：
 *   §1  import 语句解析 — 支持 ObjC (#import/#include/@import) 和 Swift (import)
 *   §2  头文件搜索     — 在 target 源目录中递归查找头文件并计算相对路径
 *   §3  import 格式化   — 根据 同target/跨target 关系生成正确的引号/尖括号格式
 *   §4  三级去重       — 精确匹配 → 模块匹配 → 相似头文件名匹配
 *   §5  SPM 依赖决策   — block(循环依赖) / review(缺失可补) / continue(已存在)
 *   §6  Xcode 自动插入  — osascript 跳转+粘贴，保持 Undo 可用
 *   §7  文件写入回退   — Xcode 失败时直接写文件，Xcode 自动 reload
 *   §8  粘贴行号偏移   — headers 插入后自动修正代码粘贴位置
 *   §9  完整插入流程   — cut 触发行 → preflight → headers → offset → paste
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { saveEventFilter } from './SaveEventFilter.js';

import {
  checkImportStatus,
  collectImportsFromFile,
  collectImportsFromHeaderFile,
  inferModulesFromHeaders,
  resolveHeaderFormat,
} from './XcodeImportResolver.js';

import {
  computePasteLineNumber,
  evaluateDepResult,
  handleDepReview,
  sleep,
  withAutoSnippetNote,
  writeImportLineFile,
  writeImportLineXcode,
} from './XcodeWriteUtils.js';

/** FileWatcher 接口（仅用到的属性） */
interface FileWatcherLike {
  projectRoot?: string;
}

/** 插入选项 */
interface InsertHeadersOpts {
  depWarnings?: Map<string, string>;
  isSwift?: boolean;
  skipDepCheck?: boolean;
  moduleName?: string | null;
  _spmService?: SpmServiceLike | null;
  _currentTarget?: string | null;
}

/** 代码片段选择结果 */
interface SelectedSnippet {
  code?: string;
  headers?: string[];
  moduleName?: string | null;
  title?: string;
  name?: string;
  trigger?: string;
}

/** SPM 服务接口 */
interface SpmServiceLike {
  getFixMode(): string;
  load(): Promise<void>;
  resolveCurrentTarget(filePath: string): string | null;
  ensureDependency(
    from: string,
    to: string
  ): { exists: boolean; canAdd: boolean; reason?: string; crossPackage?: boolean };
  addDependency(from: string, to: string): { ok: boolean; error?: string };
}

/** NativeUI 接口 */
interface NativeUiLike {
  notify(msg: string, title: string): void;
  promptWithButtons(msg: string, buttons: string[], title: string): string;
}

/** 常见 Apple 系统框架（无需 SPM 依赖检查） */
const _SYSTEM_FRAMEWORKS = new Set([
  'Foundation',
  'UIKit',
  'AppKit',
  'SwiftUI',
  'Combine',
  'CoreFoundation',
  'CoreGraphics',
  'CoreData',
  'CoreAnimation',
  'CoreLocation',
  'CoreMedia',
  'CoreImage',
  'CoreText',
  'CoreVideo',
  'QuartzCore',
  'AVFoundation',
  'AVKit',
  'WebKit',
  'MapKit',
  'Metal',
  'MetalKit',
  'ARKit',
  'SceneKit',
  'SpriteKit',
  'GameKit',
  'GameplayKit',
  'HealthKit',
  'HomeKit',
  'CloudKit',
  'StoreKit',
  'PhotosUI',
  'Photos',
  'Contacts',
  'ContactsUI',
  'EventKit',
  'UserNotifications',
  'MessageUI',
  'MultipeerConnectivity',
  'NetworkExtension',
  'SafariServices',
  'AuthenticationServices',
  'LocalAuthentication',
  'Security',
  'CryptoKit',
  'Accelerate',
  'os',
  'Darwin',
  'ObjectiveC',
  'Dispatch',
  'XCTest',
]);

// ═══════════════════════════════════════════════════════════════
// §10 导出：insertHeaders
// ═══════════════════════════════════════════════════════════════

/**
 * 统一的头文件插入方法
 *
 * 逐条处理：
 *   1. 三级去重
 *   2. SPM 依赖检查（block/review/continue 决策）
 *   3. Xcode osascript 自动插入，失败则文件写入回退
 *   4. 附加 AutoSnippet 注释后缀
 *
 * @param {import('../../../service/automation/FileWatcher.js').FileWatcher} watcher
 * @param {string}   fullPath  目标文件绝对路径
 * @param {string[]} headers   待插入的 import 行数组
 * @param {object}   [opts]
 * @returns {Promise<{inserted: string[], skipped: string[], cancelled: boolean}>}
 */
export async function insertHeaders(
  watcher: FileWatcherLike | null,
  fullPath: string,
  headers: string[],
  opts: InsertHeadersOpts = {}
) {
  const XA = await import('./XcodeAutomation.js');
  const CM = await import('../../../infrastructure/external/ClipboardManager.js');
  const NU = (await import(
    '../../../infrastructure/external/NativeUi.js'
  )) as unknown as NativeUiLike;

  const result = { inserted: [] as string[], skipped: [] as string[], cancelled: false };
  /** @type {Map<string, string>} 模块名 → 提示注释（'提示操作插入'按钮选择时记录） */
  const depWarnings = opts.depWarnings instanceof Map ? new Map(opts.depWarnings) : new Map();
  if (!headers || headers.length === 0) {
    return result;
  }

  const isSwift = opts.isSwift ?? fullPath.endsWith('.swift');

  // ── Step 1: 收集已有 imports ──
  const importArray = collectImportsFromFile(fullPath, isSwift);
  // .m 文件还要收集对应 .h 的 imports
  if (!isSwift && !fullPath.endsWith('.h')) {
    collectImportsFromHeaderFile(fullPath, importArray);
  }

  // ── Step 2: SPM/模块 服务准备 ──
  // 优先复用 opts 传入的 spmService/currentTarget（避免与 _preflightDeps 重复 load）
  let spmService = opts._spmService || null;
  let currentTarget = opts._currentTarget || null;
  if (!spmService && !opts.skipDepCheck) {
    const inferredModules = inferModulesFromHeaders(headers);
    if (opts.moduleName && !inferredModules.includes(opts.moduleName)) {
      inferredModules.push(opts.moduleName);
    }
    const thirdPartyModules = inferredModules.filter((m) => !_SYSTEM_FRAMEWORKS.has(m));
    if (thirdPartyModules.length > 0) {
      try {
        const { ServiceContainer } = await import('../../../injection/ServiceContainer.js');
        const container = ServiceContainer.getInstance();
        spmService = container.get('spmService');
        if (spmService) {
          if (spmService.getFixMode() === 'off') {
            spmService = null;
          } else {
            try {
              await spmService.load();
            } catch {
              /* Package.swift 不存在则跳过 */
            }
            currentTarget = spmService.resolveCurrentTarget(fullPath);
          }
        }
      } catch {
        /* SPM 检查异常不阻断 */
      }
    }
  }

  // ── Step 3: Xcode 自动化准备 ──
  const xcodeReady = XA.isXcodeRunning();
  // 从当前文件内容计算 import 插入基准行（1-based）
  let content;
  try {
    content = readFileSync(fullPath, 'utf8');
  } catch {
    return result;
  }
  const baseInsertLine = findImportInsertLine(content, isSwift) + 1; // 0-based → 1-based
  let xcodeOffset = 0; // 每次 Xcode 插入成功后 +1（修正多条 header 行号偏移）
  let fileWriteUsed = false; // 一旦使用文件写入，后续全部走文件写入（避免 Xcode reload 冲突）

  // ── Step 4: 逐条处理 ──
  for (const header of headers) {
    const headerTrimmed = header.trim();
    if (!headerTrimmed) {
      continue;
    }

    // ── 三级去重 ──
    // 先按原始格式检查，再按解析后格式检查（同一 header 可能格式不同）
    const preResolvedHeader = resolveHeaderFormat(headerTrimmed, {
      currentTarget,
      headerModuleName: opts.moduleName || null,
      isSwift,
      fullPath,
      projectRoot: watcher?.projectRoot || null,
    });
    const status = checkImportStatus(importArray, headerTrimmed, isSwift);
    const statusResolved =
      preResolvedHeader !== headerTrimmed
        ? checkImportStatus(importArray, preResolvedHeader, isSwift)
        : status;
    if (status.hasHeader || statusResolved.hasHeader) {
      result.skipped.push(preResolvedHeader);
      continue;
    }
    if (status.hasModule || statusResolved.hasModule) {
      result.skipped.push(preResolvedHeader);
      continue;
    }
    if (status.hasSimilarHeader || statusResolved.hasSimilarHeader) {
      result.skipped.push(preResolvedHeader);
      continue;
    }

    // ── SPM 依赖检查 ──
    const headerModules = inferModulesFromHeaders([headerTrimmed]);
    if (spmService && currentTarget && !opts.skipDepCheck) {
      for (const mod of headerModules) {
        if (_SYSTEM_FRAMEWORKS.has(mod) || mod === currentTarget) {
          continue;
        }

        const ensureResult = spmService.ensureDependency(currentTarget, mod);
        const decision = evaluateDepResult(ensureResult, currentTarget, mod);

        if (decision.action === 'block') {
          console.warn(`     ⛔ 依赖被阻止: ${currentTarget} -> ${mod} (${decision.reason})`);
          NU.notify(
            `已阻止依赖注入\n${currentTarget} -> ${mod}\n${decision.reason}`,
            'AutoSnippet SPM 依赖策略'
          );
          result.cancelled = true;
          return result;
        }

        if (decision.action === 'review') {
          const reviewResult = handleDepReview({
            spmService,
            currentTarget,
            mod,
            ensureResult,
            NU,
            depWarnings,
          });
          if (reviewResult.blocked) {
            result.cancelled = true;
            return result;
          }
        }
      }
    }

    // ── 构建带注释后缀的 import 行 ──
    // 复用 dedup 阶段已计算的 preResolvedHeader
    const resolvedHeader = preResolvedHeader;
    const depHint = headerModules.find((m) => depWarnings.has(m));
    const importLine = depHint
      ? `${withAutoSnippetNote(resolvedHeader)} // ⚠️ 依赖缺失: ${depWarnings.get(depHint)}，需手动补齐 Package.swift`
      : withAutoSnippetNote(resolvedHeader);

    // ── 写入：Xcode 自动化优先 → 文件写入回退 ──
    let inserted = false;

    if (xcodeReady && !fileWriteUsed) {
      // 逐条 osascript 跳转 + 粘贴
      inserted = writeImportLineXcode(importLine, baseInsertLine + xcodeOffset, XA, CM);
      if (inserted) {
        xcodeOffset++;
      }
    }

    if (!inserted) {
      writeImportLineFile(fullPath, importLine, isSwift);
      fileWriteUsed = true;
    }

    result.inserted.push(resolvedHeader);
    importArray.push(resolvedHeader); // 添加到去重列表（用解析后格式）
  }

  if (result.inserted.length > 0) {
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// §11 导出：insertCodeToXcode
// ═══════════════════════════════════════════════════════════════

/**
 * 将选中的搜索结果代码插入 Xcode
 *
 * 流程：
 *   1. 找到触发行号
 *   2. Preflight — 预检依赖决策（不实际写入）
 *   3. Cut 触发行内容（Xcode 剪切，不写文件）
 *   4. 构建带缩进 + 注释标记的代码块
 *   5. 插入 Headers（Xcode osascript / 文件写入）
 *   6. 计算偏移后的粘贴行号（computePasteLineNumber）
 *   7. Jump 到粘贴行 → 选中行内容 → Cmd+V 粘贴替换
 *   8. 任一步失败 → 降级到纯文件写入
 *
 * @param {import('../../../service/automation/FileWatcher.js').FileWatcher} watcher
 */
export async function insertCodeToXcode(
  watcher: FileWatcherLike | null,
  fullPath: string,
  selected: SelectedSnippet,
  triggerLine: string
) {
  const XA = await import('./XcodeAutomation.js');
  const CM = await import('../../../infrastructure/external/ClipboardManager.js');
  const NU = (await import(
    '../../../infrastructure/external/NativeUi.js'
  )) as unknown as NativeUiLike;

  const code = selected.code || '';
  if (!code) {
    return;
  }

  const headersToInsert = (selected.headers || []).filter((h: string) => h?.trim());
  const isSwift = fullPath.endsWith('.swift');

  // ═══════════════════════════════════════════════════════
  // 主路径：Xcode 自动化
  // ═══════════════════════════════════════════════════════
  if (XA.isXcodeRunning()) {
    // ── 窗口上下文验证 ──
    if (!XA.isXcodeFrontmost()) {
      console.warn(`  ⚠️ Xcode 不是前台应用，自动化操作可能不准确`);
      // 宽松模式：仅警告，不阻断
      // 如需严格模式，可设置 ASD_XCODE_STRICT_FOCUS=1
      if (process.env.ASD_XCODE_STRICT_FOCUS === '1') {
        console.warn(`  ⏹️  ASD_XCODE_STRICT_FOCUS=1, 跳过自动化`);
        return _fileInsertFallback(fullPath, selected, triggerLine, headersToInsert, watcher);
      }
    }
    // ── Step 1: 找到触发行号 ──
    let content;
    try {
      content = readFileSync(fullPath, 'utf8');
    } catch {
      return _fileInsertFallback(fullPath, selected, triggerLine, headersToInsert, watcher);
    }
    const triggerLineNumber = findTriggerLineNumber(content, triggerLine);
    if (triggerLineNumber < 0) {
      console.warn(`  ⚠️ 未在文件中找到触发行，降级为文件写入`);
      return _fileInsertFallback(fullPath, selected, triggerLine, headersToInsert, watcher);
    }

    // 计算触发行缩进
    const lines = content.split(/\r?\n/);
    const triggerContent = lines[triggerLineNumber - 1] || '';
    const indentMatch = triggerContent.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';

    // ── Step 2: Preflight 预检依赖 ──
    let preflightDepWarnings: Map<string, string> | null = null;
    let _spmServiceCached: SpmServiceLike | null = null;
    let _currentTargetCached: string | null = null;
    if (headersToInsert.length > 0) {
      const preflight = await _preflightDeps(fullPath, headersToInsert, selected, NU);
      if (preflight.blocked) {
        return;
      }
      if (preflight.depWarnings && preflight.depWarnings.size > 0) {
        preflightDepWarnings = preflight.depWarnings;
      }
      // 缓存 spmService/currentTarget 供 insertHeaders 复用（避免重复 load）
      _spmServiceCached = preflight._spmService || null;
      _currentTargetCached = preflight._currentTarget || null;
    }

    // ── Step 3: 剪切触发行内容 ──
    const cutOk = XA.cutLineInXcode(triggerLineNumber);
    if (!cutOk) {
      console.warn(`  ⚠️ 自动剪切失败，降级为文件写入`);
      // Preflight 已通过，skipDepCheck 避免重复弹窗
      return _fileInsertFallback(fullPath, selected, triggerLine, headersToInsert, watcher, {
        skipDepCheck: true,
      });
    }
    await sleep(300);

    // ── Step 4: 构建带缩进的代码块 ──
    const codeLines = code.split(/\r?\n/);
    // 移除末尾空行
    while (codeLines.length > 0 && !codeLines[codeLines.length - 1].trim()) {
      codeLines.pop();
    }
    const indentedLines = codeLines.map((line: string) => (line ? indent + line : line));
    const indentedCode = indentedLines.join('\n');

    // ── Step 5: 插入 Headers ──
    let headerInsertCount = 0;
    if (headersToInsert.length > 0) {
      const headerResult = await insertHeaders(watcher, fullPath, headersToInsert, {
        moduleName: selected.moduleName || null,
        isSwift,
        skipDepCheck: true, // Preflight 已检查过
        depWarnings: preflightDepWarnings ?? undefined,
        _spmService: _spmServiceCached,
        _currentTarget: _currentTargetCached,
      });
      if (headerResult.cancelled) {
        return;
      }
      headerInsertCount = headerResult.inserted.length;
    }

    // ── Step 6: 计算偏移后的粘贴行号 ──
    // 使用实际插入的 header 数量计算偏移，而非期望数量
    // 当 headers 全部重复被跳过时，headerInsertCount = 0，不应偏移
    const pasteLineNumber = computePasteLineNumber(triggerLineNumber, headerInsertCount, fullPath, {
      forceOffset: headerInsertCount > 0,
      expectedHeaderCount: headerInsertCount,
    });

    // 如果 headers 通过文件写入，等待 Xcode reload
    if (headerInsertCount > 0) {
      await sleep(600);
    }

    // ── Step 7: Jump + 选中行内容 + 粘贴替换 ──
    await CM.withClipboardSave(async () => {
      const wrote = CM.write(indentedCode);
      if (!wrote) {
        console.warn(`  ⚠️ 剪贴板写入失败`);
        return;
      }
      await sleep(100);
      XA.jumpToLineInXcode(pasteLineNumber);
      await sleep(500);
      XA.selectAndPasteInXcode();
      await sleep(300);
    });
    NU.notify(`已插入「${selected.title || '代码片段'}」`, 'AutoSnippet');
    return;
  }

  // ═══════════════════════════════════════════════════════
  // 降级路径：纯文件写入
  // ═══════════════════════════════════════════════════════
  return _fileInsertFallback(fullPath, selected, triggerLine, headersToInsert, watcher);
}

// ═══════════════════════════════════════════════════════════════
// §12 Preflight 依赖预检
// ═══════════════════════════════════════════════════════════════

/**
 * 预检所有 headers 的 SPM 依赖状态
 *
 * 不实际写入文件，只检查并弹窗确认。
 * 返回 { blocked: true } 表示有依赖被阻止或用户取消。
 */
async function _preflightDeps(
  fullPath: string,
  headers: string[],
  selected: SelectedSnippet,
  NU: NativeUiLike
) {
  const result: {
    blocked: boolean;
    depWarnings?: Map<string, string>;
    _spmService?: SpmServiceLike | null;
    _currentTarget?: string | null;
  } = { blocked: false };

  // 始终从所有 headers 推断模块（不仅依赖 selected.moduleName）
  const inferredModules = inferModulesFromHeaders(headers);
  if (selected.moduleName && !inferredModules.includes(selected.moduleName)) {
    inferredModules.push(selected.moduleName);
  }
  const thirdPartyModules = inferredModules.filter((m) => !_SYSTEM_FRAMEWORKS.has(m));
  if (thirdPartyModules.length === 0) {
    return result;
  }

  try {
    const { ServiceContainer } = await import('../../../injection/ServiceContainer.js');
    const container = ServiceContainer.getInstance();
    const spmService = container.get('spmService');
    if (!spmService) {
      return result;
    }

    // Fix Mode 检查：off 模式完全跳过
    if (spmService.getFixMode() === 'off') {
      return result;
    }

    try {
      await spmService.load();
    } catch {
      return result;
    }

    const currentTarget = spmService.resolveCurrentTarget(fullPath);
    if (!currentTarget) {
      return result;
    }

    for (const mod of thirdPartyModules) {
      if (mod === currentTarget) {
        continue;
      }

      const ensureResult = spmService.ensureDependency(currentTarget, mod);
      const decision = evaluateDepResult(ensureResult, currentTarget, mod);

      if (decision.action === 'block') {
        console.warn(
          `  ⛔ [Preflight] 依赖被阻止: ${currentTarget} -> ${mod} (${decision.reason})`
        );
        NU.notify(
          `已阻止依赖注入\n${currentTarget} -> ${mod}\n${decision.reason}`,
          'AutoSnippet SPM 依赖策略'
        );
        result.blocked = true;
        return result;
      }

      if (decision.action === 'review') {
        if (!result.depWarnings) {
          result.depWarnings = new Map();
        }
        const reviewResult = handleDepReview({
          spmService,
          currentTarget,
          mod,
          ensureResult,
          NU,
          depWarnings: result.depWarnings,
          label: 'Preflight',
        });
        if (reviewResult.blocked) {
          result.blocked = true;
          return result;
        }
      }
    }

    // 缓存 spmService/currentTarget 供下游 insertHeaders 复用
    result._spmService = spmService;
    result._currentTarget = currentTarget;
  } catch (err: unknown) {
    console.warn(`  ⚠️ Preflight 依赖检查异常: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// §13 文件写入降级
// ═══════════════════════════════════════════════════════════════

async function _fileInsertFallback(
  fullPath: string,
  selected: SelectedSnippet,
  triggerLine: string,
  headersToInsert: string[],
  watcher: FileWatcherLike | null,
  opts: { skipDepCheck?: boolean } = {}
) {
  // 先写 headers
  if (headersToInsert.length > 0) {
    const headerResult = await insertHeaders(watcher, fullPath, headersToInsert, {
      moduleName: selected.moduleName || null,
      skipDepCheck: opts.skipDepCheck || false, // Preflight 已通过时跳过重复检查
    });
    if (headerResult.cancelled) {
      return;
    }
  }

  // 再替换触发行为代码
  const code = selected.code || '';
  try {
    const content = readFileSync(fullPath, 'utf8');
    const lines = content.split(/\r?\n/);
    const triggerTrimmed = triggerLine.trim();

    // 从后往前查找触发行
    let found = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim() === triggerTrimmed) {
        found = i;
        break;
      }
    }

    if (found >= 0) {
      // 计算缩进 → 对齐 → 替换
      const triggerContent = lines[found];
      const indentMatch = triggerContent.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1] : '';

      const codeLines = code.split(/\r?\n/);
      while (codeLines.length > 0 && !codeLines[codeLines.length - 1].trim()) {
        codeLines.pop();
      }
      const indentedLines = codeLines.map((line: string) => (line ? indent + line : line));

      while (indentedLines.length > 0 && !indentedLines[indentedLines.length - 1].trim()) {
        indentedLines.pop();
      }

      const newLines = [...lines.slice(0, found), ...indentedLines, ...lines.slice(found + 1)];
      const newContent = newLines.join('\n');
      saveEventFilter.markWrite(fullPath, newContent);
      writeFileSync(fullPath, newContent, 'utf8');
    } else {
      const appendContent = `${content}\n${code}\n`;
      saveEventFilter.markWrite(fullPath, appendContent);
      writeFileSync(fullPath, appendContent, 'utf8');
    }
  } catch (err: unknown) {
    console.warn(`  ⚠️ 文件写入失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// §14 注释标记生成
// ═══════════════════════════════════════════════════════════════

function _generateInsertMarker(filePath: string, selected: SelectedSnippet) {
  try {
    const ext = (filePath.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    const trigger = selected.trigger ? `[${selected.trigger}]` : '';
    const recipeName = selected.name ? ` from ${selected.name}` : '';
    const timestamp = new Date().toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    const marker = `🤖 AutoSnippet${trigger}${recipeName} @ ${timestamp}`;

    if (['.py', '.rb'].includes(ext)) {
      return `# ${marker}`;
    }
    if (['.lua', '.sql'].includes(ext)) {
      return `-- ${marker}`;
    }
    if (['.html', '.xml', '.svg'].includes(ext)) {
      return `<!-- ${marker} -->`;
    }
    if (['.css', '.scss', '.less'].includes(ext)) {
      return `/* ${marker} */`;
    }
    return `// ${marker}`;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// §15 工具函数
// ═══════════════════════════════════════════════════════════════

/**
 * 查找触发行的行号（1-based，-1 表示未找到）
 */
export function findTriggerLineNumber(content: string, triggerLine: string) {
  if (!content || !triggerLine) {
    return -1;
  }
  const needle = triggerLine.trim();
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === needle) {
      return i + 1;
    }
  }
  return -1;
}

/**
 * 查找 import 语句的插入位置（0-based 行索引，在最后一个 import 之后）
 */
export function findImportInsertLine(content: string, isSwift: boolean) {
  const lines = content.split('\n');
  let lastImportLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (isSwift) {
      if (t.startsWith('import ') && !t.startsWith('import (')) {
        lastImportLine = i;
      }
    } else {
      if (t.startsWith('#import') || t.startsWith('@import')) {
        lastImportLine = i;
      }
    }
  }
  return lastImportLine >= 0 ? lastImportLine + 1 : 0;
}
