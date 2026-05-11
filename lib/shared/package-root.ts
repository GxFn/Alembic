/**
 * package-root.ts — 统一的包根目录定位工具
 *
 * 通过沿目录树向上查找 package.json 来确定包根目录。
 * 在源码布局（lib/shared/）和编译布局（dist/lib/shared/）下都能正确工作，
 * 避免在每个文件中手动计算 `../` 层级。
 *
 * @example
 * ```ts
 * import { PACKAGE_ROOT, INJECTABLE_SKILLS_DIR, RESOURCES_DIR } from '../../shared/package-root.js';
 * ```
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_FOLDER_NAMES } from './folder-names.js';

const __dirname = import.meta.dirname;

/**
 * 沿目录树向上查找包含 package.json（且 name === 'alembic-ai'）的目录。
 * 使用 name 校验避免误匹配到 monorepo 父包或 node_modules 中的其它包。
 */
function findPackageRoot(): string {
  let dir = __dirname;
  // 最多向上 10 级，防止意外的无限循环
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8'));
        if (pkg.name === 'alembic-ai') {
          return dir;
        }
      } catch {
        // JSON 解析失败，继续向上查找
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    } // 已到文件系统根
    dir = parent;
  }
  throw new Error(
    '[Alembic] Could not locate package root. ' +
      'No ancestor directory contains a package.json with name "alembic-ai".'
  );
}

// ─── 导出常量 ────────────────────────────────────────────

/** Alembic 包的根目录（包含 package.json 的目录） */
export const PACKAGE_ROOT = findPackageRoot();

/** `<root>/config/` — 配置文件目录 */
export const CONFIG_DIR = path.join(PACKAGE_ROOT, DEFAULT_FOLDER_NAMES.package.config);

/** `<root>/skills/` — Alembic 仓库内部维护 Skill 目录 */
export const INTERNAL_SKILLS_DIR = path.join(
  PACKAGE_ROOT,
  DEFAULT_FOLDER_NAMES.package.internalSkills
);

/** `<root>/injectable-skills/` — 产品内置注入 Skill 源目录 */
export const INJECTABLE_SKILLS_DIR = path.join(
  PACKAGE_ROOT,
  DEFAULT_FOLDER_NAMES.package.injectableSkills
);

/** @deprecated Use INJECTABLE_SKILLS_DIR for product builtin skills. */
export const SKILLS_DIR = INJECTABLE_SKILLS_DIR;

/** `<root>/templates/` — 模板目录 */
export const TEMPLATES_DIR = path.join(PACKAGE_ROOT, DEFAULT_FOLDER_NAMES.package.templates);

/** `<root>/resources/` — 静态资源目录 */
export const RESOURCES_DIR = path.join(PACKAGE_ROOT, DEFAULT_FOLDER_NAMES.package.resources);

/** `<root>/dashboard/` — Dashboard 前端目录 */
export const DASHBOARD_DIR = path.join(PACKAGE_ROOT, DEFAULT_FOLDER_NAMES.package.dashboard);
