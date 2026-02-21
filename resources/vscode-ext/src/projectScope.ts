/**
 * ProjectScope — 判断文件是否属于 AutoSnippet 项目
 *
 * 检测逻辑：
 *   扫描所有 workspaceFolders，检查根目录下是否存在
 *   `AutoSnippet/` 或 `.autosnippet/` 目录。
 *   只有属于这些目录的文件才会触发扩展功能。
 *
 * 非 AutoSnippet 项目零开销：不扫描指令、不触发 CodeLens、不显示状态栏。
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 标记目录名 — 任一存在即视为 AutoSnippet 项目 */
const MARKER_DIRS = ['AutoSnippet', '.autosnippet'];

/** 缓存：workspaceFolder fsPath → boolean */
const _cache = new Map<string, boolean>();

/**
 * 判断某个 workspace folder 是否为 AutoSnippet 项目
 */
function isAutoSnippetProject(folderPath: string): boolean {
  const cached = _cache.get(folderPath);
  if (cached !== undefined) return cached;

  const result = MARKER_DIRS.some((dir) =>
    fs.existsSync(path.join(folderPath, dir))
  );
  _cache.set(folderPath, result);
  return result;
}

/**
 * 取得当前工作区中所有 AutoSnippet 项目的根路径
 */
export function getActiveProjectRoots(): string[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return [];
  return folders
    .map((f) => f.uri.fsPath)
    .filter((p) => isAutoSnippetProject(p));
}

/**
 * 当前工作区是否包含至少一个 AutoSnippet 项目
 */
export function hasAnyProject(): boolean {
  return getActiveProjectRoots().length > 0;
}

/**
 * 判断文件路径是否属于某个 AutoSnippet 项目
 */
export function isFileInScope(filePath: string): boolean {
  const roots = getActiveProjectRoots();
  return roots.some((root) => filePath.startsWith(root));
}

/**
 * 判断 TextDocument 是否在作用域内
 */
export function isDocumentInScope(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== 'file') return false;
  return isFileInScope(document.uri.fsPath);
}

/**
 * 清除缓存（workspace folders 变化时调用）
 */
export function invalidateCache(): void {
  _cache.clear();
}
