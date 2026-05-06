/**
 * ProjectMarkers — 统一项目探测标准（核心库 & VSCode 扩展共用）
 *
 * 所有模块判断「当前目录是否是 Alembic 项目」时，都应该使用此模块提供的常量和函数，
 * 避免各处硬编码不同的标记目录名导致探测标准不一致。
 *
 * 探测优先级：
 *   1. 存在 Alembic.boxspec.json 的一级子目录 → 知识库根目录
 *   2. 存在 Alembic/ 目录 → 默认知识库根目录
 *   3. 存在 .asd/ 目录 → 运行时目录（至少说明曾初始化过）
 *
 * 子仓库（Sub-Repo）：
 *   子仓库指通过独立 git 管理的知识数据目录，默认为 `Alembic/recipes/`。
 *   可通过 `.asd/config.json` 中的 `core.subRepoDir` 自定义。
 *   支持形式：git submodule、git subtree、独立 git init、或无 git（跳过权限探测）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_FOLDER_NAMES } from './folder-names.js';

// ─── 目录名常量 ──────────────────────────────────────────────

/** 默认知识库顶级目录名 */
export const DEFAULT_KNOWLEDGE_BASE_DIR = DEFAULT_FOLDER_NAMES.project.knowledgeBase;

/** 默认子仓库相对路径（相对于 projectRoot） */
export const DEFAULT_SUB_REPO_DIR = path.join(
  DEFAULT_FOLDER_NAMES.project.knowledgeBase,
  DEFAULT_FOLDER_NAMES.project.recipes
);

/** 运行时配置目录名 */
export const RUNTIME_DIR = DEFAULT_FOLDER_NAMES.project.runtime;

/** Boxspec 文件名 — 知识库目录标记 */
export const SPEC_FILENAME = 'Alembic.boxspec.json';

/**
 * 项目标记目录列表（任一存在即视为 Alembic 项目）
 * 顺序即优先级：Alembic/ > .asd/
 */
export const PROJECT_MARKER_DIRS = [DEFAULT_KNOWLEDGE_BASE_DIR, RUNTIME_DIR] as const;

// ─── 探测函数 ────────────────────────────────────────────────

/**
 * 判断一个目录是否是 Alembic 项目
 * 条件：存在 `Alembic/` 或 `.asd/` 子目录，或在 Ghost 注册表中
 */
export function isAlembicProject(folderPath: string): boolean {
  const hasMarker = PROJECT_MARKER_DIRS.some((dir) => fs.existsSync(path.join(folderPath, dir)));
  if (hasMarker) {
    return true;
  }

  try {
    const registryPath = path.join(
      process.env.HOME || process.env.USERPROFILE || '',
      DEFAULT_FOLDER_NAMES.global.root,
      'projects.json'
    );
    if (fs.existsSync(registryPath)) {
      const raw = fs.readFileSync(registryPath, 'utf-8');
      const data = JSON.parse(raw) as { version?: number; projects?: Record<string, unknown> };
      if (data.version === 1 && data.projects) {
        let normalized: string;
        try {
          normalized = fs.realpathSync(folderPath);
        } catch {
          normalized = path.resolve(folderPath);
        }
        return normalized in data.projects;
      }
    }
  } catch {
    /* registry unreadable — fall through */
  }

  return false;
}

/**
 * 探测知识库目录名
 * 优先查找含 boxspec.json 的一级子目录，fallback 到默认值 'Alembic'
 */
export function detectKnowledgeBaseDir(
  projectRoot: string,
  fallbackDir = DEFAULT_KNOWLEDGE_BASE_DIR
): string {
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
  return fallbackDir;
}

/**
 * 从 `.asd/config.json` 读取子仓库路径配置
 * @returns 子仓库相对路径（相对于 projectRoot），如 'Alembic/recipes'
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
 * 从 `.asd/config.json` 读取子仓库远程 URL 配置
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
 *   2. `.asd/config.json` 中 `core.subRepoDir`
 *   3. 默认 `Alembic/recipes`
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

/** 检测路径是否为 git 仓库（含 submodule） */
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
