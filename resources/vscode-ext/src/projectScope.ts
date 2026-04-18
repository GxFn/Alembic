/**
 * ProjectScope — 判断文件是否属于 Alembic 项目
 *
 * 检测逻辑：
 *   1. 标准模式：项目根目录存在 `Alembic/` 或 `.asd/` 目录
 *   2. Ghost 模式：`~/.asd/projects.json` 注册表中包含该项目路径
 *
 * 非 Alembic 项目零开销：不扫描指令、不触发 CodeLens、不显示状态栏。
 *
 * ⚠️  标记目录列表与核心库 `lib/shared/ProjectMarkers.ts` 的
 *     `PROJECT_MARKER_DIRS` 保持同步。
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const PROJECT_MARKER_DIRS = ['Alembic', '.asd'] as const;

const REGISTRY_PATH = path.join(os.homedir(), '.asd', 'projects.json');

/** 缓存：workspaceFolder fsPath → boolean */
const _cache = new Map<string, boolean>();

/** Ghost 注册表缓存（整份文件，首次访问时加载） */
let _registryCache: Record<string, { ghost?: boolean }> | null = null;
let _registryCacheTime = 0;
const REGISTRY_CACHE_TTL = 60_000;

function loadGhostRegistry(): Record<string, { ghost?: boolean }> {
  const now = Date.now();
  if (_registryCache && now - _registryCacheTime < REGISTRY_CACHE_TTL) {
    return _registryCache;
  }
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
      const data = JSON.parse(raw) as { version?: number; projects?: Record<string, { ghost?: boolean }> };
      if (data.version === 1 && data.projects) {
        _registryCache = data.projects;
        _registryCacheTime = now;
        return _registryCache;
      }
    }
  } catch { /* corrupt or missing — ignore */ }
  _registryCache = {};
  _registryCacheTime = now;
  return _registryCache;
}

function isGhostRegistered(folderPath: string): boolean {
  const registry = loadGhostRegistry();
  let normalized: string;
  try {
    normalized = fs.realpathSync(folderPath);
  } catch {
    normalized = path.resolve(folderPath);
  }
  return normalized in registry;
}

/**
 * 判断某个 workspace folder 是否为 Alembic 项目
 */
function isAlembicProject(folderPath: string): boolean {
  const cached = _cache.get(folderPath);
  if (cached !== undefined) return cached;

  const hasMarker = PROJECT_MARKER_DIRS.some((dir) =>
    fs.existsSync(path.join(folderPath, dir))
  );
  const result = hasMarker || isGhostRegistered(folderPath);
  _cache.set(folderPath, result);
  return result;
}

/**
 * 取得当前工作区中所有 Alembic 项目的根路径
 */
export function getActiveProjectRoots(): string[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return [];
  return folders
    .map((f) => f.uri.fsPath)
    .filter((p) => isAlembicProject(p));
}

/**
 * 当前工作区是否包含至少一个 Alembic 项目
 */
export function hasAnyProject(): boolean {
  return getActiveProjectRoots().length > 0;
}

/**
 * 判断文件路径是否属于某个 Alembic 项目
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
  _registryCache = null;
}
