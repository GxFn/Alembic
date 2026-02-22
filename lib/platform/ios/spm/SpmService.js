/**
 * SpmService — SPM 依赖管理门面服务
 * 整合 PackageSwiftParser + DependencyGraph + PolicyEngine
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  basename as _pathBasename,
  dirname,
  resolve as pathResolve,
  relative,
  sep,
} from 'node:path';
import { GraphCache } from '../../../infrastructure/cache/GraphCache.js';
import Logger from '../../../infrastructure/logging/Logger.js';
import { DependencyGraph } from './DependencyGraph.js';
import { PackageSwiftParser } from './PackageSwiftParser.js';
import { PolicyEngine } from './PolicyEngine.js';

export class SpmService {
  #parser;
  #graph;
  #policy;
  #logger;
  #projectRoot;
  #aiFactory;
  #chatAgent;
  #qualityScorer;
  #recipeExtractor;
  #guardCheckEngine;
  #violationsStore;

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

  /** @type {Map<string, object[]>} target 文件列表缓存 */
  #targetFilesCache;

  constructor(projectRoot, options = {}) {
    this.#projectRoot = projectRoot;
    this.#aiFactory = options.aiFactory || null;
    this.#chatAgent = options.chatAgent || null;
    this.#qualityScorer = options.qualityScorer || null;
    this.#recipeExtractor = options.recipeExtractor || null;
    this.#guardCheckEngine = options.guardCheckEngine || null;
    this.#violationsStore = options.violationsStore || null;
    this.#parser = options.parser || new PackageSwiftParser(projectRoot);
    this.#graph = options.graph || new DependencyGraph();
    this.#policy = options.policy || new PolicyEngine();
    this.#logger = Logger.getInstance();
    this.#targetPackageMap = new Map();
    this.#packageDepGraph = new Map();
    this.#graphCache = new GraphCache(projectRoot);
    this.#targetFilesCache = new Map();
  }

  /**
   * 加载并解析 Package.swift，构建依赖图
   * 支持多 Package 项目
   * 优先从磁盘缓存加载（Package.swift contentHash 匹配即命中）
   */
  async load() {
    this.#targetPackageMap.clear();
    this.#packageDepGraph.clear();
    this.#targetFilesCache.clear();

    // ── 收集所有 Package.swift 路径 + 联合 hash ──
    const packagePath = this.#parser.findPackageSwift(this.#projectRoot);
    const allPaths = packagePath
      ? [packagePath]
      : this.#parser.findAllPackageSwifts(this.#projectRoot);
    if (allPaths.length === 0) {
      this.#logger.warn('[SpmService] Package.swift 未找到');
      return null;
    }

    const combinedHash = allPaths.map((p) => this.#graphCache.computeFileHash(p)).join(':');

    // ── 尝试命中缓存 ──
    const cached = this.#graphCache.load('spm-graph');
    if (cached && cached.contentHash === combinedHash) {
      this.#restoreFromCache(cached.data);
      this.#logger.info(
        `[SpmService] ⚡ 缓存命中 (${this.#graph.getNodes().length} targets, hash=${combinedHash.substring(0, 8)})`
      );
      return cached.data.parsedResult;
    }

    // ── 缓存未命中，走完整解析 ──
    const startTime = Date.now();
    let parsedResult;

    if (packagePath) {
      // 单包模式
      const parsed = this.#parser.parse(packagePath);
      this.#graph.buildFromParsed(parsed);
      for (const t of parsed.targets || []) {
        this.#targetPackageMap.set(t.name, { packageName: parsed.name, packagePath });
      }
      this.#buildPackageDepGraph([{ path: packagePath, parsed }]);
      this.#logger.info(`[SpmService] 加载完成: ${parsed.name} (${parsed.targets.length} targets)`);
      parsedResult = parsed;
    } else {
      // 多包模式
      parsedResult = this.#loadMultiPackage(allPaths);
    }

    // ── 写入缓存 ──
    if (parsedResult) {
      this.#saveToCache(combinedHash, parsedResult);
      this.#logger.info(`[SpmService] 缓存已写入 (${Date.now() - startTime}ms 解析)`);
    }

    return parsedResult;
  }

  /**
   * 多包加载（从 load() 拆出）
   * @param {string[]} allPaths Package.swift 路径数组
   * @returns {object|null}
   */
  #loadMultiPackage(allPaths) {
    this.#logger.info(`[SpmService] 发现 ${allPaths.length} 个 Package.swift，逐一解析...`);
    const mergedTargets = [];
    let lastName = 'multi-package';
    const allParsed = [];

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
      } catch (e) {
        this.#logger.warn(`[SpmService] 解析失败: ${pkgPath} - ${e.message}`);
      }
    }

    this.#buildPackageDepGraph(allParsed);

    this.#logger.info(
      `[SpmService] 多包加载完成: ${mergedTargets.length} targets from ${allPaths.length} packages`
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
  #saveToCache(contentHash, parsedResult) {
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
  #restoreFromCache(data) {
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
  #buildPackageDepGraph(allParsed) {
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

    this.#logger.debug(`[SpmService] 包级依赖图: ${this.#packageDepGraph.size} packages`);
  }

  /**
   * BFS 检查包级可达性（V1 _canReachPackage 等价）
   * @param {string} fromPkgPath - 起始包的 Package.swift 路径
   * @param {string} toPkgPath - 目标包的 Package.swift 路径
   * @returns {boolean}
   */
  _canReachPackage(fromPkgPath, toPkgPath) {
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
  getPackageForTarget(targetName) {
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
   * 获取依赖图
   */
  getGraph() {
    return this.#graph;
  }

  /**
   * 检查 from 是否可达 to
   */
  isReachable(from, to) {
    return this.#graph.isReachable(from, to);
  }

  /**
   * 运行策略检查
   * @param {{ layerOrder?: string[] }} config
   */
  checkPolicies(config = {}) {
    return this.#policy.check(this.#graph, config);
  }

  /**
   * 检查能否添加依赖
   */
  canAddDependency(from, to) {
    return this.#policy.canAddDependency(this.#graph, from, to);
  }

  /**
   * 确保依赖存在: 如果不存在则评估是否可以添加
   * 支持跨包循环检测：如果 from 和 to 在不同包内，额外检查包级依赖图
   * @param {string} from - 源 target
   * @param {string} to - 目标 target
   * @returns {{ exists: boolean, canAdd: boolean, reason?: string, crossPackage?: boolean }}
   */
  ensureDependency(from, to) {
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
   * @param {string} from - 源 target
   * @param {string} to - 目标 target
   * @returns {{ ok: boolean, changed: boolean, file?: string, error?: string, crossPackage?: boolean }}
   */
  addDependency(from, to) {
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
        `[SpmService] 已自动补齐依赖: ${from} -> ${to}${isCrossPackage ? ' (跨包)' : ''} (${packagePath})`
      );
      return { ok: true, changed: true, file: packagePath, crossPackage: isCrossPackage };
    } catch (err) {
      this.#logger.error(`[SpmService] addDependency failed: ${err.message}`);
      return { ok: false, changed: false, error: err.message };
    }
  }

  /**
   * 确保 Package.swift 中有对目标包的 .package(path: "...") 声明
   * @param {string} content - Package.swift 内容
   * @param {string} fromPkgPath - 当前包的 Package.swift 路径
   * @param {{ packageName: string, packagePath: string }} toPkg - 目标包信息
   * @returns {{ changed: boolean, content: string }}
   */
  #ensurePackageDependency(content, fromPkgPath, toPkg) {
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
      this.#logger.info(`[SpmService] 已添加包级依赖: .package(path: "${relPath}")`);
      return { changed: true, content: patched };
    }

    this.#logger.warn(`[SpmService] 未能找到包级 dependencies 数组，跳过 .package(path:) 插入`);
    return { changed: false, content };
  }

  /**
   * 推断文件所属 target（源自 V1 ModuleResolverV2.determineCurrentModule）
   *
   * 从文件到 Package.swift 所在目录的相对路径中，反向匹配已知 target 名。
   * @param {string} filePath - 源文件绝对路径
   * @returns {string|null} target 名称，未匹配返回 null
   */
  resolveCurrentTarget(filePath) {
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

      // 兜底：第一个 target
      return nodes[0] || null;
    } catch {
      return null;
    }
  }

  /**
   * 获取 target 的分层信息
   */
  getLevels() {
    return Object.fromEntries(this.#graph.computeLevels());
  }

  /**
   * 拓扑排序
   */
  getTopologicalOrder() {
    return this.#graph.topologicalSort();
  }

  /**
   * 获取摘要报告
   */
  getSummary() {
    const nodes = this.#graph.getNodes();
    const levels = this.#graph.computeLevels();
    const cycles = this.#graph.detectCycles();

    return {
      nodeCount: nodes.length,
      edgeCount: this.#graph.edgeCount(),
      levels: Object.fromEntries(levels),
      cycleCount: cycles.length,
      cycles: cycles.map((c) => c.join(' → ')),
    };
  }

  // ─────────────── Dashboard API 适配方法 ───────────────

  /**
   * 列出所有 SPM Target（路由: GET /spm/targets）
   * 支持多 Package 项目，返回所有包的所有 targets
   */
  async listTargets() {
    await this.#ensureLoaded();

    // 如果图中有节点，先用图数据
    const nodes = this.#graph.getNodes();
    if (nodes.length > 0) {
      return [...nodes].map((name) => ({
        name,
        type: 'target',
      }));
    }

    // 图为空时，直接扫描所有 Package.swift（兼容多包项目）
    const allPaths = this.#parser.findAllPackageSwifts(this.#projectRoot);

    if (allPaths.length > 0) {
      const { dirname } = await import('node:path');
      const targets = [];
      for (const pkgPath of allPaths) {
        try {
          const parsed = this.#parser.parse(pkgPath);
          if (parsed?.targets) {
            const pkgDir = dirname(pkgPath);
            for (const t of parsed.targets) {
              targets.push({
                name: t.name,
                packageName: parsed.name,
                packagePath: pkgPath,
                targetDir: pkgDir,
                type: t.type || 'target',
                info: t,
              });
            }
          }
        } catch {
          // Skip unparseable packages
        }
      }
      if (targets.length > 0) {
        return targets;
      }
    }

    // 非 SPM 项目 fallback：将常见源码目录作为虚拟 Target
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const fallbackDirs = [
      'Sources',
      'src',
      'lib',
      'app',
      'pages',
      'components',
      'modules',
      'packages',
    ];
    const virtualTargets = [];
    for (const dir of fallbackDirs) {
      if (existsSync(join(this.#projectRoot, dir))) {
        virtualTargets.push({
          name: dir,
          packageName: 'project',
          type: 'directory',
        });
      }
    }
    return virtualTargets;
  }

  /**
   * 获取依赖关系图（路由: GET /spm/dep-graph）
   * @param {{ level?: 'package'|'target' }} options
   */
  async getDependencyGraph(options = {}) {
    await this.#ensureLoaded();
    const json = this.#graph.toJSON();

    return {
      nodes: json.nodes.map((name) => ({
        id: name,
        label: name,
        type: options.level === 'package' ? 'package' : 'target',
      })),
      edges: json.edges.map((e) => ({ from: e.from, to: e.to, source: 'spm' })),
      projectRoot: this.#projectRoot,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 获取 Target 源文件列表（路由: POST /spm/target-files）
   * 支持多 Package 项目：先在 target 所属 package 目录查找
   * 支持非 SPM 项目：虚拟 directory target 直接扫描对应目录
   * 使用内存缓存避免重复 fs walk
   */
  async getTargetFiles(target) {
    const targetName = typeof target === 'string' ? target : target?.name;
    if (!targetName) {
      return [];
    }

    // 内存缓存命中
    if (this.#targetFilesCache.has(targetName)) {
      return this.#targetFilesCache.get(targetName);
    }

    const result = await this.#walkTargetFiles(target, targetName);
    this.#targetFilesCache.set(targetName, result);
    return result;
  }

  /**
   * 实际的文件遍历逻辑（拆出以供缓存用）
   */
  async #walkTargetFiles(target, targetName) {
    const { existsSync, readdirSync, statSync } = await import('node:fs');
    const { join, dirname, extname } = await import('node:path');

    // 判断是否为虚拟目录 target（非 SPM fallback）
    const isDirectoryTarget = typeof target === 'object' && target?.type === 'directory';

    // 收集可能的搜索目录
    const searchDirs = [];

    if (isDirectoryTarget) {
      // 虚拟 target：直接使用 projectRoot/name
      searchDirs.push(join(this.#projectRoot, targetName));
    } else {
      // 1. 如果 target 对象包含 targetDir，使用它
      if (typeof target === 'object' && target?.targetDir) {
        searchDirs.push(join(target.targetDir, 'Sources', targetName));
        searchDirs.push(join(target.targetDir, targetName));
        // 如果有 info.path，也加入
        if (target.info?.path) {
          searchDirs.push(join(target.targetDir, target.info.path));
        }
      }

      // 2. 扫描所有 Package.swift，找到包含这个 target 的 package
      const allPaths = this.#parser.findAllPackageSwifts(this.#projectRoot);
      for (const pkgPath of allPaths) {
        try {
          const parsed = this.#parser.parse(pkgPath);
          if (parsed?.targets?.some((t) => t.name === targetName)) {
            const pkgDir = dirname(pkgPath);
            const matchTarget = parsed.targets.find((t) => t.name === targetName);
            if (matchTarget?.path) {
              searchDirs.push(join(pkgDir, matchTarget.path));
            }
            searchDirs.push(join(pkgDir, 'Sources', targetName));
            searchDirs.push(join(pkgDir, targetName));
          }
        } catch {
          // Skip
        }
      }

      // 3. Fallback: projectRoot/Sources/targetName
      searchDirs.push(join(this.#projectRoot, 'Sources', targetName));
    }

    // 找到第一个存在的目录
    let sourcesDir = null;
    for (const dir of searchDirs) {
      if (existsSync(dir)) {
        sourcesDir = dir;
        break;
      }
    }
    if (!sourcesDir) {
      return [];
    }

    // 文件扩展名白名单
    const CODE_EXTS = isDirectoryTarget
      ? new Set([
          '.swift',
          '.m',
          '.mm',
          '.h',
          '.c',
          '.cpp',
          '.js',
          '.ts',
          '.tsx',
          '.jsx',
          '.py',
          '.java',
          '.kt',
          '.go',
          '.rs',
          '.rb',
          '.vue',
          '.mjs',
          '.cjs',
        ])
      : new Set(['.swift', '.m', '.h', '.c', '.cpp', '.mm']);
    const SKIP_DIRS = new Set([
      'node_modules',
      '.git',
      'dist',
      'build',
      '.next',
      'Pods',
      'Carthage',
      '.build',
      'DerivedData',
      'vendor',
      '__pycache__',
      '.venv',
      'target',
    ]);
    const MAX_FILES = 300;

    const files = [];
    const walk = (dir, rel = '') => {
      if (files.length >= MAX_FILES) {
        return;
      }
      let entries;
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= MAX_FILES) {
          break;
        }
        if (entry.startsWith('.')) {
          continue;
        }
        const full = join(dir, entry);
        const relPath = rel ? `${rel}/${entry}` : entry;
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (SKIP_DIRS.has(entry)) {
            continue;
          }
          walk(full, relPath);
        } else if (CODE_EXTS.has(extname(entry).toLowerCase())) {
          if (st.size > 512 * 1024) {
            continue; // 跳过 > 512KB
          }
          files.push({ name: entry, path: full, relativePath: relPath, size: st.size });
        }
      }
    };
    walk(sourcesDir);
    return files;
  }

  /**
   * 共用增强管线：补充 extract_recipes handler 未覆盖的增量增强。
   * extract_recipes handler 已负责：normalizeSemanticFields + RecipeExtractor + QualityScorer + V3 结构化。
   * 此方法仅做以下增量处理：
   *   - 确保 normalizeSemanticFields 已执行（幂等，防止非 ChatAgent 路径跳过）
   *   - 若 handler 未注入质量评分，由 SpmService 补充
   */
  _enrichRecipes(recipes) {
    for (const recipe of recipes) {
      // QualityScorer 评分（程序化，仅在未评分时补充）
      if (!recipe.quality && this.#qualityScorer) {
        try {
          const scoreResult = this.#qualityScorer.score(recipe);
          recipe.quality = {
            completeness: 0,
            adaptation: 0,
            documentation: 0,
            overall: scoreResult.score ?? 0,
            grade: scoreResult.grade || '',
          };
        } catch (e) {
          this.#logger.debug(`[SpmService] QualityScorer failed: ${e.message}`);
        }
      }
    }
  }

  /**
   * AI 扫描 Target 发现候选项（路由: POST /spm/scan）
   * 完整管线: 读文件 → AI 提取 → Header 解析 → 工具增强(语义标签/质量评分)
   */
  async scanTarget(target, options = {}) {
    const targetName = typeof target === 'string' ? target : target?.name;
    /** @type {((event: {type: string, [key:string]: any}) => void) | undefined} */
    const onProgress = options.onProgress;

    // 1. 获取源文件列表
    onProgress?.({ type: 'scan:started', targetName });
    const fileList = await this.getTargetFiles(target);
    if (!fileList || fileList.length === 0) {
      return {
        recipes: [],
        scannedFiles: [],
        message: `No source files found for target: ${targetName}`,
      };
    }

    const scannedFilesMeta = fileList.map((f) => {
      const filePath = typeof f === 'string' ? f : f.path;
      return { name: _pathBasename(filePath), path: f.relativePath || _pathBasename(filePath) };
    });
    onProgress?.({ type: 'scan:files-loaded', files: scannedFilesMeta, count: fileList.length });

    // 2. 读取文件内容
    onProgress?.({ type: 'scan:reading', count: fileList.length });
    const { readFileSync } = await import('node:fs');
    const { basename } = await import('node:path');
    const files = fileList
      .map((f) => {
        const filePath = typeof f === 'string' ? f : f.path;
        try {
          return {
            name: basename(filePath),
            path: filePath,
            relativePath: f.relativePath || basename(filePath),
            content: readFileSync(filePath, 'utf8'),
          };
        } catch (err) {
          this.#logger.warn(`[SpmService] 读取文件失败: ${filePath} — ${err.message}`);
          return null;
        }
      })
      .filter(Boolean);

    if (files.length === 0) {
      return { recipes: [], scannedFiles: [], message: 'All source files unreadable' };
    }

    const scannedFiles = files.map((f) => ({ name: f.name, path: f.relativePath }));
    this.#logger.info(`[SpmService] scanTarget: ${targetName}, ${files.length} files`);

    // 3. AI 提取 Recipes（通过 ChatAgent 统一入口）
    if (!this.#chatAgent && !this.#aiFactory) {
      return {
        recipes: [],
        scannedFiles,
        message: 'AI provider not configured. Please set ASD_AI_PROVIDER.',
      };
    }

    onProgress?.({ type: 'scan:ai-extracting', fileCount: files.length, targetName });
    const AI_EXTRACT_TIMEOUT = 120_000; // 2 分钟 AI 提取超时
    let recipes;
    try {
      if (this.#chatAgent) {
        const extractPromise = this.#chatAgent.executeTool('extract_recipes', {
          targetName,
          files,
        });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`AI extraction timeout (${AI_EXTRACT_TIMEOUT / 1000}s)`)),
            AI_EXTRACT_TIMEOUT
          )
        );
        const result = await Promise.race([extractPromise, timeoutPromise]);
        if (result?.error) {
          return { recipes: [], scannedFiles, message: result.error };
        }
        recipes = result?.recipes || [];
      } else {
        // 降级: 直接使用 aiFactory（兼容未注入 chatAgent 的场景）
        const {
          getProviderWithFallback,
          isGeoOrProviderError,
          getAvailableFallbacks,
          createProvider,
        } = this.#aiFactory;
        let ai = await getProviderWithFallback();
        if (!ai) {
          return { recipes: [], scannedFiles, message: 'AI provider not available' };
        }

        // 加载语言参考 Skill 注入 AI 提取 prompt
        let extractOpts = {};
        try {
          const { loadBootstrapSkills } = await import(
            '../../../external/mcp/handlers/bootstrap.js'
          );
          const langProfile = ai._detectLanguageProfile?.(files);
          const primaryLang = langProfile?.primaryLanguage;
          if (primaryLang) {
            const skillCtx = loadBootstrapSkills(primaryLang);
            if (skillCtx.languageSkill) {
              extractOpts = { skillReference: skillCtx.languageSkill.substring(0, 2000) };
            }
          }
        } catch {
          /* Skills not available */
        }

        try {
          recipes = await ai.extractRecipes(targetName, files, extractOpts);
        } catch (primaryErr) {
          if (isGeoOrProviderError(primaryErr)) {
            const currentProvider = (process.env.ASD_AI_PROVIDER || 'google').toLowerCase();
            const fallbacks = getAvailableFallbacks(currentProvider);
            let fallbackOk = false;
            for (const fbName of fallbacks) {
              try {
                ai = createProvider({ provider: fbName });
                recipes = await ai.extractRecipes(targetName, files, extractOpts);
                fallbackOk = true;
                break;
              } catch (fbErr) {
                this.#logger.warn(`[SpmService] fallback "${fbName}" failed: ${fbErr.message}`);
              }
            }
            if (!fallbackOk) {
              throw primaryErr;
            }
          } else {
            throw primaryErr;
          }
        }
      }
    } catch (err) {
      this.#logger.warn(`[SpmService] scanTarget AI extraction failed: ${err.message}`);
      return { recipes: [], scannedFiles, message: `AI extraction failed: ${err.message}` };
    }

    if (!Array.isArray(recipes)) {
      recipes = [];
    }

    // 3.5 Header 路径解析 + moduleName 注入
    try {
      const PathFinder = await import('../../../infrastructure/paths/PathFinder.js');
      const HeaderResolver = await import('../../../infrastructure/paths/HeaderResolver.js');
      const targetRootDir = await PathFinder.findTargetRootDir(files[0].path);
      for (const recipe of recipes) {
        const headerList = recipe.headers || [];
        recipe.headerPaths = await Promise.all(
          headerList.map((h) => HeaderResolver.resolveHeaderRelativePath(h, targetRootDir))
        );
        recipe.moduleName = targetName;
      }
    } catch (err) {
      this.#logger.warn(`[SpmService] Header resolution failed: ${err.message}`);
    }

    // 4. 工具增强：语义标准化 + 标签 + 评分
    onProgress?.({ type: 'scan:enriching', recipeCount: recipes.length });
    this._enrichRecipes(recipes);

    const result = { recipes, scannedFiles };
    if (recipes.length === 0) {
      const aiInfo = this.#aiFactory
        ? (await import('../../../external/ai/AiFactory.js')).getAiConfigInfo()
        : null;
      if (aiInfo && !aiInfo.hasKey) {
        result.noAi = true;
        result.message = 'AI 未配置，已跳过智能提取。请在 .env 中设置 API Key 后重试。';
      } else {
        result.message = `AI 提取完成，但未发现可复用的代码模式（${targetName}, ${files.length} 个文件）`;
      }
    }
    onProgress?.({
      type: 'scan:completed',
      recipeCount: recipes.length,
      fileCount: scannedFiles.length,
    });
    return result;
  }

  /**
   * 全项目扫描 — 遍历所有 Target，AI 提取候选 + Guard 审计
   * 返回: { targets: [...], recipes: [], guardAudit: { files, summary }, scannedFiles: [] }
   */
  async scanProject(options = {}) {
    this.#logger.info('[SpmService] scanProject: starting full-project scan');

    const { readFileSync, existsSync, readdirSync, statSync } = await import('node:fs');
    const { basename: bn, join, extname, relative } = await import('node:path');

    // 1. 列出所有 target
    const allTargets = await this.listTargets();

    // 2. 收集所有源文件（去重）
    const seenPaths = new Set();
    const allFiles = []; // { name, path, relativePath, content, targetName }
    const MAX_FILES = options.maxFiles || 200;

    if (allTargets && allTargets.length > 0) {
      // SPM 项目：从 Target 中收集
      for (const t of allTargets) {
        try {
          const fileList = await this.getTargetFiles(t);
          for (const f of fileList) {
            const fp = typeof f === 'string' ? f : f.path;
            if (seenPaths.has(fp)) {
              continue;
            }
            seenPaths.add(fp);
            try {
              const content = readFileSync(fp, 'utf8');
              allFiles.push({
                name: bn(fp),
                path: fp,
                relativePath: f.relativePath || bn(fp),
                content,
                targetName: t.name,
              });
            } catch {
              /* unreadable */
            }
            if (allFiles.length >= MAX_FILES) {
              break;
            }
          }
        } catch (e) {
          this.#logger.warn(`[SpmService] scanProject: skipping target ${t.name}: ${e.message}`);
        }
        if (allFiles.length >= MAX_FILES) {
          break;
        }
      }
    } else {
      // 非 SPM 项目：直接扫描常见源码目录（fallback）
      this.#logger.info('[SpmService] scanProject: No SPM targets, falling back to directory scan');
      const CODE_EXTS = new Set([
        '.swift',
        '.m',
        '.mm',
        '.h',
        '.js',
        '.ts',
        '.tsx',
        '.jsx',
        '.py',
        '.java',
        '.kt',
        '.go',
        '.rs',
        '.rb',
        '.vue',
        '.mjs',
        '.cjs',
      ]);
      const SKIP_DIRS = new Set([
        'node_modules',
        '.git',
        'dist',
        'build',
        '.next',
        'Pods',
        'Carthage',
        '.build',
        'DerivedData',
        'vendor',
        '__pycache__',
        '.venv',
        'target',
      ]);
      const srcDirs = [
        'Sources',
        'src',
        'lib',
        'app',
        'pages',
        'components',
        'modules',
        'packages',
      ];

      const walkDir = (dir, targetName) => {
        if (allFiles.length >= MAX_FILES) {
          return;
        }
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of entries) {
          if (allFiles.length >= MAX_FILES) {
            break;
          }
          if (ent.name.startsWith('.')) {
            continue;
          }
          const fp = join(dir, ent.name);
          if (ent.isDirectory()) {
            if (SKIP_DIRS.has(ent.name)) {
              continue;
            }
            walkDir(fp, targetName);
          } else if (ent.isFile() && CODE_EXTS.has(extname(ent.name).toLowerCase())) {
            if (seenPaths.has(fp)) {
              continue;
            }
            seenPaths.add(fp);
            try {
              const st = statSync(fp);
              if (st.size > 512 * 1024) {
                continue; // 跳过 > 512KB
              }
              const content = readFileSync(fp, 'utf8');
              if (content.split('\n').length < 5) {
                continue; // 跳过微小文件
              }
              allFiles.push({
                name: ent.name,
                path: fp,
                relativePath: relative(this.#projectRoot, fp),
                content,
                targetName,
              });
            } catch {
              /* unreadable */
            }
          }
        }
      };

      for (const dir of srcDirs) {
        const dirPath = join(this.#projectRoot, dir);
        if (existsSync(dirPath)) {
          walkDir(dirPath, dir);
        }
      }

      // 如果常见目录都为空，扫描根目录（浅层）
      if (allFiles.length === 0) {
        walkDir(this.#projectRoot, 'root');
      }
    }

    this.#logger.info(
      `[SpmService] scanProject: ${allFiles.length} unique files from ${allTargets?.length || 0} targets`
    );

    if (allFiles.length === 0) {
      return {
        targets: (allTargets || []).map((t) => t.name),
        recipes: [],
        guardAudit: null,
        scannedFiles: [],
        message: 'No readable source files',
      };
    }

    const scannedFiles = allFiles.map((f) => ({
      name: f.name,
      path: f.relativePath,
      targetName: f.targetName,
    }));

    // 3. AI 提取 Recipes（全局批量，分批避免 token 超限）— 通过 ChatAgent 统一入口
    const allRecipes = [];
    const PER_BATCH_TIMEOUT = options.batchTimeout || 90000; // 每批最多 90 秒
    const startTime = Date.now();
    const TOTAL_TIMEOUT = options.totalTimeout || 540000; // 总超时 9 分钟（留 1 分钟给 Guard）
    let timedOut = false;

    if (this.#chatAgent || this.#aiFactory) {
      const BATCH_SIZE = options.batchSize || 20;

      if (this.#chatAgent) {
        // 通过 ChatAgent extract_recipes 工具（内置 fallback）
        for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
          if (Date.now() - startTime > TOTAL_TIMEOUT) {
            this.#logger.warn(
              `[SpmService] scanProject: total timeout reached after ${Math.floor((Date.now() - startTime) / 1000)}s, returning partial results`
            );
            timedOut = true;
            break;
          }
          const batch = allFiles.slice(i, i + BATCH_SIZE);
          const batchLabel = `project-batch-${Math.floor(i / BATCH_SIZE) + 1}`;
          try {
            const result = await Promise.race([
              this.#chatAgent.executeTool('extract_recipes', {
                targetName: batchLabel,
                files: batch,
              }),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('batch timeout')), PER_BATCH_TIMEOUT)
              ),
            ]);
            if (Array.isArray(result?.recipes)) {
              allRecipes.push(...result.recipes);
            }
          } catch (err) {
            this.#logger.warn(
              `[SpmService] scanProject ChatAgent batch ${batchLabel} failed: ${err.message}`
            );
          }
        }
      } else {
        // 降级: 直接使用 aiFactory（兼容未注入 chatAgent 的场景）
        const {
          getProviderWithFallback,
          isGeoOrProviderError,
          getAvailableFallbacks,
          createProvider,
        } = this.#aiFactory;
        let ai = await getProviderWithFallback();

        if (ai) {
          for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
            if (Date.now() - startTime > TOTAL_TIMEOUT) {
              this.#logger.warn(
                `[SpmService] scanProject: total timeout reached, returning partial results`
              );
              timedOut = true;
              break;
            }
            const batch = allFiles.slice(i, i + BATCH_SIZE);
            const batchLabel = `project-batch-${Math.floor(i / BATCH_SIZE) + 1}`;
            try {
              const recipes = await Promise.race([
                ai.extractRecipes(batchLabel, batch),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('batch timeout')), PER_BATCH_TIMEOUT)
                ),
              ]);
              if (Array.isArray(recipes)) {
                allRecipes.push(...recipes);
              }
            } catch (err) {
              if (isGeoOrProviderError(err)) {
                const fallbacks = getAvailableFallbacks(
                  (process.env.ASD_AI_PROVIDER || 'google').toLowerCase()
                );
                for (const fb of fallbacks) {
                  try {
                    ai = createProvider({ provider: fb });
                    const recipes = await ai.extractRecipes(batchLabel, batch);
                    if (Array.isArray(recipes)) {
                      allRecipes.push(...recipes);
                    }
                    break;
                  } catch {
                    /* next fallback */
                  }
                }
              } else {
                this.#logger.warn(
                  `[SpmService] scanProject AI batch ${batchLabel} failed: ${err.message}`
                );
              }
            }
          }
        }
      }

      // 工具增强：语义标准化 + 标签 + 评分
      this._enrichRecipes(allRecipes);
    }

    // 4. Guard 审计 — 对所有文件运行 GuardCheckEngine
    let guardAudit = null;
    if (this.#guardCheckEngine) {
      try {
        const guardFiles = allFiles.map((f) => ({ path: f.path, content: f.content }));
        guardAudit = this.#guardCheckEngine.auditFiles(guardFiles, { scope: 'project' });

        // 将有违反的文件写入 ViolationsStore
        if (this.#violationsStore && guardAudit.files) {
          for (const fileResult of guardAudit.files) {
            if (fileResult.violations.length > 0) {
              this.#violationsStore.appendRun({
                filePath: fileResult.filePath,
                violations: fileResult.violations,
                summary: `Project scan: ${fileResult.summary.errors} errors, ${fileResult.summary.warnings} warnings`,
              });
            }
          }
        }
      } catch (e) {
        this.#logger.warn(`[SpmService] Guard audit failed: ${e.message}`);
      }
    }

    this.#logger.info(
      `[SpmService] scanProject complete: ${allRecipes.length} recipes, ${guardAudit?.summary?.totalViolations || 0} violations${timedOut ? ' (partial — timed out)' : ''}`
    );

    return {
      targets: allTargets.map((t) => t.name),
      recipes: allRecipes,
      guardAudit,
      scannedFiles,
      partial: timedOut,
    };
  }

  /**
   * 标准化 AI 提取结果中的语义字段
   * - preconditions (flat array) → constraints.preconditions
   * - steps (string[]) → [{title, description}] 结构化格式
   * - 确保 rationale / knowledgeType / complexity / scope 就位
   */
  static normalizeSemanticFields(recipe) {
    // V3: AI 已输出完整结构，不再填充默认值
    return recipe;
  }

  /**
   * 确保已加载 Package.swift（惰性加载）
   */
  async #ensureLoaded() {
    if (this.#graph.getNodes().length === 0) {
      try {
        await this.load();
      } catch (e) {
        this.#logger.warn(`[SpmService] 自动加载失败: ${e.message}`);
      }
    }
  }

  /**
   * 刷新依赖映射（路由: POST /commands/spm-map）
   * 会主动使缓存失效并重新解析
   */
  async updateDependencyMap(options = {}) {
    this.#graphCache.invalidate('spm-graph');
    this.#targetFilesCache.clear();
    this.#graph.clear();
    const parsed = await this.load();
    if (!parsed) {
      return { success: false, message: 'Package.swift not found', targets: 0, edges: 0 };
    }
    const json = this.#graph.toJSON();
    return {
      success: true,
      message: `Dependency map updated for ${parsed.name}`,
      targets: json.nodes.length,
      edges: json.edges.length,
      projectRoot: this.#projectRoot,
    };
  }
}
