import fs from 'node:fs';
import path from 'node:path';
import * as PathFinder from '../spm/PathFinder.js';

/**
 * HeaderResolver — ObjC/Swift #import 头文件路径解析
 * 解析 import 语句，定位头文件相对路径
 */

/** 解析单行 import 语句 */
export function parseImportLine(headerStr: string) {
  const s = String(headerStr || '').trim();
  const angle = s.match(/#import\s+<([^>]+)>/);
  if (angle) {
    const part = angle[1].trim();
    const slash = part.indexOf('/');
    if (slash !== -1) {
      return { moduleName: part.slice(0, slash), headerName: path.basename(part, '.h') };
    }
    return { moduleName: null, headerName: path.basename(part, '.h') };
  }
  const quote = s.match(/#import\s+"([^"]+)"/);
  if (quote) {
    return { moduleName: null, headerName: path.basename(quote[1], '.h') };
  }
  return null;
}

/** 解析单个 import 的相对路径 */
export async function resolveHeaderRelativePath(headerStr: string, targetRootDir: string) {
  if (!targetRootDir) {
    return undefined;
  }
  const parsed = parseImportLine(headerStr);
  if (!parsed) {
    return undefined;
  }
  const { moduleName, headerName } = parsed;
  const headerPath = await PathFinder.findSubHeaderPath(targetRootDir, headerName, moduleName);
  if (!headerPath) {
    return undefined;
  }
  return path.relative(targetRootDir, headerPath);
}

/** 从文件路径和 Package 信息推断模块名 */
export function determineModuleNameFromPath(
  filePath: string,
  packageInfo: { path: string; targets?: string[]; name?: string }
) {
  const relativePath = path.relative(packageInfo.path, filePath);
  const segments = relativePath.split(path.sep);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (packageInfo.targets?.includes(segments[i])) {
      return segments[i];
    }
  }
  return packageInfo.targets?.[0] || packageInfo.name || null;
}

/** 综合解析：从路径+文本提取 headers、headerPaths、moduleName */
export async function resolveHeadersForText(
  projectRoot: string,
  relativePath: string,
  text: string
) {
  const fullPath = path.resolve(projectRoot, (relativePath || '').trim());
  if (!relativePath || !fs.existsSync(fullPath)) {
    return { headers: [], headerPaths: [], moduleName: null };
  }

  const targetRootDir = await PathFinder.findTargetRootDir(fullPath);
  let moduleName = targetRootDir ? path.basename(targetRootDir) : null;

  const importRegex = /^(?:#import|import)\s+.*$/gm;
  let headers = (text.match(importRegex) || []).filter(Boolean);
  let headerPaths = targetRootDir
    ? await Promise.all(headers.map((h) => resolveHeaderRelativePath(h, targetRootDir)))
    : [];

  // 如果 .m/.mm 无 import，尝试推断同名 .h
  const ext = path.extname(fullPath).toLowerCase();
  if (targetRootDir && headers.length === 0 && (ext === '.m' || ext === '.mm')) {
    const headerNameWithoutExt = path.basename(fullPath, ext);
    const packagePath = await PathFinder.findPackageSwiftPath(fullPath);
    const packageInfo = packagePath ? await PathFinder.parsePackageSwift(packagePath) : null;
    if (packageInfo) {
      moduleName = determineModuleNameFromPath(fullPath, packageInfo);
    }
    const headerPath = await PathFinder.findSubHeaderPath(
      targetRootDir,
      headerNameWithoutExt,
      moduleName
    );
    if (headerPath) {
      headers = [
        `#import <${moduleName || path.basename(targetRootDir)}/${headerNameWithoutExt}.h>`,
      ];
      headerPaths = [path.relative(targetRootDir, headerPath)];
    }
  }

  return { headers, headerPaths, moduleName };
}

export default {
  resolveHeadersForText,
  parseImportLine,
  resolveHeaderRelativePath,
  determineModuleNameFromPath,
};
