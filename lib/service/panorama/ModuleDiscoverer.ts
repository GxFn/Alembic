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
import { LanguageProfiles } from '#shared/LanguageProfiles.js';
import { inferTargetRole } from '../../external/mcp/handlers/TargetClassifier.js';
import type { CodeEntityRepositoryImpl } from '../../repository/code/CodeEntityRepository.js';
import type { KnowledgeEdgeRepositoryImpl } from '../../repository/knowledge/KnowledgeEdgeRepository.js';
import type { ModuleRole } from './PanoramaTypes.js';
import type { ModuleCandidate } from './RoleRefiner.js';

/* ═══ Constants ═══════════════════════════════════════════ */

// All language-specific constants are now in LanguageProfiles.
// These aliases delegate to the unified registry for backward compat:
const SOURCE_EXTS = LanguageProfiles.sourceExts;
const SKIP_DIRS = LanguageProfiles.skipDirs;
const HOST_SKIP_SUFFIXES = LanguageProfiles.artifactSuffixes;
const HOST_VENDOR_DIRS = LanguageProfiles.vendorDirs;

/* ═══ ModuleDiscoverer Class ══════════════════════════════ */

export class ModuleDiscoverer {
  readonly #entityRepo: CodeEntityRepositoryImpl;
  readonly #edgeRepo: KnowledgeEdgeRepositoryImpl;
  readonly #projectRoot: string;

  constructor(
    entityRepo: CodeEntityRepositoryImpl,
    edgeRepo: KnowledgeEdgeRepositoryImpl,
    projectRoot: string
  ) {
    this.#entityRepo = entityRepo;
    this.#edgeRepo = edgeRepo;
    this.#projectRoot = projectRoot;
  }

  /**
   * 从 DB 中读取已扫描的模块数据。
   * 若无 module 实体（含 host），返回空数组（让调用侧决定是否重新扫描）。
   */
  async discover(): Promise<ModuleCandidate[]> {
    // 从 code_entities 查 entity_type = 'module'（排除 external/host 节点）
    const moduleEntities = await this.#entityRepo.findLocalModules(this.#projectRoot);

    // 检查是否存在 host 模块（用于后续分解）
    const hasHostModules = await this.#hasHostModules();

    if (moduleEntities.length === 0 && !hasHostModules) {
      return [];
    }

    // 收集 is_part_of 边关联的文件
    const moduleFiles = new Map<string, Set<string>>();
    for (const me of moduleEntities) {
      const moduleName = me.entityId;
      moduleFiles.set(moduleName, new Set());

      const parts = await this.#edgeRepo.findIncomingByRelation(moduleName, 'is_part_of');

      for (const part of parts) {
        const entity = await this.#entityRepo.findByEntityIdOnly(part.fromId, this.#projectRoot);

        if (entity?.filePath) {
          moduleFiles.get(moduleName)!.add(entity.filePath);
        }
      }
    }

    // 策略 1.5: module 实体有但文件为空（SPM 只建了模块节点）
    const totalFileCount = [...moduleFiles.values()].reduce((sum, s) => sum + s.size, 0);
    if (totalFileCount === 0) {
      await this.#enrichModuleFiles(moduleFiles);
    }

    // 读取模块 metadata 中的 configLayer 信息
    const moduleLayerMap = await this.#readModuleLayerMetadata(moduleEntities);

    const regularModules = [...moduleFiles.entries()].map(([name, files]) => ({
      name,
      inferredRole: inferTargetRole(name) as ModuleRole,
      files: [...files],
      configLayer: moduleLayerMap.get(name),
    }));

    // 策略 2: 分解 host 模块（主工程目录）为子模块
    const hostSubModules = await this.#decomposeHostModules(moduleFiles);

    return [...regularModules, ...hostSubModules];
  }

  /**
   * 读取 config layers 元数据（如果存在）
   * @returns 从 `__config_layers__` 实体中恢复的层级定义
   */
  async readConfigLayers(): Promise<Array<{
    name: string;
    order: number;
    accessibleLayers: string[];
  }> | null> {
    try {
      const entity = await this.#entityRepo.findByEntityIdOnly(
        '__config_layers__',
        this.#projectRoot
      );

      if (!entity?.metadata) {
        return null;
      }

      const meta = entity.metadata;

      if (Array.isArray(meta.layers) && meta.layers.length > 0) {
        const layers = meta.layers as Array<{
          name: string;
          order: number;
          accessibleLayers: string[];
        }>;

        // 当存在 host 模块时，注入 Application 层（位于所有配置层之上）
        if (await this.#hasHostModules()) {
          const minOrder = Math.min(...layers.map((l) => l.order));
          const hasAppLayer = layers.some(
            (l) => l.name.toLowerCase() === 'application' || l.name.toLowerCase() === 'app'
          );
          if (!hasAppLayer) {
            layers.unshift({
              name: 'Application',
              order: minOrder - 1,
              accessibleLayers: layers.map((l) => l.name),
            });
          }
        }

        return layers;
      }
    } catch {
      /* skip parse error */
    }

