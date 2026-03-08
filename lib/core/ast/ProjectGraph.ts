/**
 * @module ProjectGraph
 * @description 基于 Tree-sitter 的项目结构图 - v3.0 AI-First Bootstrap 核心组件
 *
 * 职责:
 * 1. 扫描项目源码文件 → 调用 AstAnalyzer 解析
 * 2. 构建 类/协议/Category 的查询索引
 * 3. 提供查询 API 供 Analyst Agent 工具调用
 *
 * 生命周期:
 * - 在 Bootstrap Phase 1 一次性构建 (ProjectGraph.build())
 * - 所有维度共享同一个实例
 * - 构建后只读
 */

import fs from 'node:fs';
import path from 'node:path';
import { LanguageService } from '../../shared/LanguageService.js';
import { analyzeFile, isAvailable } from '../AstAnalyzer.js';

// ──────────────────────────────────────────────────────────────────
// 默认配置
// ──────────────────────────────────────────────────────────────────

const DEFAULTS = {
  maxFiles: 500,
  maxFileSizeBytes: 500_000, // 500KB — 跳过超大文件
  excludePatterns: [
    // 通用
    'node_modules/',
    '.build/',
    'build/',
    '.git/',
    'dist/',
    'out/',
    // iOS
    'Pods/',
    'Carthage/',
    'DerivedData/',
    // Python
    '__pycache__/',
    '.venv/',
    'venv/',
    '.tox/',
    '*.egg-info/',
    // JVM
    'target/',
    '.gradle/',
    '.idea/',
    // Test
    '__tests__/',
    'Tests/',
    'test/',
    'tests/',
    // Dart / Flutter
    '.dart_tool/',
    '.fvm/',
    // Misc
    'vendor/',
  ],
  // 从 LanguageService 派生，仅覆盖 AST 解析需要区分 tsx 的场景
  extensionToLang: {
    ...LanguageService.extToLangMap,
    '.tsx': 'tsx', // tree-sitter 需要独立的 tsx 解析器
  },
};

// ──────────────────────────────────────────────────────────────────
// ProjectGraph
// ──────────────────────────────────────────────────────────────────

export default class ProjectGraph {
  /** @type {Map<string, ClassInfo>} */
  #classes = new Map();

  /** @type {Map<string, ProtocolInfo>} */
  #protocols = new Map();

  /** @type {Map<string, CategoryInfo[]>} */
  #categories = new Map();

  /** @type {Map<string, string>} 子类 → 父类 */
  #inheritance = new Map();

  /** @type {Map<string, Set<string>>} 类 → 遵循的协议集合 */
  #conformance = new Map();

  /** @type {Map<string, FileSymbols>} 文件路径 → 文件级符号 */
  #files = new Map();

  /** @type {Map<string, MethodInfo[]>} className → 方法列表 (含 impl 中的方法) */
  #methodsByClass = new Map();

  /** @type {ProjectOverview} 项目统计缓存 */
  #overview: any = null;

  /** @type {string} 项目根目录 */
  #projectRoot: any;

  /** @type {number} 构建耗时 ms */
  #buildTimeMs = 0;

  // ── 静态工厂 ──────────────────────────────────────────────────

  /**
   * 扫描项目并构建 ProjectGraph
   * @param {string} projectRoot 项目根目录
   * @param {object} [options]
   * @param {number} [options.maxFiles=500]
   * @param {string[]} [options.excludePatterns]
   * @param {string[]} [options.extensions] 例如 ['.m', '.h', '.swift']
   * @param {Function} [options.onProgress] (parsed, total) => void
   * @param {number} [options.timeoutMs=30000]
   * @returns {Promise<ProjectGraph>}
   */
  static async build(projectRoot: any, options: any = {}) {
    if (!isAvailable()) {
      throw new Error('Tree-sitter not available — cannot build ProjectGraph');
    }

    const startTime = Date.now();
    const opts = { ...DEFAULTS, ...options };

    // 1. 收集文件列表
    const extToLang = opts.extensionToLang || DEFAULTS.extensionToLang;
    const extensions = options.extensions ? options.extensions : Object.keys(extToLang);

    const files = collectSourceFiles(projectRoot, extensions, opts);

    // 2. 逐文件解析
    const graph = new ProjectGraph();
    graph.#projectRoot = projectRoot;
    let parsed = 0;

    for (const filePath of files) {
      if (opts.timeoutMs && Date.now() - startTime > opts.timeoutMs) {
        break; // 超时 — 返回部分结果
      }

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const ext = path.extname(filePath);
        const lang = extToLang[ext];
        if (!lang) {
          continue;
        }

        const relativePath = path.relative(projectRoot, filePath);
        const summary = analyzeFile(content, lang);
        if (!summary) {
          continue;
        }

        graph.#indexFileSummary(relativePath, summary);
        parsed++;
        opts.onProgress?.(parsed, files.length);
      } catch {
        // 单文件解析失败不阻塞
      }
    }

