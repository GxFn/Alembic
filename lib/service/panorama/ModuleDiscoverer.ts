/**
 * ModuleDiscoverer — 模块发现与文件归属
 *
 * 从 DB（code_entities / knowledge_edges）读取已扫描的模块数据。
 * 前提：PanoramaScanner.ensureData() 保证 DB 中已有结构数据。
 *
 *   策略 1:   code_entities entity_type='module' + is_part_of 边 → 完整数据
 *   策略 1.5: module 实体存在但无 is_part_of 边 → 文件系统 + DB 路径补全
 *
 * 若 DB 中无 module 实体，返回空数组（由 PanoramaScanner 负责兜底扫描）。
 *
 * @module ModuleDiscoverer
 */

import fs from 'node:fs';
import path from 'node:path';

import { inferTargetRole } from '../../external/mcp/handlers/TargetClassifier.js';
import type { CeDbLike } from './PanoramaTypes.js';
import type { ModuleCandidate, ModuleRole } from './RoleRefiner.js';

/* ═══ Constants ═══════════════════════════════════════════ */

const SOURCE_EXTS = new Set([
  '.swift',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.m',
  '.mm',
  '.h',
  '.c',
  '.cpp',
  '.kt',
  '.java',
  '.py',
  '.rb',
  '.go',
  '.rs',
]);

const SKIP_DIRS = new Set([
  '.git',
  '.build',
  '.autosnippet',
  'node_modules',
  'build',
  'Pods',
  'DerivedData',
  '.swiftpm',
  '__pycache__',
  'dist',
]);

/* ═══ ModuleDiscoverer Class ══════════════════════════════ */

export class ModuleDiscoverer {
  readonly #db: CeDbLike;
  readonly #projectRoot: string;

  constructor(db: CeDbLike, projectRoot: string) {
    this.#db = db;
    this.#projectRoot = projectRoot;
  }

  /**
   * 从 DB 中读取已扫描的模块数据。
   * 若无 module 实体，返回空数组（让调用侧决定是否重新扫描）。
   */
  discover(): ModuleCandidate[] {
    // 从 code_entities 查 entity_type = 'module'
    const moduleEntities = this.#db
      .prepare(
        `SELECT DISTINCT entity_id, name FROM code_entities
         WHERE entity_type = 'module' AND project_root = ?`
      )
      .all(this.#projectRoot) as Array<Record<string, unknown>>;

    if (moduleEntities.length === 0) {
      return [];
    }

    // 收集 is_part_of 边关联的文件
    const moduleFiles = new Map<string, Set<string>>();
    for (const me of moduleEntities) {
      const moduleName = me.entity_id as string;
      moduleFiles.set(moduleName, new Set());

      const parts = this.#db
        .prepare(
          `SELECT ke.from_id FROM knowledge_edges ke
           WHERE ke.to_id = ? AND ke.to_type = 'module' AND ke.relation = 'is_part_of'`
        )
        .all(moduleName) as Array<Record<string, unknown>>;

      for (const part of parts) {
        const entity = this.#db
          .prepare(
            `SELECT file_path FROM code_entities
             WHERE entity_id = ? AND project_root = ? LIMIT 1`
          )
          .get(part.from_id as string, this.#projectRoot) as Record<string, unknown> | undefined;

        if (entity?.file_path) {
          moduleFiles.get(moduleName)!.add(entity.file_path as string);
        }
      }
    }

    // 策略 1.5: module 实体有但文件为空（SPM 只建了模块节点）
    const totalFileCount = [...moduleFiles.values()].reduce((sum, s) => sum + s.size, 0);
    if (totalFileCount === 0) {
      this.#enrichModuleFiles(moduleFiles);
    }

    return [...moduleFiles.entries()].map(([name, files]) => ({
      name,
      inferredRole: inferTargetRole(name) as ModuleRole,
      files: [...files],
    }));
  }

  /* ─── 策略 1.5: 模块文件充填 ───────────────────── */

  /**
   * 为已知模块名填充文件路径：
   *   a. 文件系统扫描（递归 4 层找模块同名目录）
   *   b. DB code_entities.file_path 路径段匹配
   */
  #enrichModuleFiles(moduleFiles: Map<string, Set<string>>): void {
    const moduleNames = [...moduleFiles.keys()];

    // a. 文件系统扫描
    for (const modName of moduleNames) {
      const dir = this.#findModuleDir(this.#projectRoot, modName, 4);
      if (dir) {
        for (const f of this.#collectSourceFiles(dir)) {
          moduleFiles.get(modName)!.add(f);
        }
      }
    }

    // b. 如果 FS 扫描仍为空 → DB 路径匹配
    const totalAfterFs = [...moduleFiles.values()].reduce((sum, s) => sum + s.size, 0);
    if (totalAfterFs > 0) {
      return;
    }

    const allFiles = this.#db
      .prepare(
        `SELECT DISTINCT file_path FROM code_entities
         WHERE project_root = ? AND file_path IS NOT NULL AND entity_type != 'module'`
      )
      .all(this.#projectRoot) as Array<Record<string, unknown>>;

    // 长名优先，避免短名误匹配
    const sorted = [...moduleNames].sort((a, b) => b.length - a.length);
    for (const row of allFiles) {
      const filePath = row.file_path as string;
      if (!filePath) {
        continue;
      }
      for (const modName of sorted) {
        if (filePath.includes(`/${modName}/`) || filePath.startsWith(`${modName}/`)) {
          moduleFiles.get(modName)!.add(filePath);
          break; // 一个文件只属于一个模块
        }
      }
    }
  }

  /* ─── 文件系统辅助 ────────────────────────────── */

  #findModuleDir(rootDir: string, targetName: string, maxDepth: number): string | null {
    if (maxDepth <= 0) {
      return null;
    }
    try {
      const entries = fs.readdirSync(rootDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        const fullPath = path.join(rootDir, entry.name);
        if (entry.name === targetName) {
          return fullPath;
        }
        const found = this.#findModuleDir(fullPath, targetName, maxDepth - 1);
        if (found) {
          return found;
        }
      }
    } catch {
      // 无法读取目录
    }
    return null;
  }

  #collectSourceFiles(dir: string): string[] {
    const files: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
          files.push(...this.#collectSourceFiles(fullPath));
        } else if (entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name).toLowerCase())) {
          files.push(fullPath);
        }
      }
    } catch {
      // 无法读取
    }
    return files;
  }
}
