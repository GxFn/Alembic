import fs from 'node:fs';
import path from 'node:path';
import pathGuard from '../../shared/PathGuard.js';

/**
 * Paths — 项目路径解析工具
 * 提供 Snippet 安装目录、缓存目录、知识库目录等路径计算能力。
 *
 * 设计原则：路径解析与目录创建分离
 *  - 路径 getter 函数仅返回路径字符串，不产生文件系统副作用
 *  - 需要创建目录时，调用方应使用 ensureDir() 显式确保目录存在
 *  - 全局非项目目录（Xcode snippets、cache）在获取时自动创建
 */

export const SPEC_FILENAME = 'AutoSnippet.boxspec.json';

const USER_HOME = process.env.HOME || process.env.USERPROFILE || '';

/** 确保目录存在（静默处理异常），供写入前调用 */
export function ensureDir(dirPath: any) {
  try {
    // 双层路径安全检查 — 阻止在项目允许范围外创建文件夹
    pathGuard.assertProjectWriteSafe(dirPath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  } catch {
    /* ignore */
  }
  return dirPath;
}

/**
 * Xcode CodeSnippets 输出目录 (macOS only)
 * 可通过 ASD_SNIPPETS_PATH 环境变量覆盖
 * 非 macOS 返回全局缓存下的 snippets/ 子目录
 */
export function getSnippetsPath() {
  if (process.env.ASD_SNIPPETS_PATH) {
    return process.env.ASD_SNIPPETS_PATH;
  }
  if (process.platform === 'darwin') {
    return ensureDir(path.join(USER_HOME, 'Library/Developer/Xcode/UserData/CodeSnippets'));
  }
  // 非 macOS: 放到全局缓存目录下
  return ensureDir(path.join(USER_HOME, '.autosnippet', 'snippets'));
}

/**
 * VSCode 项目级 Snippets 目录 = projectRoot/.vscode/
 * @param {string} projectRoot
 * @returns {string}
 */
export function getVSCodeSnippetsPath(projectRoot: any) {
  return ensureDir(path.join(projectRoot, '.vscode'));
}

/**
 * AutoSnippet 全局缓存目录 ~/.autosnippet/cache
 * 可通过 ASD_CACHE_PATH 环境变量覆盖
 */
export function getCachePath() {
  if (process.env.ASD_CACHE_PATH) {
    return process.env.ASD_CACHE_PATH;
  }
  return ensureDir(path.join(USER_HOME, '.autosnippet', 'cache'));
}

/**
 * 获取包含 AutoSnippet.boxspec.json 的子目录名称
 * 遍历 projectRoot 一级子目录，找到含 spec 文件的目录
 * @param {string} projectRoot
 * @returns {string} 知识库目录名（默认 'AutoSnippet'）
 */
export function getKnowledgeBaseDirName(projectRoot: any) {
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
  return 'AutoSnippet';
}

/**
 * 知识库根目录 = projectRoot/{dirContainingBoxspec}
 * 注意：仅返回路径，不创建目录
 */
export function getProjectKnowledgePath(projectRoot: any) {
  return path.join(projectRoot, getKnowledgeBaseDirName(projectRoot));
}

/**
 * Spec 文件路径 = knowledgePath/AutoSnippet.boxspec.json
 */
export function getProjectSpecPath(projectRoot: any) {
  return path.join(getProjectKnowledgePath(projectRoot), SPEC_FILENAME);
}

/**
 * 项目内部隐藏数据目录 = knowledgePath/.autosnippet
 * 注意：仅返回路径，不创建目录
 */
export function getProjectInternalDataPath(projectRoot: any) {
  return path.join(getProjectKnowledgePath(projectRoot), '.autosnippet');
}

/**
 * 上下文存储目录 = internalData/context
 * 注意：仅返回路径，不创建目录
 */
export function getContextStoragePath(projectRoot: any) {
  return path.join(getProjectInternalDataPath(projectRoot), 'context');
}

/**
 * 上下文索引目录 = contextStorage/index
 * 注意：仅返回路径，不创建目录
 */
export function getContextIndexPath(projectRoot: any) {
  return path.join(getContextStoragePath(projectRoot), 'index');
}

/**
 * 项目级 Skills 目录 = knowledgePath/skills
 * Skills 放在知识库目录下跟随项目走（Git-tracked，用户可见）
 * 注意：仅返回路径，不创建目录
 */
export function getProjectSkillsPath(projectRoot: any) {
  return path.join(getProjectKnowledgePath(projectRoot), 'skills');
}

/**
 * Recipes 目录
 * 优先使用 rootSpec.recipes.dir / rootSpec.skills.dir（兼容旧配置）
 * @param {string} projectRoot
 * @param {object} [rootSpec] 项目 spec 对象（可选）
 */
export function getProjectRecipesPath(projectRoot: any, rootSpec?: any) {
  const dir = rootSpec?.recipes?.dir || rootSpec?.skills?.dir || null;
  if (dir) {
    return path.join(projectRoot, dir);
  }
  return path.join(getProjectKnowledgePath(projectRoot), 'recipes');
}

export default {
  SPEC_FILENAME,
  ensureDir,
  getSnippetsPath,
  getVSCodeSnippetsPath,
  getCachePath,
  getKnowledgeBaseDirName,
  getProjectKnowledgePath,
  getProjectSpecPath,
  getProjectInternalDataPath,
  getProjectSkillsPath,
  getContextStoragePath,
  getContextIndexPath,
  getProjectRecipesPath,
};
