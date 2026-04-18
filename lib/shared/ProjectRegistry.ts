/**
 * ProjectRegistry — 全局项目注册表
 *
 * 存储位置：~/.asd/projects.json
 * 管理所有已注册项目的元数据，包括 Ghost 模式状态。
 *
 * 每个项目条目包含：
 *   - id: 基于 projectRoot 的 sha256 短哈希（8 位）
 *   - ghost: 是否启用 Ghost 模式
 *   - createdAt: 注册时间
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const USER_HOME = process.env.HOME || process.env.USERPROFILE || '';
const REGISTRY_DIR = path.join(USER_HOME, '.asd');
const REGISTRY_PATH = path.join(REGISTRY_DIR, 'projects.json');

export interface ProjectEntry {
  id: string;
  ghost: boolean;
  createdAt: string;
}

interface RegistryData {
  version: 1;
  projects: Record<string, ProjectEntry>;
}

/**
 * 为项目路径生成稳定的短 ID
 * 使用 realpath 规范化，避免符号链接导致重复注册
 */
function generateProjectId(projectRoot: string): string {
  let normalized: string;
  try {
    normalized = fs.realpathSync(projectRoot);
  } catch {
    normalized = path.resolve(projectRoot);
  }
  return createHash('sha256').update(normalized).digest('hex').slice(0, 8);
}

function loadRegistry(): RegistryData {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
      const data = JSON.parse(raw) as RegistryData;
      if (data.version === 1 && data.projects) {
        return data;
      }
    }
  } catch {
    /* corrupt file — start fresh */
  }
  return { version: 1, projects: {} };
}

function saveRegistry(data: RegistryData): void {
  if (!fs.existsSync(REGISTRY_DIR)) {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/** 获取 Ghost 模式的外置工作区根目录 */
export function getGhostWorkspaceDir(projectId: string): string {
  return path.join(USER_HOME, '.asd', 'workspaces', projectId);
}

export const ProjectRegistry = {
  /**
   * 查找项目注册信息
   * @returns ProjectEntry 或 null（未注册）
   */
  get(projectRoot: string): ProjectEntry | null {
    const data = loadRegistry();
    const normalized = normalizePath(projectRoot);
    return data.projects[normalized] ?? null;
  },

  /**
   * 注册项目（幂等）
   * 如果已注册，更新 ghost 状态
   */
  register(projectRoot: string, ghost: boolean): ProjectEntry {
    const data = loadRegistry();
    const normalized = normalizePath(projectRoot);

    const existing = data.projects[normalized];
    if (existing) {
      existing.ghost = ghost;
      saveRegistry(data);
      return existing;
    }

    const entry: ProjectEntry = {
      id: generateProjectId(projectRoot),
      ghost,
      createdAt: new Date().toISOString(),
    };
    data.projects[normalized] = entry;
    saveRegistry(data);
    return entry;
  },

  /**
   * 移除项目注册
   */
  unregister(projectRoot: string): boolean {
    const data = loadRegistry();
    const normalized = normalizePath(projectRoot);
    if (data.projects[normalized]) {
      delete data.projects[normalized];
      saveRegistry(data);
      return true;
    }
    return false;
  },

  /**
   * 检查项目是否处于 Ghost 模式
   * 未注册的项目返回 false（标准模式）
   */
  isGhost(projectRoot: string): boolean {
    const entry = this.get(projectRoot);
    return entry?.ghost === true;
  },

  /**
   * 获取项目的外置工作区路径
   * @returns 工作区目录路径（仅 Ghost 模式项目），或 null
   */
  getWorkspaceDir(projectRoot: string): string | null {
    const entry = this.get(projectRoot);
    if (!entry?.ghost) {
      return null;
    }
    return getGhostWorkspaceDir(entry.id);
  },

  /**
   * 列出所有已注册项目
   */
  list(): Array<{ projectRoot: string; entry: ProjectEntry }> {
    const data = loadRegistry();
    return Object.entries(data.projects).map(([projectRoot, entry]) => ({
      projectRoot,
      entry,
    }));
  },
};

function normalizePath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export default ProjectRegistry;