    // 3. 构建反向索引
    graph.#buildReverseIndices();
    graph.#buildTimeMs = Date.now() - startTime;

    return graph;
  }

  // ── 查询 API ──────────────────────────────────────────────────

  /**
   * 获取类的完整信息
   * @param {string} className
   * @returns {ClassInfo|null}
   */
  getClassInfo(className: any) {
    return this.#classes.get(className) || null;
  }

  /**
   * 获取协议定义 + 所有遵循者
   * @param {string} protocolName
   * @returns {ProtocolInfo|null}
   */
  getProtocolInfo(protocolName: any) {
    return this.#protocols.get(protocolName) || null;
  }

  /**
   * 获取继承链 (向上到根类)
   * @param {string} className
   * @returns {string[]} [className, parent, grandparent, ...]
   */
  getInheritanceChain(className: any) {
    const chain: any[] = [];
    let current = className;
    const visited = new Set();
    while (current && !visited.has(current)) {
      chain.push(current);
      visited.add(current);
      current = this.#inheritance.get(current) || null;
    }
    return chain;
  }

  /**
   * 获取直接子类
   * @param {string} className
   * @returns {string[]}
   */
  getSubclasses(className: any) {
    const subs: any[] = [];
    for (const [child, parent] of this.#inheritance) {
      if (parent === className) {
        subs.push(child);
      }
    }
    return subs;
  }

  /**
   * 递归获取所有后代类
   * @param {string} className
   * @returns {string[]}
   */
  getAllDescendants(className: any) {
    const result: any[] = [];
    const queue = [className];
    const visited = new Set();
    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      const subs = this.getSubclasses(current);
      result.push(...subs);
      queue.push(...subs);
    }
    return result;
  }

  /**
   * 获取类的所有 Category 扩展
   * @param {string} className
   * @returns {CategoryInfo[]}
   */
  getCategoryExtensions(className: any) {
    return this.#categories.get(className) || [];
  }

  /**
   * 查找覆写了指定方法的所有后代类
   * @param {string} className
   * @param {string} methodName 方法名或 selector
   * @returns {OverrideInfo[]}
   */
  getMethodOverrides(className: any, methodName: any) {
    const descendants = this.getAllDescendants(className);
    const overrides: { className: any; method: any; filePath: any }[] = [];

    for (const desc of descendants) {
      const methods = this.#methodsByClass.get(desc) || [];
      const match = methods.find((m: any) => m.name === methodName || m.selector === methodName);
      if (match) {
        overrides.push({
          className: desc,
          method: match,
          filePath: this.#classes.get(desc)?.filePath || 'unknown',
        });
      }
    }

    return overrides;
  }

  /**
   * 获取类的所有方法
   * @param {string} className
   * @returns {MethodInfo[]}
   */
  getClassMethods(className: any) {
    return this.#methodsByClass.get(className) || [];
  }

  /**
   * 获取文件的符号摘要
   * @param {string} relativePath
   * @returns {FileSymbols|null}
   */
  getFileSymbols(relativePath: any) {
    return this.#files.get(relativePath) || null;
  }

  /**
   * 获取所有已解析的文件路径
   * @returns {string[]} 相对路径列表
   */
  getAllFilePaths() {
    return [...this.#files.keys()];
  }

  /**
   * 搜索类名 (模糊匹配)
   * @param {string} query
   * @param {number} [limit=20]
   * @returns {string[]}
   */
  searchClasses(query: any, limit = 20) {
    const lower = query.toLowerCase();
    const results: any[] = [];
    for (const name of this.#classes.keys()) {
      if (name.toLowerCase().includes(lower)) {
        results.push(name);
        if (results.length >= limit) {
          break;
        }
      }
    }
    return results;
  }

  /**
   * 获取项目概览统计
   * @returns {ProjectOverview}
   */
  getOverview() {
    if (this.#overview) {
      return this.#overview;
    }

    // 按模块 (顶层目录) 统计
    const classesPerModule: any = {};
    const topModules = new Set();
    const entryPoints: any[] = [];

    for (const [filePath, symbols] of this.#files) {
      const parts = filePath.split('/');
      const module = parts.length > 1 ? parts[0] : '(root)';
      topModules.add(module);

      if (!classesPerModule[module]) {
        classesPerModule[module] = 0;
      }
      classesPerModule[module] += symbols.classes.length;

      // 入口点检测
      const base = path.basename(filePath);
      if (/^(AppDelegate|main|SceneDelegate)\.(m|swift)$/.test(base)) {
        entryPoints.push(filePath);
      }
    }

    this.#overview = {
      totalFiles: this.#files.size,
      totalClasses: this.#classes.size,
      totalProtocols: this.#protocols.size,
      totalCategories: [...this.#categories.values()].reduce((s, arr) => s + arr.length, 0),
      totalMethods: [...this.#methodsByClass.values()].reduce((s, arr) => s + arr.length, 0),
      topLevelModules: [...topModules].sort(),
      entryPoints,
      classesPerModule,
      buildTimeMs: this.#buildTimeMs,
    };

    return this.#overview;
  }

  /**
   * 获取所有类名
   * @returns {string[]}
   */
  getAllClassNames() {
    return [...this.#classes.keys()];
  }

  /**
   * 获取所有协议名
   * @returns {string[]}
   */
  getAllProtocolNames() {
    return [...this.#protocols.keys()];
  }

  // ── 内部索引构建 ──────────────────────────────────────────────

  /**
   * 索引单个文件的解析结果
   */
  #indexFileSummary(relativePath: any, summary: any) {
    const fileSymbols = {
      path: relativePath,
      lang: summary.lang,
      classes: [] as string[],
      protocols: [] as string[],
      categories: [] as string[],
      imports: summary.imports || [],
    };

    // 索引类
    for (const cls of summary.classes) {
      const classInfo = {
        name: cls.name,
        filePath: relativePath,
        line: cls.line,
        endLine: cls.endLine,
        superClass: cls.superclass || null,
        protocols: cls.protocols || [],
        properties: [] as { name: string; type: string; attributes?: string[]; line?: number }[],
        methods: [] as {
          name: string;
          selector: string;
          line?: number;
          isClassMethod?: boolean;
          returnType?: string;
          paramCount?: number;
          bodyLines?: number;
          complexity?: number;
        }[],
        imports: summary.imports || [],
      };

      // 收集该类的属性
      for (const prop of summary.properties || []) {
        if (prop.className === cls.name) {
          classInfo.properties.push({
            name: prop.name,
            type: prop.type || 'id',
            attributes: prop.attributes || [],
            line: prop.line,
          });
        }
      }

      // 收集该类的方法 (声明 + 定义去重)
      const methodSet = new Set();
      for (const m of summary.methods || []) {
        if (m.className === cls.name) {
          const key = `${m.isClassMethod ? '+' : '-'}${m.name}`;
          if (!methodSet.has(key)) {
            methodSet.add(key);
            classInfo.methods.push({
              name: m.name,
              selector: m.selector || m.name,
              line: m.line,
              isClassMethod: m.isClassMethod || false,
              returnType: m.returnType || 'void',
              paramCount: m.paramCount || 0,
              bodyLines: m.bodyLines || 0,
              complexity: m.complexity || 1,
            });
          }
        }
      }

      this.#classes.set(cls.name, classInfo);

      // 继承关系
      if (cls.superclass) {
        this.#inheritance.set(cls.name, cls.superclass);
      }

      // 协议遵循
      if (cls.protocols && cls.protocols.length > 0) {
        if (!this.#conformance.has(cls.name)) {
          this.#conformance.set(cls.name, new Set());
        }
        for (const p of cls.protocols) {
          this.#conformance.get(cls.name).add(p);
        }
      }

      fileSymbols.classes.push(cls.name);
    }

    // 索引协议
    for (const proto of summary.protocols) {
      const protoInfo = {
        name: proto.name,
        filePath: relativePath,
        line: proto.line,
        inherits: proto.inherits || [],
        requiredMethods: [] as {
          name: string;
          selector: string;
          line?: number;
          isClassMethod?: boolean;
          returnType?: string;
          paramCount?: number;
        }[],
        optionalMethods: [] as {
          name: string;
          selector: string;
          line?: number;
          isClassMethod?: boolean;
          returnType?: string;
          paramCount?: number;
        }[],
        conformers: [] as string[], // 稍后在 buildReverseIndices 中填充
      };

      for (const m of proto.methods || []) {
        const methodInfo = {
          name: m.name,
          selector: m.selector || m.name,
          line: m.line,
          isClassMethod: m.isClassMethod || false,
          returnType: m.returnType || 'void',
          paramCount: m.paramCount || 0,
        };
        if (m.isOptional) {
          protoInfo.optionalMethods.push(methodInfo);
        } else {
          protoInfo.requiredMethods.push(methodInfo);
        }
      }

      this.#protocols.set(proto.name, protoInfo);
      fileSymbols.protocols.push(proto.name);
    }

    // 索引 Category
    for (const cat of summary.categories) {
      const catInfo = {
        className: cat.className || cat.name,
        categoryName: cat.categoryName || 'ext',
        filePath: relativePath,
        line: cat.line,
        methods: (cat.methods || []).map((m: any) => ({
          name: m.name,
          selector: m.selector || m.name,
          line: m.line,
          isClassMethod: m.isClassMethod || false,
          returnType: m.returnType || 'void',
          paramCount: m.paramCount || 0,
        })),
        properties: [] as { name: string; type: string; attributes?: string[]; line?: number }[],
        protocols: cat.protocols || [],
      };

      const key = catInfo.className;
      if (!this.#categories.has(key)) {
        this.#categories.set(key, []);
      }
      this.#categories.get(key).push(catInfo);

      // Category 遵循的协议也记录到类的遵循关系
      if (catInfo.protocols.length > 0) {
        if (!this.#conformance.has(key)) {
          this.#conformance.set(key, new Set());
        }
        for (const p of catInfo.protocols) {
          this.#conformance.get(key).add(p);
        }
      }

      fileSymbols.categories.push(`${catInfo.className}(${catInfo.categoryName})`);
    }

    // 索引方法 (按类名分组)
    for (const m of summary.methods || []) {
      if (!m.className) {
        continue;
      }
      if (!this.#methodsByClass.has(m.className)) {
        this.#methodsByClass.set(m.className, []);
      }
      this.#methodsByClass.get(m.className).push({
        name: m.name,
        selector: m.selector || m.name,
        line: m.line,
        isClassMethod: m.isClassMethod || false,
        returnType: m.returnType || 'void',
        paramCount: m.paramCount || 0,
        bodyLines: m.bodyLines || 0,
        complexity: m.complexity || 1,
        filePath: relativePath,
      });
    }

    this.#files.set(relativePath, fileSymbols);
  }

  /**
   * 构建反向索引 — 协议遵循者列表
   */
  #buildReverseIndices() {
    // 填充 protocol.conformers
    for (const [className, protos] of this.#conformance) {
      for (const protoName of protos) {
        const proto = this.#protocols.get(protoName);
        if (proto && !proto.conformers.includes(className)) {
          proto.conformers.push(className);
        }
      }
    }

    // 补充 classInfo 中的 methods (从 methodsByClass 合并)
    for (const [className, classInfo] of this.#classes) {
      const allMethods = this.#methodsByClass.get(className) || [];
      // 只补充 classInfo.methods 中没有的方法
      const existingNames = new Set(
        classInfo.methods.map((m: any) => `${m.isClassMethod ? '+' : '-'}${m.name}`)
      );
      for (const m of allMethods) {
        const key = `${m.isClassMethod ? '+' : '-'}${m.name}`;
        if (!existingNames.has(key)) {
          classInfo.methods.push(m);
          existingNames.add(key);
        }
      }
    }
  }

  // ── 序列化 / 反序列化 ──────────────────────────────────────

  /**
   * 序列化为可 JSON.stringify 的纯对象
   * @returns {object}
   */
  toJSON() {
    const mapToObj = (map: any) => Object.fromEntries(map);
    const mapOfSetsToObj = (map: any) => {
      const obj: Record<string, any> = {};
      for (const [k, v] of map) {
        obj[k] = [...v];
      }
      return obj;
    };

    return {
      projectRoot: this.#projectRoot,
      buildTimeMs: this.#buildTimeMs,
      classes: mapToObj(this.#classes),
      protocols: mapToObj(this.#protocols),
      categories: mapToObj(this.#categories),
      inheritance: mapToObj(this.#inheritance),
      conformance: mapOfSetsToObj(this.#conformance),
      files: mapToObj(this.#files),
      methodsByClass: mapToObj(this.#methodsByClass),
    };
  }

  /**
   * 从缓存数据恢复 ProjectGraph 实例
   * @param {object} data toJSON() 输出的对象
   * @returns {ProjectGraph}
   */
  static fromJSON(data: any) {
    const graph = new ProjectGraph();
    graph.#projectRoot = data.projectRoot || '';
    graph.#buildTimeMs = data.buildTimeMs || 0;

    // 恢复 classes
    for (const [name, info] of Object.entries(data.classes || {})) {
      graph.#classes.set(name, info);
    }

    // 恢复 protocols
    for (const [name, info] of Object.entries(data.protocols || {})) {
      graph.#protocols.set(name, info);
    }

    // 恢复 categories
    for (const [name, arr] of Object.entries(data.categories || {})) {
      graph.#categories.set(name, arr);
    }

    // 恢复 inheritance
    for (const [child, parent] of Object.entries(data.inheritance || {})) {
      graph.#inheritance.set(child, parent);
    }

    // 恢复 conformance (Set)
    for (const [cls, protos] of Object.entries(data.conformance || {})) {
      graph.#conformance.set(cls, new Set(protos as string[]));
    }

    // 恢复 files
    for (const [path, symbols] of Object.entries(data.files || {})) {
      graph.#files.set(path, symbols);
    }

    // 恢复 methodsByClass
    for (const [cls, methods] of Object.entries(data.methodsByClass || {})) {
      graph.#methodsByClass.set(cls, methods);
    }

    return graph;
  }

  /**
   * 增量更新：仅重新解析变更文件，合并到现有图中
   * @param {string[]} changedPaths 变更文件的绝对路径
   * @param {string[]} deletedPaths 删除文件的相对路径
   * @param {object} [options]
   * @returns {Promise<{ added: number, updated: number, deleted: number }>}
   */
  async incrementalUpdate(changedPaths: any, deletedPaths: any[] = [], options: any = {}) {
    const { analyzeFile, isAvailable } = await import('../AstAnalyzer.js');
    if (!isAvailable()) {
      return { added: 0, updated: 0, deleted: 0 };
    }

    const extToLang = options.extensionToLang || DEFAULTS.extensionToLang;
    let added = 0,
      updated = 0,
      deleted = 0;

    // 1. 删除已移除文件的索引
    for (const relPath of deletedPaths) {
      if (this.#files.has(relPath)) {
        const symbols = this.#files.get(relPath);
        // 清除该文件贡献的类、协议、Category
        for (const cls of symbols.classes || []) {
          this.#classes.delete(cls);
          this.#inheritance.delete(cls);
          this.#conformance.delete(cls);
          this.#methodsByClass.delete(cls);
        }
        for (const proto of symbols.protocols || []) {
          this.#protocols.delete(proto);
        }
        for (const catKey of symbols.categories || []) {
          const className = catKey.split('(')[0];
          this.#categories.delete(className);
        }
        this.#files.delete(relPath);
        deleted++;
      }
    }

    // 2. 重新解析变更文件
    for (const filePath of changedPaths) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const ext = path.extname(filePath);
        const lang = extToLang[ext];
        if (!lang) {
          continue;
        }

        const relativePath = path.relative(this.#projectRoot, filePath);
        const isUpdate = this.#files.has(relativePath);

        // 先清除旧索引（如果是更新）
        if (isUpdate) {
          const oldSymbols = this.#files.get(relativePath);
          for (const cls of oldSymbols.classes || []) {
            this.#classes.delete(cls);
            this.#inheritance.delete(cls);
            this.#conformance.delete(cls);
            this.#methodsByClass.delete(cls);
          }
          for (const proto of oldSymbols.protocols || []) {
            this.#protocols.delete(proto);
          }
          for (const catKey of oldSymbols.categories || []) {
            const className = catKey.split('(')[0];
            this.#categories.delete(className);
          }
        }

        const summary = analyzeFile(content, lang);
        if (!summary) {
          continue;
        }

        this.#indexFileSummary(relativePath, summary);
        isUpdate ? updated++ : added++;
      } catch {
        // 单文件解析失败不阻塞
      }
    }

    // 3. 重建反向索引
    if (added + updated + deleted > 0) {
      this.#buildReverseIndices();
      this.#overview = null; // 清除统计缓存
    }

    return { added, updated, deleted };
  }
}

// ──────────────────────────────────────────────────────────────────
// 工具函数 — 文件收集
// ──────────────────────────────────────────────────────────────────

/**
 * 递归收集匹配扩展名的源文件
 * @param {string} dir
 * @param {string[]} extensions
 * @param {object} opts
 * @returns {string[]}
 */
function collectSourceFiles(dir: any, extensions: any, opts: any) {
  const results: string[] = [];
  const extSet = new Set(extensions);

  function walk(currentDir: any) {
    if (results.length >= opts.maxFiles) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= opts.maxFiles) {
        return;
      }

      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(dir, fullPath);

      // 排除模式检查
      if (opts.excludePatterns.some((p: any) => relativePath.includes(p))) {
        continue;
      }

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!extSet.has(ext)) {
          continue;
        }

        // 跳过过大的文件
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > opts.maxFileSizeBytes) {
            continue;
          }
        } catch {
          continue;
        }

        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}
