import fs from 'node:fs';
import path from 'node:path';

/**
 * PathFinder — 轻量级路径发现工具（V2 ESM）
 * 从文件路径向上查找 SPM 项目结构：Package.swift、Target 根目录、头文件路径
 */

/**
 * 向上遍历目录，查找含 Code/ 或 Sources/ 子目录的 target 根目录
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
export async function findTargetRootDir(filePath) {
  let current = path.dirname(path.resolve(filePath));
  for (let i = 0; i < 10; i++) {
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && (e.name === 'Code' || e.name === 'Sources')) {
          return current;
        }
      }
    } catch {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

/**
 * 向上查找 Package.swift
 */
export async function findPackageSwiftPath(filePath) {
  let current = path.dirname(path.resolve(filePath));
  for (let i = 0; i < 15; i++) {
    const candidate = path.join(current, 'Package.swift');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

/**
 * 简易解析 Package.swift，提取 targets 数组和包名
 */
export async function parsePackageSwift(packagePath) {
  try {
    const content = fs.readFileSync(packagePath, 'utf8');
    const nameMatch = content.match(/name:\s*"([^"]+)"/);
    const name = nameMatch?.[1] || path.basename(path.dirname(packagePath));

    const targets: string[] = [];
    const targetRe = /\.(?:target|testTarget|executableTarget)\s*\(\s*name:\s*"([^"]+)"/g;
    let m;
    while ((m = targetRe.exec(content)) !== null) {
      targets.push(m[1]);
    }
    return { name, path: path.dirname(packagePath), targets };
  } catch {
    return null;
  }
}

/**
 * 在 targetRootDir 下递归查找指定头文件
 * @param {string} rootDir - target 根目录
 * @param {string} headerName 不含扩展名的头文件名
 * @param {string|null} moduleName 模块名（可选，用于优先匹配模块子目录）
 * @returns {Promise<string|null>}
 */
export async function findSubHeaderPath(rootDir, headerName, moduleName) {
  if (!rootDir || !headerName) {
    return null;
  }
  const target = `${headerName}.h`;

  // 优先在模块名子目录下找
  if (moduleName) {
    const modDir = path.join(rootDir, 'Sources', moduleName);
    const found = _findFile(modDir, target);
    if (found) {
      return found;
    }
  }

  // 全局搜索
  return _findFile(rootDir, target);
}

function _findFile(dir, filename, maxDepth = 8, depth = 0) {
  if (depth > maxDepth || !fs.existsSync(dir)) {
    return null;
  }
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === filename) {
        return full;
      }
      if (entry.isDirectory()) {
        const found = _findFile(full, filename, maxDepth, depth + 1);
        if (found) {
          return found;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export default {
  findTargetRootDir,
  findPackageSwiftPath,
  parsePackageSwift,
  findSubHeaderPath,
};