    return null;
  }

  /* ─── 策略 1.5: 模块文件充填 ───────────────────── */

  /**
   * 从 code_entities metadata 中读取每个模块的 layer 信息
   */
  async #readModuleLayerMetadata(
    moduleEntities: Array<{ entityId: string }>
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    for (const me of moduleEntities) {
      const moduleName = me.entityId;
      try {
        const entity = await this.#entityRepo.findByEntityIdOnly(moduleName, this.#projectRoot);

        if (entity?.metadata) {
          const meta = entity.metadata;
          if (meta.layer && typeof meta.layer === 'string') {
            result.set(moduleName, meta.layer);
          }
        }
      } catch {
        /* skip parse error */
      }
    }

    return result;
  }

  /**
   * 检查 DB 中是否存在 nodeType='host' 的模块实体
   */
  async #hasHostModules(): Promise<boolean> {
    try {
      const cnt = await this.#entityRepo.countModulesByNodeType(this.#projectRoot, 'host');
      return cnt > 0;
    } catch {
      return false;
    }
  }

  /**
   * 为已知模块名填充文件路径：
   *   a. 文件系统扫描（递归 4 层找模块同名目录）
   *   b. DB code_entities.file_path 路径段匹配
   */
  async #enrichModuleFiles(moduleFiles: Map<string, Set<string>>): Promise<void> {
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

    const allFiles = await this.#entityRepo.findDistinctFilePaths(this.#projectRoot);

    // 长名优先，避免短名误匹配
    const sorted = [...moduleNames].sort((a, b) => b.length - a.length);
    for (const filePath of allFiles) {
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

  /* ─── 策略 2: Host 模块分解 ────────────────────── */

  /**
   * 分解 host 类型模块（主工程目录）为子模块。
   *
   * 适用场景：混合项目（如 Boxfile/EasyBox + 主工程未模块化代码）中，
   * host 模块包含大量按文件夹组织但未声明为独立模块的业务代码。
   *
   * 策略：
   *   1. 从 DB 查询 nodeType='host' 的模块实体
   *   2. 扫描 host 目录的子文件夹，每个含 ≥2 个源文件的文件夹视为隐式子模块
   *   3. 排除已被现有模块覆盖的文件（避免重复计数）
   *   4. 跳过资源目录（.xcassets, .bundle, .lproj 等）和第三方代码目录
   *   5. 当项目有 configLayers 时，为子模块分配 Application 层（host 在所有声明层之上）
   */
  async #decomposeHostModules(
    existingModuleFiles: Map<string, Set<string>>
  ): Promise<ModuleCandidate[]> {
    const hostEntities = await this.#entityRepo.findModulesByNodeTypes(this.#projectRoot, ['host']);

    if (hostEntities.length === 0) {
      return [];
    }

    // 检查是否有 configLayers — 决定是否分配 Application 层
    const hasConfigLayers = (await this.readConfigLayers()) !== null;

    // 已有模块名 + 所有已归属文件（用于去重）
    const existingNames = new Set(existingModuleFiles.keys());
    const allExistingFiles = new Set<string>();
    for (const files of existingModuleFiles.values()) {
      for (const f of files) {
        allExistingFiles.add(f);
      }
    }

    const result: ModuleCandidate[] = [];

    for (const host of hostEntities) {
      let meta: Record<string, unknown> = {};
      try {
        meta = (host.metadata as Record<string, unknown>) ?? {};
      } catch {
        /* skip parse error */
      }

      const hostName = host.name as string;
      const hostDir = (meta.fullPath as string) || path.join(this.#projectRoot, hostName);

      if (!this.#isDirectory(hostDir)) {
        continue;
      }

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(hostDir, { withFileTypes: true });
      } catch {
        continue;
      }

      const rootFiles: string[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          // 跳过隐藏目录、构建产物、资源目录
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
            continue;
          }
          if (HOST_SKIP_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
            continue;
          }
          // 跳过第三方/供应商代码目录
          if (HOST_VENDOR_DIRS.has(entry.name.toLowerCase())) {
            continue;
          }

          const dirPath = path.join(hostDir, entry.name);
          const files = this.#collectSourceFiles(dirPath).filter((f) => !allExistingFiles.has(f));

          if (files.length < 2) {
            continue;
          }

          // 名称冲突时加 host 前缀
          const moduleName = existingNames.has(entry.name)
            ? `${hostName}/${entry.name}`
            : entry.name;

          result.push({
            name: moduleName,
            inferredRole: inferTargetRole(entry.name) as ModuleRole,
            files,
            configLayer: hasConfigLayers ? 'Application' : undefined,
          });
        } else if (entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name).toLowerCase())) {
          const fullPath = path.join(hostDir, entry.name);
          if (!allExistingFiles.has(fullPath)) {
            rootFiles.push(fullPath);
          }
        }
      }

      // 主工程根级文件归入宿主模块本身
      if (rootFiles.length > 0) {
        result.push({
          name: hostName,
          inferredRole: 'app' as ModuleRole,
          files: rootFiles,
          configLayer: hasConfigLayers ? 'Application' : undefined,
        });
      }
    }

    return result;
  }

  #isDirectory(dirPath: string): boolean {
    try {
      return fs.statSync(dirPath).isDirectory();
    } catch {
      return false;
    }
  }
}
