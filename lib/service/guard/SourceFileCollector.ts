/**
 * SourceFileCollector — 递归收集项目源文件
 *
 * 从 GuardHandler 提取的公共工具，供 ComplianceReporter / guard:ci / guard:staged 复用
 */

import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { LanguageService } from '../../shared/LanguageService.js';

/** 支持审计的源文件扩展名 — 委托给 LanguageService */
export const SOURCE_EXTS = LanguageService.sourceExts;

/** 跳过的目录 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'build',
  'DerivedData',
  'Pods',
  '.build',
  'vendor',
  'dist',
  '.next',
  'Carthage',
  'xcuserdata',
  '__pycache__',
  // Rust
  'target',
  '.cargo',
  // Python 虚拟环境
  'venv',
  '.venv',
  'env',
  // JVM 构建工具
  '.gradle',
  '.mvn',
  // 通用构建/输出目录
  'out',
  'coverage',
  '.turbo',
  '.parcel-cache',
]);

/**
 * 递归收集目录下所有源文件路径
 * @param {string} dir 根目录
 * @param {object} options
 * @param {Set<string>} [options.extensions] 允许的扩展名（默认 SOURCE_EXTS）
 * @param {Set<string>} [options.skipDirs] 跳过的目录名（默认 SKIP_DIRS）
 * @param {number} [options.maxFiles] 最大文件数量（默认无限制）
 * @returns {Promise<string[]>} 文件路径列表
 */
export async function collectSourceFiles(dir, options: any = {}) {
  const { extensions = SOURCE_EXTS, skipDirs = SKIP_DIRS, maxFiles = Infinity } = options;

  const files: string[] = [];

  async function walk(currentDir) {
    if (files.length >= maxFiles) {
      return;
    }

    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return; // 权限不足等情况跳过
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        return;
      }
      if (entry.name.startsWith('.') && entry.name !== '.') {
        continue;
      }

      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          await walk(fullPath);
        }
      } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
  }

  await walk(dir);
  return files;
}

/**
 * 收集源文件并读取内容
 * @param {string} dir 根目录
 * @param {object} options - collectSourceFiles 选项
 * @returns {Promise<Array<{path: string, content: string}>>}
 */
export async function collectSourceFilesWithContent(dir, options: any = {}) {
  const paths = await collectSourceFiles(dir, options);
  const results: any[] = [];

  for (const filePath of paths) {
    try {
      const content = await readFile(filePath, 'utf-8');
      results.push({ path: filePath, content });
    } catch {
      // 读取失败跳过
    }
  }

  return results;
}

export default { collectSourceFiles, collectSourceFilesWithContent, SOURCE_EXTS };
