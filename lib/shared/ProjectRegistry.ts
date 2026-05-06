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
import type { WriteZone } from '../infrastructure/io/WriteZone.js';
import { DEFAULT_FOLDER_NAMES } from './folder-names.js';

export type WorkspaceMode = 'standard' | 'ghost';

export interface GhostMarker {
  kind: 'project-registry';
  registryPath: string;
  projectRoot: string;
  projectId: string;
}

export interface ProjectEntry {
  id: string;
  ghost: boolean;
  createdAt: string;
}

export interface ProjectRegistryInspection {
  inputProjectRoot: string;
  projectRoot: string;
  projectRealpath: string;
  registryPath: string;
  registered: boolean;
  entry: ProjectEntry | null;
  mode: WorkspaceMode;
  ghost: boolean;
  projectId: string | null;
  expectedProjectId: string;
  dataRoot: string;
  dataRootSource: 'project-root' | 'ghost-registry';
  workspaceExists: boolean;
  ghostMarker: GhostMarker | null;
}

interface RegistryData {
  version: 1;
  projects: Record<string, ProjectEntry>;
}

/**
 * 为项目路径生成稳定的短 ID
 * 使用 realpath 规范化，避免符号链接导致重复注册
 */
function getUserHome(): string {
  return process.env.ALEMBIC_HOME || process.env.HOME || process.env.USERPROFILE || '';
}

export function getProjectRegistryDir(): string {
  return path.join(getUserHome(), DEFAULT_FOLDER_NAMES.global.root);
}

export function getProjectRegistryPath(): string {
  return path.join(getProjectRegistryDir(), 'projects.json');
}

export function normalizeProjectPath(projectRoot: string): string {
  try {
    return fs.realpathSync(projectRoot);
  } catch {
    return path.resolve(projectRoot);
  }
}

export function generateProjectId(projectRoot: string): string {
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
    const registryPath = getProjectRegistryPath();
    if (fs.existsSync(registryPath)) {
      const raw = fs.readFileSync(registryPath, 'utf-8');
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

function saveRegistry(data: RegistryData, wz?: WriteZone): void {
  if (wz) {
    wz.writeFile(wz.global('projects.json'), JSON.stringify(data, null, 2));
  } else {
    const registryDir = getProjectRegistryDir();
    if (!fs.existsSync(registryDir)) {
      fs.mkdirSync(registryDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(getProjectRegistryPath(), JSON.stringify(data, null, 2), { mode: 0o600 });
  }
}

/** 获取 Ghost 模式的外置工作区根目录 */
export function getGhostWorkspaceDir(projectId: string): string {
  return path.join(
    getUserHome(),
    DEFAULT_FOLDER_NAMES.global.root,
    DEFAULT_FOLDER_NAMES.global.workspaces,
    projectId
  );
}

export const ProjectRegistry = {
  /**
   * 查找项目注册信息
   * @returns ProjectEntry 或 null（未注册）
   */
  get(projectRoot: string): ProjectEntry | null {
    const data = loadRegistry();
    const normalized = normalizeProjectPath(projectRoot);
    return data.projects[normalized] ?? null;
  },

  /**
   * 返回项目的 Ghost/标准模式判定事实。
   * 这是诊断、N0-data-location 和 resolver 的统一来源，避免手写解析 projects.json。
   */
  inspect(projectRoot: string): ProjectRegistryInspection {
    const inputProjectRoot = path.resolve(projectRoot);
    const projectRealpath = normalizeProjectPath(projectRoot);
    const data = loadRegistry();
    const entry = data.projects[projectRealpath] ?? null;
    const ghost = entry?.ghost === true;
    const projectId = entry?.id ?? null;
    const dataRoot = ghost && projectId ? getGhostWorkspaceDir(projectId) : inputProjectRoot;
    const registryPath = getProjectRegistryPath();
    const expectedProjectId = generateProjectId(projectRoot);

    return {
      inputProjectRoot,
      projectRoot: inputProjectRoot,
      projectRealpath,
      registryPath,
      registered: entry !== null,
      entry,
      mode: ghost ? 'ghost' : 'standard',
      ghost,
      projectId,
      expectedProjectId,
      dataRoot,
      dataRootSource: ghost ? 'ghost-registry' : 'project-root',
      workspaceExists: fs.existsSync(dataRoot),
      ghostMarker:
        ghost && projectId
          ? {
              kind: 'project-registry',
              registryPath,
              projectRoot: projectRealpath,
              projectId,
            }
          : null,
    };
  },

  /**
   * 注册项目（幂等）
   * 如果已注册，更新 ghost 状态
   */
  register(projectRoot: string, ghost: boolean, writeZone?: WriteZone): ProjectEntry {
    const data = loadRegistry();
    const normalized = normalizeProjectPath(projectRoot);

    const existing = data.projects[normalized];
    if (existing) {
      existing.ghost = ghost;
      saveRegistry(data, writeZone);
      return existing;
    }

    const entry: ProjectEntry = {
      id: generateProjectId(projectRoot),
      ghost,
      createdAt: new Date().toISOString(),
    };
    data.projects[normalized] = entry;
    saveRegistry(data, writeZone);
    return entry;
  },

  /**
   * 移除项目注册
   */
  unregister(projectRoot: string, writeZone?: WriteZone): boolean {
    const data = loadRegistry();
    const normalized = normalizeProjectPath(projectRoot);
    if (data.projects[normalized]) {
      delete data.projects[normalized];
      saveRegistry(data, writeZone);
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
    const inspection = this.inspect(projectRoot);
    if (!inspection.ghost) {
      return null;
    }
    return inspection.dataRoot;
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

export default ProjectRegistry;
