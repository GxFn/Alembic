/**
 * @module AstAnalyzer
 * @description 基于 Tree-sitter 的多语言 AST 分析器（插件注册制）
 *
 * 提供结构化代码分析能力：
 * - 类/协议/扩展 声明与继承关系
 * - 属性声明与修饰符
 * - 方法签名（类方法/实例方法）
 * - 设计模式检测（Singleton、Delegate、Factory、Observer）
 * - 代码结构指标（圈复杂度、嵌套深度、方法行数）
 *
 * 支持语言：通过插件注册 — ObjC、Swift、TypeScript、JavaScript、Python、Java、Kotlin、Go、Dart、Rust
 * 插件注册入口: lib/core/ast/index.js
 */

import { getParserClass, isParserReady } from './ast/parser-init.js';

// ──────────────────────────────────────────────────────────────────
// 插件注册表
// ──────────────────────────────────────────────────────────────────

/**
 * @typedef {object} LangPlugin
 * @property {Function} getGrammar  — () => tree-sitter Language Module (lazy load)
 * @property {Function} walk        — (rootNode, ctx) => void  (AST 遍历)
 * @property {Function} [detectPatterns] — (root, lang, methods, properties, classes) => Pattern[]
 * @property {string[]} [extensions] — 关联的文件扩展名
 */

/** @type {Map<string, LangPlugin>} */
const _langPlugins = new Map();

/**
 * 注册语言 AST 插件
 * @param {string} langId — 语言标识 (e.g. 'objectivec', 'swift', 'typescript')
 * @param {LangPlugin} plugin
 */
export function registerLanguage(langId, plugin) {
  _langPlugins.set(langId, plugin);
  // 清除 parser cache 以便下次使用新语法
  _parserCache.delete(langId);
}

// ──────────────────────────────────────────────────────────────────
// 公共 API
// ──────────────────────────────────────────────────────────────────

/**
 * 分析单个源文件，返回结构化 AST 摘要
 * @param {string} source  源代码文本
 * @param {string} lang    语言标识 'objectivec' | 'swift' | 'typescript' | 'javascript' | 'python' | 'java' | 'kotlin' | 'go' | 'dart' | 'rust' | 'tsx'
 * @returns {AstSummary | null}
 */
function analyzeFile(source, lang) {
  const plugin = _langPlugins.get(lang);
  if (!plugin) {
    return null; // 无插件 → 优雅降级
  }

  const parser = _getParser(lang);
  if (!parser) {
    return null;
  }

  const tree = parser.parse(source);
  const root = tree.rootNode;

  const ctx = {
    classes: [],
    protocols: [],
    categories: [],
    methods: [],
    properties: [],
    patterns: [],
    imports: [],
    exports: [],
  };

  plugin.walk(root, ctx);

  // 构建继承图谱
  const inheritanceGraph = _buildInheritanceGraph(ctx.classes, ctx.protocols, ctx.categories);

  // 检测设计模式（优先使用插件自带的检测器，否则使用通用检测器）
  const detectedPatterns = plugin.detectPatterns
    ? plugin.detectPatterns(root, lang, ctx.methods, ctx.properties, ctx.classes)
    : _detectPatterns(root, lang, ctx.methods, ctx.properties, ctx.classes);
  ctx.patterns.push(...detectedPatterns);

  // 结构指标
  const metrics = _computeMetrics(root, lang, ctx.methods);

  return {
    lang,
    classes: ctx.classes,
    protocols: ctx.protocols,
    categories: ctx.categories,
    methods: ctx.methods,
    properties: ctx.properties,
    patterns: ctx.patterns,
    imports: ctx.imports,
    exports: ctx.exports,
    inheritanceGraph,
    metrics,
  };
}

/**
 * 批量分析多文件，返回项目级汇总
 * @param {{ name: string, relativePath: string, content: string }[]} files
 * @param {string} lang
 * @param {{ preprocessFile?: (content: string, ext: string) => { content: string, lang: string } | null }} [options]
 * @returns {ProjectAstSummary}
 */
