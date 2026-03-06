/**
 * SpmHelper — SPM 依赖检查与修复工具
 * 整合 PackageSwiftParser + DependencyGraph + PolicyEngine
 * 专注于 Xcode 工作流的 SPM 依赖管理（ensureDependency / addDependency / resolveCurrentTarget）
 * 模块列表、文件遍历等 Dashboard 能力由 SpmDiscoverer + ModuleService 提供
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve as pathResolve, relative, sep } from 'node:path';
import { GraphCache } from '../../../infrastructure/cache/GraphCache.js';
import Logger from '../../../infrastructure/logging/Logger.js';
import { DependencyGraph } from './DependencyGraph.js';
import { PackageSwiftParser } from './PackageSwiftParser.js';
import { PolicyEngine } from './PolicyEngine.js';

export class SpmHelper {
  #parser;
  #graph;
  #policy;
  #logger;
  #projectRoot;

  /**
   * target → { packageName, packagePath } 映射（V1 spmmap 等价）
   * @type {Map<string, {packageName: string, packagePath: string}>}
   */
  #targetPackageMap;

  /**
   * 包级依赖图：packagePath → Set<packagePath>（用于跨包循环检测）
   * @type {Map<string, Set<string>>}
   */
  #packageDepGraph;

  /** @type {GraphCache} 磁盘缓存层 */
  #graphCache;

  constructor(projectRoot: any, options: any = {}) {
    this.#projectRoot = projectRoot;
    this.#parser = options.parser || new PackageSwiftParser(projectRoot);
    this.#graph = options.graph || new DependencyGraph();
    this.#policy = options.policy || new PolicyEngine();
    this.#logger = Logger.getInstance();
    this.#targetPackageMap = new Map();
    this.#packageDepGraph = new Map();
    this.#graphCache = new GraphCache(projectRoot);
  }

  /**
   * 加载并解析 Package.swift，构建依赖图
   * 支持多 Package 项目
   * 优先从磁盘缓存加载（Package.swift contentHash 匹配即命中）
   */
  async load() {
    this.#targetPackageMap.clear();
    this.#packageDepGraph.clear();

    // ── 收集所有 Package.swift 路径 + 联合 hash ──
    const packagePath = this.#parser.findPackageSwift(this.#projectRoot);

    // 判断是否需要多包模式：
    // 1. 根目录没有 Package.swift → findAllPackageSwifts
    // 2. 根目录有 Package.swift 但 targets 为空且有 local path dependencies → 聚合根 + 子包
    let allPaths;
    if (packagePath) {
      const rootParsed = this.#parser.parse(packagePath);
      const hasNoTargets = !rootParsed?.targets || rootParsed.targets.length === 0;
      const hasLocalDeps = (rootParsed?.dependencies || []).some(
        (d: any) => d.type === 'local' || d.path
      );
      if (hasNoTargets && hasLocalDeps) {
        // 聚合根模式：根 Package.swift 仅声明 local path 依赖，target 在子包里
        allPaths = this.#parser.findAllPackageSwifts(this.#projectRoot);
        this.#logger.info(
          `[SpmHelper] 聚合根检测: 根无 target 但有 ${rootParsed.dependencies.length} 个 local dep，切换多包模式`
        );
      } else {
        allPaths = [packagePath];
      }
    } else {
      allPaths = this.#parser.findAllPackageSwifts(this.#projectRoot);
    }

    if (allPaths.length === 0) {
      this.#logger.warn('[SpmHelper] Package.swift 未找到');
      return null;
    }

    const combinedHash = allPaths.map((p: any) => this.#graphCache.computeFileHash(p)).join(':');

    // ── 尝试命中缓存 ──
    const cached = this.#graphCache.load('spm-graph');
    if (cached && cached.contentHash === combinedHash) {
      this.#restoreFromCache(cached.data);
      this.#logger.info(
        `[SpmHelper] ⚡ 缓存命中 (${this.#graph.getNodes().length} targets, hash=${combinedHash.substring(0, 8)})`
      );
      return cached.data.parsedResult;
    }

    // ── 缓存未命中，走完整解析 ──
    const startTime = Date.now();
    let parsedResult;

    if (packagePath && allPaths.length === 1) {
      // 单包模式（根有 target）
      const parsed = this.#parser.parse(packagePath);
      this.#graph.buildFromParsed(parsed);
      for (const t of parsed.targets || []) {
        this.#targetPackageMap.set(t.name, { packageName: parsed.name, packagePath });
      }
      this.#buildPackageDepGraph([{ path: packagePath, parsed }]);
      this.#logger.info(`[SpmHelper] 加载完成: ${parsed.name} (${parsed.targets.length} targets)`);
      parsedResult = parsed;
    } else {
      // 多包模式
      parsedResult = this.#loadMultiPackage(allPaths);
    }

    // ── 写入缓存 ──
    if (parsedResult) {
      this.#saveToCache(combinedHash, parsedResult);
      this.#logger.info(`[SpmHelper] 缓存已写入 (${Date.now() - startTime}ms 解析)`);
    }

    return parsedResult;
  }

  /**
   * 多包加载（从 load() 拆出）
   * @param {string[]} allPaths Package.swift 路径数组
   * @returns {object|null}
   */
  #loadMultiPackage(allPaths: any) {
    this.#logger.info(`[SpmHelper] 发现 ${allPaths.length} 个 Package.swift，逐一解析...`);
    const mergedTargets: any[] = [];
    let lastName = 'multi-package';
    const allParsed: { path: any; parsed: any }[] = [];

    this.#graph.clear();
    for (const pkgPath of allPaths) {
      try {
        const parsed = this.#parser.parse(pkgPath);
        if (parsed) {
          allParsed.push({ path: pkgPath, parsed });
          for (const t of parsed.targets || []) {
            this.#graph.addNode(t.name);
            for (const dep of t.dependencies || []) {
              this.#graph.addEdge(t.name, dep);
            }
            this.#targetPackageMap.set(t.name, { packageName: parsed.name, packagePath: pkgPath });
          }
          for (const t of parsed.targets) {
            mergedTargets.push({
              ...t,
              packageName: parsed.name,
              packagePath: pkgPath,
            });
          }
          lastName = parsed.name;
        }
      } catch (e: any) {
        this.#logger.warn(`[SpmHelper] 解析失败: ${pkgPath} - ${e.message}`);
      }
    }

    this.#buildPackageDepGraph(allParsed);

    this.#logger.info(
      `[SpmHelper] 多包加载完成: ${mergedTargets.length} targets from ${allPaths.length} packages`
    );
    return {
      name: lastName,
      targets: mergedTargets,
      path: this.#projectRoot,
    };
  }

  /**
   * 将当前内存状态序列化到缓存
   */
  #saveToCache(contentHash: any, parsedResult: any) {
    const graphJSON = this.#graph.toJSON();
    const targetPackageEntries = [...this.#targetPackageMap.entries()];
    const packageDepEntries = [...this.#packageDepGraph.entries()].map(([k, v]) => [k, [...v]]);

    this.#graphCache.save(
      'spm-graph',
      {
        parsedResult,
        graphNodes: graphJSON.nodes,
        graphEdges: graphJSON.edges,
        targetPackageMap: targetPackageEntries,
        packageDepGraph: packageDepEntries,
      },
      { contentHash }
    );
  }

  /**
   * 从缓存数据恢复内存状态
   */
  #restoreFromCache(data: any) {
    // 恢复 DependencyGraph
    this.#graph.clear();
    for (const node of data.graphNodes || []) {
      this.#graph.addNode(node);
    }
    for (const edge of data.graphEdges || []) {
      this.#graph.addEdge(edge.from, edge.to);
    }

    // 恢复 targetPackageMap
    this.#targetPackageMap.clear();
    for (const [name, info] of data.targetPackageMap || []) {
      this.#targetPackageMap.set(name, info);
    }

    // 恢复 packageDepGraph
    this.#packageDepGraph.clear();
    for (const [pkgPath, deps] of data.packageDepGraph || []) {
      this.#packageDepGraph.set(pkgPath, new Set(deps));
    }
  }

  // ─────────────── 包级依赖图构建 ───────────────

  /**
   * 解析所有 Package.swift 中的 .package(path: "...") 声明，构建包级依赖图
   * @param {{ path: string, parsed: object }[]} allParsed
   */
  #buildPackageDepGraph(allParsed: any) {
    this.#packageDepGraph.clear();

    // 初始化所有包节点
    for (const { path: pkgPath } of allParsed) {
      if (!this.#packageDepGraph.has(pkgPath)) {
        this.#packageDepGraph.set(pkgPath, new Set());
      }
    }

    // 建立 dirname → pkgPath 索引（避免 O(n²) 线性扫描）
    const dirToPkgPath = new Map();
    for (const { path: pkgPath } of allParsed) {
      dirToPkgPath.set(dirname(pkgPath), pkgPath);
    }

    // 解析 .package(path: "...") 引用，建立包级边
    for (const { path: pkgPath, parsed } of allParsed) {
      const pkgDir = dirname(pkgPath);
      const packageDeps = parsed.packageDependencies || parsed.dependencies || [];
      for (const dep of packageDeps) {
        if (dep.path) {
          const depAbsDir = pathResolve(pkgDir, dep.path);
          const otherPkgPath = dirToPkgPath.get(depAbsDir);
          if (otherPkgPath) {
            this.#packageDepGraph.get(pkgPath)?.add(otherPkgPath);
          }
        }
      }
    }

    this.#logger.debug(`[SpmHelper] 包级依赖图: ${this.#packageDepGraph.size} packages`);
  }

  /**
   * BFS 检查包级可达性（V1 _canReachPackage 等价）
   * @param {string} fromPkgPath 起始包的 Package.swift 路径
   * @param {string} toPkgPath 目标包的 Package.swift 路径
   * @returns {boolean}
   */
  _canReachPackage(fromPkgPath: any, toPkgPath: any) {
    if (fromPkgPath === toPkgPath) {
      return true;
    }
    const visited = new Set();
    const queue = [fromPkgPath];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === toPkgPath) {
        return true;
      }
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      const neighbors = this.#packageDepGraph.get(current);
      if (neighbors) {
        for (const n of neighbors) {
          queue.push(n);
        }
      }
    }
    return false;
  }

  // ─────────────── 公共查询 API ───────────────

  /**
   * 获取 target 所属包信息（V1 spmmap 等价）
   * @param {string} targetName
   * @returns {{ packageName: string, packagePath: string } | null}
   */
  getPackageForTarget(targetName: any) {
    return this.#targetPackageMap.get(targetName) || null;
  }

  /**
   * 获取 Fix Mode 配置 (V1 allowActions 等价)
   * 环境变量: ASD_FIX_SPM_DEPS_MODE = off | suggest | fix
   * - off:     不检查、不提示
   * - suggest: 仅提示（直接插入、提示操作插入按钮，无自动修复）
   * - fix:     完整4按钮（直接插入、提示操作插入、自动修复依赖、取消操作）
   * @returns {'off'|'suggest'|'fix'}
   */
  getFixMode() {
    const env = (process.env.ASD_FIX_SPM_DEPS_MODE || '').toLowerCase().trim();
    if (env === 'off' || env === 'suggest' || env === 'fix') {
      return env;
    }
    return 'suggest'; // 默认仅提示模式
  }

  /**
   * 确保依赖存在: 如果不存在则评估是否可以添加
   * 支持跨包循环检测：如果 from 和 to 在不同包内，额外检查包级依赖图
   * @param {string} from 源 target
   * @param {string} to 目标 target
   * @returns {{ exists: boolean, canAdd: boolean, reason?: string, crossPackage?: boolean }}
   */
  ensureDependency(from: any, to: any) {
    if (this.#graph.isReachable(from, to)) {
      return { exists: true, canAdd: true };
    }

    // target 级策略检查
    const check = this.#policy.canAddDependency(this.#graph, from, to);
    if (!check.allowed) {
      return { exists: false, canAdd: false, reason: check.reason };
    }

    // 跨包循环检测
    const fromPkg = this.#targetPackageMap.get(from);
    const toPkg = this.#targetPackageMap.get(to);
    if (fromPkg && toPkg && fromPkg.packagePath !== toPkg.packagePath) {
      // 检查反向：如果 toPkg 已经能到达 fromPkg，添加 from→to 会形成包级循环
      if (this._canReachPackage(toPkg.packagePath, fromPkg.packagePath)) {
        return {
          exists: false,
          canAdd: false,
          crossPackage: true,
          reason: `跨包循环依赖: ${fromPkg.packageName} ↔ ${toPkg.packageName}`,
        };
      }
      return { exists: false, canAdd: true, crossPackage: true };
    }

    return {
      exists: false,
      canAdd: check.allowed,
      reason: check.reason,
    };
  }

  /**
   * 自动修复依赖：向 Package.swift 中添加 target 级依赖（V1 DepFixer 逻辑）
   *
   * 同包 target → 添加 "TargetName" 到 dependencies
   * 跨包 target → 添加 .product(name: "X", package: "Y") + 确保 .package(path: "...") 声明
   *
   * @param {string} from 源 target
   * @param {string} to 目标 target
   * @returns {{ ok: boolean, changed: boolean, file?: string, error?: string, crossPackage?: boolean }}
   */
  addDependency(from: any, to: any) {
    // 安全检查
    const check = this.#policy.canAddDependency(this.#graph, from, to);
    if (!check.allowed) {
      return { ok: false, changed: false, error: check.reason || 'policy-blocked' };
    }

    // 判断同包 vs 跨包
    const fromPkg = this.#targetPackageMap.get(from);
    const toPkg = this.#targetPackageMap.get(to);
    const isCrossPackage = fromPkg && toPkg && fromPkg.packagePath !== toPkg.packagePath;

    try {
      // 确定要修改的 Package.swift（from 所在的包）
      const packagePath = fromPkg?.packagePath || this.#parser.findPackageSwift(this.#projectRoot);
      if (!packagePath) {
        return { ok: false, changed: false, error: 'Package.swift not found' };
      }

      const content = readFileSync(packagePath, 'utf8');

      // ── 1. 构建依赖 token ──
      let depToken;
      if (isCrossPackage) {
        // 跨包: .product(name: "TargetName", package: "PackageName")
        depToken = `.product(name: "${to}", package: "${toPkg.packageName}")`;
      } else {
        // 同包: "TargetName"
        depToken = `"${to}"`;
      }

      // ── 2. 向 from target 的 dependencies 添加 token ──
      const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const targetRe = new RegExp(
        `(\\.(?:target|testTarget|executableTarget)\\s*\\(\\s*name\\s*:\\s*"${escaped}"[\\s\\S]*?)\\)`,
        'm'
      );
      const targetMatch = content.match(targetRe);
      if (!targetMatch) {
        return { ok: false, changed: false, error: `Target "${from}" not found in Package.swift` };
      }

      const targetBlock = targetMatch[1];
      let patched;

      const depsRe = /dependencies\s*:\s*\[([^\]]*)\]/s;
      const depsMatch = targetBlock.match(depsRe);

      if (depsMatch) {
        const existingDeps = depsMatch[1].trim();
        const separator = existingDeps.length > 0 ? ',\n            ' : '\n            ';
        const newDeps = `dependencies: [${existingDeps}${separator}${depToken}\n        ]`;
        const newBlock = targetBlock.replace(depsRe, newDeps);
        patched = content.replace(targetBlock, newBlock);
      } else {
        const nameRe = /name\s*:\s*"[^"]+"/;
        const nameMatch = targetBlock.match(nameRe);
        if (!nameMatch) {
          return { ok: false, changed: false, error: `Cannot parse target "${from}" structure` };
        }
        const newBlock = targetBlock.replace(
          nameMatch[0],
          `${nameMatch[0]},\n            dependencies: [${depToken}]`
        );
        patched = content.replace(targetBlock, newBlock);
      }

      if (patched === content) {
        return { ok: false, changed: false, error: 'Patch produced no changes' };
      }

      // ── 3. 跨包: 确保 .package(path: "...") 声明存在 ──
      if (isCrossPackage) {
        const ensureResult = this.#ensurePackageDependency(patched, packagePath, toPkg);
        if (ensureResult.changed) {
          patched = ensureResult.content;
        }
      }

      writeFileSync(packagePath, patched, 'utf8');

      // 更新内存中的图
      this.#graph.addEdge(from, to);
      this.#parser.clearCache();

      this.#logger.info(
        `[SpmHelper] 已自动补齐依赖: ${from} -> ${to}${isCrossPackage ? ' (跨包)' : ''} (${packagePath})`
      );
      return { ok: true, changed: true, file: packagePath, crossPackage: isCrossPackage };
    } catch (err: any) {
      this.#logger.error(`[SpmHelper] addDependency failed: ${err.message}`);
      return { ok: false, changed: false, error: err.message };
    }
  }

  /**
   * 确保 Package.swift 中有对目标包的 .package(path: "...") 声明
   * @param {string} content - Package.swift 内容
   * @param {string} fromPkgPath 当前包的 Package.swift 路径
   * @param {{ packageName: string, packagePath: string }} toPkg 目标包信息
   * @returns {{ changed: boolean, content: string }}
   */
  #ensurePackageDependency(content: any, fromPkgPath: any, toPkg: any) {
    const fromDir = dirname(fromPkgPath);
    const toDir = dirname(toPkg.packagePath);
    const relPath = relative(fromDir, toDir).split(sep).join('/');

    // 检查是否已有对该路径的 .package 声明
    const escapedPath = relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existsRe = new RegExp(
      `\\.package\\s*\\(\\s*(?:name\\s*:[^,]*,\\s*)?path\\s*:\\s*"${escapedPath}"`,
      'm'
    );
    if (existsRe.test(content)) {
      return { changed: false, content };
    }

    // 也检查包名
    const escapedName = toPkg.packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameExistsRe = new RegExp(`\\.package\\s*\\(\\s*name\\s*:\\s*"${escapedName}"`, 'm');
    if (nameExistsRe.test(content)) {
      return { changed: false, content };
    }

    // 在 dependencies: [...] （包级）中追加
    const pkgDepsRe = /(dependencies\s*:\s*\[)([\s\S]*?)(\][\s\S]*?targets\s*:)/m;
    const pkgDepsMatch = content.match(pkgDepsRe);
    if (pkgDepsMatch) {
      const existing = pkgDepsMatch[2].trimEnd();
      const separator = existing.length > 0 ? ',\n        ' : '\n        ';
      const newDep = `.package(path: "${relPath}")`;
      const patched = content.replace(
        pkgDepsRe,
        `${pkgDepsMatch[1]}${existing}${separator}${newDep}\n    ${pkgDepsMatch[3]}`
      );
      this.#logger.info(`[SpmHelper] 已添加包级依赖: .package(path: "${relPath}")`);
      return { changed: true, content: patched };
    }

    this.#logger.warn(`[SpmHelper] 未能找到包级 dependencies 数组，跳过 .package(path:) 插入`);
    return { changed: false, content };
  }

  /**
   * 推断文件所属 target（源自 V1 ModuleResolverV2.determineCurrentModule）
   *
   * 从文件到 Package.swift 所在目录的相对路径中，反向匹配已知 target 名。
   * 如果文件不在任何 SPM target 的源码目录中（如 Xcode 主 App target），返回 null。
   * @param {string} filePath 源文件绝对路径
   * @returns {string|null} target 名称，未匹配返回 null
   */
  resolveCurrentTarget(filePath: any) {
    try {
      const packagePath = this.#parser.findPackageSwift(dirname(filePath));
      if (!packagePath) {
        return null;
      }

      const nodes = this.#graph.getNodes();
      if (nodes.length === 0) {
        return null;
      }

      const packageDir = dirname(packagePath);
      const rel = relative(packageDir, filePath);
      const segments = rel.split(sep);

      // 从路径段反向查找第一个匹配的 target（V1 原始逻辑）
      const nodeSet = new Set(nodes);
      for (let i = segments.length - 1; i >= 0; i--) {
        if (nodeSet.has(segments[i])) {
          return segments[i];
        }
      }

      // 文件不属于任何 SPM target（如 Xcode 主 App target 下的文件）
      // 不做错误的 fallback，返回 null 让调用方跳过依赖检查
      return null;
    } catch {
      return null;
    }
  }
}
