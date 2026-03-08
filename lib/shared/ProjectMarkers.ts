/**
 * ProjectMarkers — 统一项目探测标准（核心库 & VSCode 扩展共用）
 *
 * 所有模块判断「当前目录是否是 AutoSnippet 项目」时，都应该使用此模块提供的常量和函数，
 * 避免各处硬编码不同的标记目录名导致探测标准不一致。
 *
 * 探测优先级：
 *   1. 存在 AutoSnippet.boxspec.json 的一级子目录 → 知识库根目录
 *   2. 存在 AutoSnippet/ 目录 → 默认知识库根目录
 *   3. 存在 .autosnippet/ 目录 → 运行时目录（至少说明曾初始化过）
 *
 * 子仓库（Sub-Repo）：
 *   子仓库指通过独立 git 管理的知识数据目录，默认为 `AutoSnippet/recipes/`。
 *   可通过 `.autosnippet/config.json` 中的 `core.subRepoDir` 自定义。
 *   支持形式：git submodule、git subtree、独立 git init、或无 git（跳过权限探测）。
 */

import fs from 'node:fs';
import path from 'node:path';

// ─── 目录名常量 ──────────────────────────────────────────────

/** 默认知识库顶级目录名 */
export const DEFAULT_KNOWLEDGE_BASE_DIR = 'AutoSnippet';

/** 默认子仓库相对路径（相对于 projectRoot） */
export const DEFAULT_SUB_REPO_DIR = 'AutoSnippet/recipes';

/** 运行时配置目录名 */
export const RUNTIME_DIR = '.autosnippet';

/** Boxspec 文件名 — 知识库目录标记 */
export const SPEC_FILENAME = 'AutoSnippet.boxspec.json';

/**
 * 项目标记目录列表（任一存在即视为 AutoSnippet 项目）
 * 顺序即优先级：AutoSnippet/ > .autosnippet/
 */
export const PROJECT_MARKER_DIRS = [DEFAULT_KNOWLEDGE_BASE_DIR, RUNTIME_DIR] as const;

// ─── 探测函数 ────────────────────────────────────────────────

/**
 * 判断一个目录是否是 AutoSnippet 项目
 * 条件：存在 `AutoSnippet/` 或 `.autosnippet/` 子目录
 */
export function isAutoSnippetProject(folderPath: string): boolean {
  return PROJECT_MARKER_DIRS.some((dir) => fs.existsSync(path.join(folderPath, dir)));
}

/**
 * 探测知识库目录名
 * 优先查找含 boxspec.json 的一级子目录，fallback 到默认值 'AutoSnippet'
 */
export function detectKnowledgeBaseDir(projectRoot: string): string {
  try {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) {
        if (fs.existsSync(path.join(projectRoot, e.name, SPEC_FILENAME))) {
          return e.name;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_KNOWLEDGE_BASE_DIR;
}

/**
 * 从 `.autosnippet/config.json` 读取子仓库路径配置
 * @returns 子仓库相对路径（相对于 projectRoot），如 'AutoSnippet/recipes'
 */
export function readSubRepoDirFromConfig(projectRoot: string): string | null {
  try {
    const configPath = path.join(projectRoot, RUNTIME_DIR, 'config.json');
    if (!fs.existsSync(configPath)) {
      return null;
    }
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as { core?: { subRepoDir?: string } };
    return config.core?.subRepoDir || null;
  } catch {
    return null;
  }
}

/**
 * 从 `.autosnippet/config.json` 读取子仓库远程 URL 配置
 * @returns 远程仓库 URL，如 'https://github.com/team/recipes.git'；未配置则返回 null
 */
export function readSubRepoUrlFromConfig(projectRoot: string): string | null {
  try {
    const configPath = path.join(projectRoot, RUNTIME_DIR, 'config.json');
    if (!fs.existsSync(configPath)) {
      return null;
    }
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as { core?: { subRepoUrl?: string } };
    return config.core?.subRepoUrl || null;
  } catch {
    return null;
  }
}

/**
 * 解析子仓库的绝对路径
 *
 * 优先级：
 *   1. 传入的 explicitPath 参数
 *   2. `.autosnippet/config.json` 中 `core.subRepoDir`
 *   3. 默认 `AutoSnippet/recipes`
 *
 * @param projectRoot 项目根目录
 * @param explicitPath 显式指定的子仓库路径（绝对或相对于 projectRoot）
 * @returns 子仓库绝对路径
 */
export function resolveSubRepoPath(projectRoot: string, explicitPath?: string): string {
  if (explicitPath) {
    return path.isAbsolute(explicitPath) ? explicitPath : path.resolve(projectRoot, explicitPath);
  }

  const fromConfig = readSubRepoDirFromConfig(projectRoot);
  const relDir = fromConfig || DEFAULT_SUB_REPO_DIR;
  return path.resolve(projectRoot, relDir);
}

/**
 * 检测路径是否为 git 仓库（含 submodule）
 */
export function isGitRepo(dirPath: string): boolean {
  // 独立 git 仓库
  if (fs.existsSync(path.join(dirPath, '.git'))) {
    return true;
  }
  // git submodule（.git 是一个文件而非目录）
  const gitPath = path.join(dirPath, '.git');
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isFile()) {
      return true; // submodule 的 .git 是一个指向 ../.git/modules/xxx 的文件
    }
  } catch {
    /* not exist */
  }
  // 父目录有 .gitmodules 且当前目录是其子
  if (fs.existsSync(path.join(dirPath, '..', '.gitmodules'))) {
    return true;
  }
  return false;
}