function analyzeProject(files, lang, options) {
  const fileSummaries = [];
  const allClasses = [];
  const allProtocols = [];
  const allCategories = [];
  const allMethods = [];
  const allPatterns = [];
  const allImports = [];
  const preprocessFile = options?.preprocessFile;

  for (const file of files) {
    let { content } = file;
    let fileLang = lang;

    // SFC 预处理: .vue / .svelte 等文件 → 提取 <script> 块再交给 AST
    if (preprocessFile) {
      const ext = file.name ? `.${file.name.split('.').pop()}` : '';
      const result = preprocessFile(content, ext);
      if (result) {
        content = result.content;
        fileLang = result.lang || lang;
      }
    }

    const summary = analyzeFile(content, fileLang);
    if (!summary) {
      continue;
    }

    fileSummaries.push({ file: file.relativePath, ...summary });
    allClasses.push(...summary.classes.map((c) => ({ ...c, file: file.relativePath })));
    allProtocols.push(...summary.protocols.map((p) => ({ ...p, file: file.relativePath })));
    allCategories.push(...summary.categories.map((c) => ({ ...c, file: file.relativePath })));
    allMethods.push(...summary.methods.map((m) => ({ ...m, file: file.relativePath })));
    allPatterns.push(...summary.patterns.map((p) => ({ ...p, file: file.relativePath })));
    allImports.push(...summary.imports.map((i) => ({ path: i, file: file.relativePath })));
  }

  // 项目级继承图（跨文件合并）
  const inheritanceGraph = _buildInheritanceGraph(allClasses, allProtocols, allCategories);

  // 项目级模式统计
  const patternStats = {};
  for (const p of allPatterns) {
    if (!patternStats[p.type]) {
      patternStats[p.type] = { count: 0, files: [], instances: [] };
    }
    patternStats[p.type].count++;
    if (!patternStats[p.type].files.includes(p.file)) {
      patternStats[p.type].files.push(p.file);
    }
    patternStats[p.type].instances.push(p);
  }

  // 项目级指标聚合
  const projectMetrics = _aggregateMetrics(fileSummaries);

  return {
    lang,
    fileCount: fileSummaries.length,
    classes: allClasses,
    protocols: allProtocols,
    categories: allCategories,
    inheritanceGraph,
    patternStats,
    projectMetrics,
    fileSummaries,
  };
}

/**
 * 为 ChatAgent 生成结构化上下文摘要（Markdown）
 * @param {ProjectAstSummary} projectSummary
 * @returns {string}
 */
