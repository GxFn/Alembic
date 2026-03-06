/**
 * @module platform/ios
 * @description iOS + Xcode 平台支持模块
 *
 * 将所有 iOS/Xcode 特有功能集中到 lib/platform/ios/ 下:
 *
 *   xcode/
 *     XcodeAutomation.js     — AppleScript/osascript Xcode IDE 自动化
 *     XcodeIntegration.js    — Xcode 代码自动插入 + Header 管理 + 依赖检查
 *     SaveEventFilter.js     — 保存事件过滤（Xcode 焦点检测 + 内容哈希去重）
 *
 *   snippet/
 *     XcodeCodec.js          — Xcode .codesnippet (plist XML) 编解码
 *     PlaceholderConverter.js — Xcode <#…#> ↔ VSCode ${N:…} 占位符转换
 *
 *   spm/
 *     SpmHelper.js           — SPM 包结构解析与依赖操作辅助工具
 *     SpmDiscoverer.js       — SPM 项目自动发现（ProjectDiscoverer 接口）
 *     PackageSwiftParser.js  — Package.swift 解析器
 *     DependencyGraph.js     — SPM Target 依赖图
 *     PolicyEngine.js        — 依赖策略引擎（层级检查 / 循环检测）
 *
 *   routes/
 *     spm.js                 — /api/v1/spm/* REST 路由（向后兼容遗留端点）
 *
 * 旧路径保留了 re-export shim 确保向后兼容。
 */

// ── SPM Legacy Routes ──
export { default as spmRouter } from './routes/spm.js';
export { PlaceholderConverter } from './snippet/PlaceholderConverter.js';
// ── Xcode Snippet 编解码 ──
export { XcodeCodec } from './snippet/XcodeCodec.js';
export { DependencyGraph } from './spm/DependencyGraph.js';
export { PackageSwiftParser } from './spm/PackageSwiftParser.js';
export { PolicyEngine } from './spm/PolicyEngine.js';
export { SpmDiscoverer } from './spm/SpmDiscoverer.js';
// ── Swift Package Manager ──
export { SpmHelper } from './spm/SpmHelper.js';
export { saveEventFilter } from './xcode/SaveEventFilter.js';
// ── Xcode IDE 自动化 ──
export {
  cutLineInXcode,
  deleteLineContentInXcode,
  insertAtLineStartInXcode,
  isXcodeFrontmost,
  isXcodeRunning,
  jumpToLineInXcode,
  pasteInXcode,
  saveActiveDocumentInXcode,
  selectAndPasteInXcode,
} from './xcode/XcodeAutomation.js';
export {
  findImportInsertLine,
  findTriggerLineNumber,
  insertCodeToXcode,
  insertHeaders,
} from './xcode/XcodeIntegration.js';