function generateContextForAgent(projectSummary) {
  const lines = ['## 项目代码结构分析（AST）', ''];

  // 类型声明概览
  const { classes, protocols, categories, inheritanceGraph, patternStats, projectMetrics } =
    projectSummary;

  lines.push(`### 代码规模`);
  lines.push(`- 已分析文件: ${projectSummary.fileCount}`);
  lines.push(`- 类/结构体: ${classes.length}`);
  lines.push(`- 协议: ${protocols.length}`);
  lines.push(`- Category/Extension: ${categories.length}`);
  lines.push(`- 平均方法数/类: ${projectMetrics.avgMethodsPerClass.toFixed(1)}`);
  lines.push(`- 最大嵌套深度: ${projectMetrics.maxNestingDepth}`);
  lines.push('');

  // 继承关系
  if (inheritanceGraph.length > 0) {
    lines.push(`### 继承关系图`);
    const tree = _renderInheritanceTree(inheritanceGraph);
    lines.push('```');
    lines.push(tree);
    lines.push('```');
    lines.push('');
  }

  // 协议遵循
  const conformances = classes.filter((c) => c.protocols && c.protocols.length > 0);
  if (conformances.length > 0) {
    lines.push(`### 协议遵循`);
    for (const c of conformances.slice(0, 20)) {
      lines.push(`- \`${c.name}\` → ${c.protocols.map((p) => `\`${p}\``).join(', ')}`);
    }
    if (conformances.length > 20) {
      lines.push(`- ... (共 ${conformances.length} 个)`);
    }
    lines.push('');
  }

  // Category
  if (categories.length > 0) {
    lines.push(`### Category / Extension`);
    for (const cat of categories.slice(0, 15)) {
      const methodNames = (cat.methods || [])
        .slice(0, 5)
        .map((m) => m.name)
        .join(', ');
      lines.push(`- \`${cat.className}(${cat.categoryName})\` → ${methodNames || '(无方法)'}`);
    }
    if (categories.length > 15) {
      lines.push(`- ... (共 ${categories.length} 个)`);
    }
    lines.push('');
  }

  // 设计模式
  if (Object.keys(patternStats).length > 0) {
    lines.push(`### 检测到的设计模式`);
    for (const [type, stat] of Object.entries(patternStats)) {
      lines.push(
        `- **${type}**: ${stat.count} 处 (${stat.files.slice(0, 3).join(', ')}${stat.files.length > 3 ? '...' : ''})`
      );
    }
    lines.push('');
  }

  // 代码质量指标
  lines.push(`### 代码质量指标`);
  if (projectMetrics.complexMethods.length > 0) {
    lines.push(`- ⚠️ 高复杂度方法 (cyclomatic > 10):`);
    for (const m of projectMetrics.complexMethods.slice(0, 5)) {
      lines.push(
        `  - \`${m.className || ''}${m.className ? '.' : ''}${m.name}\` (复杂度: ${m.complexity}, ${m.file}:${m.line})`
      );
    }
  }
  if (projectMetrics.longMethods.length > 0) {
    lines.push(`- ⚠️ 过长方法 (> 50 行):`);
    for (const m of projectMetrics.longMethods.slice(0, 5)) {
      lines.push(
        `  - \`${m.className || ''}${m.className ? '.' : ''}${m.name}\` (${m.lines} 行, ${m.file}:${m.line})`
      );
    }
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * 检查 Tree-sitter 是否可用（至少有一个语言插件注册）
 */
function isAvailable() {
  return isParserReady() && _langPlugins.size > 0;
}

/**
 * 获取支持的语言列表
 */
function supportedLanguages() {
  return [..._langPlugins.keys()];
}

// ──────────────────────────────────────────────────────────────────
// 内部实现 — Parser 管理
// ──────────────────────────────────────────────────────────────────

const _parserCache = new Map();

function _getParser(lang) {
  const ParserClass = getParserClass();
  if (!ParserClass) {
    return null;
  }
  if (_parserCache.has(lang)) {
    return _parserCache.get(lang);
  }

  const plugin = _langPlugins.get(lang);
  if (!plugin) {
    return null;
  }

  try {
    const grammar = plugin.getGrammar();
    if (!grammar) {
      return null;
    }
    const parser = new ParserClass();
    parser.setLanguage(grammar);
    _parserCache.set(lang, parser);
    return parser;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────
// 内部实现 — ObjC/Swift Walker 已迁移到 ast/lang-objc.js 和 ast/lang-swift.js
// 通过 ast/index.js 自动注册到 _langPlugins
// ──────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────
// 内部实现 — 设计模式检测（通用回退，插件可提供自己的 detectPatterns）
// ──────────────────────────────────────────────────────────────────

function _detectPatterns(root, lang, methods, properties, classes) {
  const patterns = [];

  // Singleton 检测
  for (const m of methods) {
    if (m.isClassMethod && /^shared|^default|^instance$|^current$/.test(m.name)) {
      patterns.push({
        type: 'singleton',
        className: m.className,
        methodName: m.name,
        line: m.line,
        confidence: 0.9,
      });
    }
  }

  // Delegate 检测（通过属性类型）
  for (const p of properties) {
    if (/delegate/i.test(p.name)) {
      const isWeak = (p.attributes || []).includes('weak');
      patterns.push({
        type: 'delegate',
        className: p.className,
        propertyName: p.name,
        isWeakRef: isWeak,
        line: p.line,
        confidence: 0.95,
      });
    }
  }

  // Factory 检测
  for (const m of methods) {
    if (m.isClassMethod && /^make|^create|^new|^from/.test(m.name) && m.name !== 'new') {
      patterns.push({
        type: 'factory',
        className: m.className,
        methodName: m.name,
        line: m.line,
        confidence: 0.8,
      });
    }
  }

  // Observer/Notification 检测（通过方法名）
  for (const m of methods) {
    if (/^observe|^addObserver|^subscribe/.test(m.name) || /^didChange|^willChange/.test(m.name)) {
      patterns.push({
        type: 'observer',
        className: m.className,
        methodName: m.name,
        line: m.line,
        confidence: 0.7,
      });
    }
  }

  return patterns;
}

// ──────────────────────────────────────────────────────────────────
// 内部实现 — 继承图谱
// ──────────────────────────────────────────────────────────────────

function _buildInheritanceGraph(classes, protocols, categories) {
  const edges = [];

  for (const cls of classes) {
    if (cls.superclass) {
      edges.push({ from: cls.name, to: cls.superclass, type: 'inherits' });
    }
    if (cls.protocols) {
      for (const proto of cls.protocols) {
        edges.push({ from: cls.name, to: proto, type: 'conforms' });
      }
    }
  }

  for (const proto of protocols) {
    if (proto.inherits) {
      for (const parent of proto.inherits) {
        edges.push({ from: proto.name, to: parent, type: 'inherits' });
      }
    }
  }

  for (const cat of categories) {
    edges.push({
      from: `${cat.className}(${cat.categoryName})`,
      to: cat.className,
      type: 'extends',
    });
    if (cat.protocols) {
      for (const proto of cat.protocols) {
        edges.push({ from: cat.className, to: proto, type: 'conforms' });
      }
    }
  }

  return edges;
}

function _renderInheritanceTree(edges) {
  // 找出根节点（只被继承不继承其他的）
  const allTargets = new Set(edges.map((e) => e.to));
  const allSources = new Set(edges.map((e) => e.from));
  const roots = [...allTargets].filter((t) => !allSources.has(t)).slice(0, 5);

  const childMap = {};
  for (const e of edges) {
    if (!childMap[e.to]) {
      childMap[e.to] = [];
    }
    const label = e.type === 'conforms' ? `${e.from} ◇` : e.from;
    if (!childMap[e.to].includes(label)) {
      childMap[e.to].push(label);
    }
  }

  const lines = [];
  function render(name, prefix, isLast) {
    const connector = prefix.length === 0 ? '' : isLast ? '└─ ' : '├─ ';
    lines.push(prefix + connector + name);
    const children = childMap[name] || [];
    for (let i = 0; i < children.length && i < 10; i++) {
      const childPrefix = prefix + (prefix.length === 0 ? '' : isLast ? '   ' : '│  ');
      render(children[i], childPrefix, i === children.length - 1);
    }
  }

  for (const root of roots.slice(0, 5)) {
    render(root, '', true);
  }

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────
// 内部实现 — 代码质量指标
// ──────────────────────────────────────────────────────────────────

function _estimateComplexity(node) {
  let complexity = 1;
  const BRANCH_TYPES = new Set([
    'if_statement',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'switch_statement',
    'case_statement',
    'catch_clause',
    'conditional_expression',
    'ternary_expression',
    'guard_statement',
    // ObjC specific
    'for_in_expression',
  ]);

  function walk(n) {
    if (BRANCH_TYPES.has(n.type)) {
      complexity++;
    }
    // && / || 也增加复杂度
    if (n.type === 'binary_expression') {
      const op = n.children?.find(
        (c) => c.type === '&&' || c.type === '||' || c.text === '&&' || c.text === '||'
      );
      if (op) {
        complexity++;
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      walk(n.namedChild(i));
    }
  }

  walk(node);
  return complexity;
}

function _maxNesting(node, depth) {
  const NESTING_TYPES = new Set([
    'if_statement',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'switch_statement',
    'compound_statement',
  ]);

  let max = depth;
  const nextDepth = NESTING_TYPES.has(node.type) ? depth + 1 : depth;

  for (let i = 0; i < node.namedChildCount; i++) {
    const childMax = _maxNesting(node.namedChild(i), nextDepth);
    if (childMax > max) {
      max = childMax;
    }
  }

  return max;
}

function _computeMetrics(root, lang, methods) {
  const defs = methods.filter((m) => m.kind === 'definition');
  const totalBodyLines = defs.reduce((sum, m) => sum + (m.bodyLines || 0), 0);

  return {
    methodCount: defs.length,
    avgBodyLines: defs.length > 0 ? totalBodyLines / defs.length : 0,
    maxComplexity: defs.length > 0 ? Math.max(...defs.map((m) => m.complexity || 1)) : 0,
    maxNestingDepth: defs.length > 0 ? Math.max(...defs.map((m) => m.nestingDepth || 0)) : 0,
    longMethods: defs.filter((m) => (m.bodyLines || 0) > 50),
    complexMethods: defs.filter((m) => (m.complexity || 1) > 10),
  };
}

function _aggregateMetrics(fileSummaries) {
  const allMethods = fileSummaries.flatMap((f) => f.methods.filter((m) => m.kind === 'definition'));
  const allClasses = fileSummaries.flatMap((f) => f.classes);

  const methodsByClass = {};
  for (const m of allMethods) {
    if (m.className) {
      if (!methodsByClass[m.className]) {
        methodsByClass[m.className] = 0;
      }
      methodsByClass[m.className]++;
    }
  }
  const classCounts = Object.values(methodsByClass);

  return {
    totalMethods: allMethods.length,
    totalClasses: allClasses.length,
    avgMethodsPerClass:
      classCounts.length > 0 ? classCounts.reduce((a, b) => a + b, 0) / classCounts.length : 0,
    maxNestingDepth:
      allMethods.length > 0 ? Math.max(...allMethods.map((m) => m.nestingDepth || 0)) : 0,
    longMethods: allMethods
      .filter((m) => (m.bodyLines || 0) > 50)
      .map((m) => ({
        name: m.name,
        className: m.className,
        lines: m.bodyLines,
        file: m.file,
        line: m.line,
      })),
    complexMethods: allMethods
      .filter((m) => (m.complexity || 1) > 10)
      .map((m) => ({
        name: m.name,
        className: m.className,
        complexity: m.complexity,
        file: m.file,
        line: m.line,
      })),
  };
}

// ──────────────────────────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────────────────────────

function _findIdentifier(node) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (
      child.type === 'identifier' ||
      child.type === 'simple_identifier' ||
      child.type === 'type_identifier'
    ) {
      return child.text;
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────
// Guard AST 查询 API — 供 GuardCheckEngine AST 规则使用
// ──────────────────────────────────────────────────────────────────

/**
 * 在 AST 中搜索特定调用表达式
 * @param {string} source  源代码
 * @param {string} lang    'objectivec' | 'swift'
 * @param {string} targetCallee  目标调用，如 'URLSession.shared', 'dispatch_sync'
 * @returns {Array<{ line: number, snippet: string, enclosingClass: string|null }>}
 */
function findCallExpressions(source, lang, targetCallee) {
  const parser = _getParser(lang);
  if (!parser) {
    return [];
  }

  const tree = parser.parse(source);
  const results = [];
  const lines = source.split(/\r?\n/);

  function walk(node, enclosingClass) {
    // 更新当前所处的类
    let currentClass = enclosingClass;
    if (
      [
        'class_declaration',
        'struct_declaration',
        'class_interface',
        'class_implementation',
      ].includes(node.type)
    ) {
      currentClass = _findIdentifier(node) || enclosingClass;
    }

    // 检查调用表达式
    const isCallLike = [
      'call_expression',
      'message_expression',
      'function_call_expression',
    ].includes(node.type);
    if (isCallLike) {
      const nodeText = node.text || '';
      if (nodeText.includes(targetCallee)) {
        results.push({
          line: node.startPosition.row + 1,
          snippet: lines[node.startPosition.row]?.trim().slice(0, 120) || '',
          enclosingClass: currentClass,
        });
      }
    }

    // 对 Swift，也检查 member_access + call 的组合，如 URLSession.shared.data(...)
    if (node.type === 'navigation_expression' || node.type === 'member_expression') {
      const nodeText = node.text || '';
      if (nodeText.includes(targetCallee)) {
        // 只有当父节点是 call 时才算
        const parent = node.parent;
        if (parent && ['call_expression', 'function_call_expression'].includes(parent.type)) {
          // 已在 call_expression 中处理，跳过避免重复
        } else {
          results.push({
            line: node.startPosition.row + 1,
            snippet: lines[node.startPosition.row]?.trim().slice(0, 120) || '',
            enclosingClass: currentClass,
          });
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i), currentClass);
    }
  }

  walk(tree.rootNode, null);
  return results;
}

/**
 * 搜索特定模式在特定上下文中的出现
 * @param {string} source  源代码
 * @param {string} lang    'objectivec' | 'swift'
 * @param {string} pattern  要查找的文本模式（普通字符串匹配）
 * @param {{ forbiddenContext?: string, requiredContext?: string }} contextFilter
 *   forbiddenContext: 如果在此上下文中出现则报告 (如 'dealloc')
 *   requiredContext: 如果不在此上下文中出现则报告
 * @returns {Array<{ line: number, snippet: string, context: string|null }>}
 */
function findPatternInContext(source, lang, pattern, contextFilter = {}) {
  const parser = _getParser(lang);
  if (!parser) {
    return [];
  }

  const tree = parser.parse(source);
  const results = [];
  const lines = source.split(/\r?\n/);

  function getEnclosingMethodName(node) {
    let current = node.parent;
    while (current) {
      if (
        [
          'method_definition',
          'method_declaration',
          'function_declaration',
          'function_definition',
        ].includes(current.type)
      ) {
        return _findIdentifier(current) || null;
      }
      current = current.parent;
    }
    return null;
  }

  function getEnclosingClassName(node) {
    let current = node.parent;
    while (current) {
      if (
        [
          'class_declaration',
          'struct_declaration',
          'class_interface',
          'class_implementation',
        ].includes(current.type)
      ) {
        return _findIdentifier(current) || null;
      }
      current = current.parent;
    }
    return null;
  }

  function walk(node) {
    const nodeText = node.text || '';
    if (nodeText.includes(pattern) && node.childCount === 0) {
      // 叶节点匹配
      const methodName = getEnclosingMethodName(node);
      const className = getEnclosingClassName(node);

      if (contextFilter.forbiddenContext) {
        // 在禁止上下文中出现 → 报告
        if (
          methodName === contextFilter.forbiddenContext ||
          className === contextFilter.forbiddenContext
        ) {
          results.push({
            line: node.startPosition.row + 1,
            snippet: lines[node.startPosition.row]?.trim().slice(0, 120) || '',
            context: methodName || className,
          });
        }
      } else if (contextFilter.requiredContext) {
        // 不在要求的上下文中 → 报告
        if (
          className !== contextFilter.requiredContext &&
          methodName !== contextFilter.requiredContext
        ) {
          results.push({
            line: node.startPosition.row + 1,
            snippet: lines[node.startPosition.row]?.trim().slice(0, 120) || '',
            context: className || methodName,
          });
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i));
    }
  }

  walk(tree.rootNode);
  return results;
}

/**
 * 检查类是否遵循指定协议
 * @param {string} source  源代码
 * @param {string} lang    'objectivec' | 'swift'
 * @param {string} className  类名
 * @param {string} protocolName  协议名
 * @returns {{ conforms: boolean, classFound: boolean, classDeclLine: number|null }}
 */
function checkProtocolConformance(source, lang, className, protocolName) {
  const summary = analyzeFile(source, lang);
  if (!summary) {
    return { conforms: false, classFound: false, classDeclLine: null };
  }

  // 在 classes 中查找
  const cls = summary.classes.find((c) => c.name === className);
  if (!cls) {
    return { conforms: false, classFound: false, classDeclLine: null };
  }

  // 直接遵循
  if (cls.protocols?.includes(protocolName)) {
    return { conforms: true, classFound: true, classDeclLine: cls.line };
  }

  // 通过 extension/category 遵循
  const catConforms = summary.categories.some(
    (cat) => cat.className === className && cat.protocols?.includes(protocolName)
  );
  if (catConforms) {
    return { conforms: true, classFound: true, classDeclLine: cls.line };
  }

  return { conforms: false, classFound: true, classDeclLine: cls.line };
}

// ──────────────────────────────────────────────────────────────────
// 导出
// ──────────────────────────────────────────────────────────────────

export {
  analyzeFile,
  analyzeProject,
  generateContextForAgent,
  isAvailable,
  supportedLanguages,
  // registerLanguage 已在定义处 inline export，此处不再重复
  // Guard AST 查询 API
  findCallExpressions,
  findPatternInContext,
  checkProtocolConformance,
};
