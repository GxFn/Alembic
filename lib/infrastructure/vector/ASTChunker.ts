/**
 * ASTChunker — 基于 AST 的语法感知代码分块
 *
 * 利用 web-tree-sitter 按函数/类/方法边界分块:
 * - 保持语义完整性 (不在函数/类中间截断)
 * - 超大节点递归拆分
 * - 自动携带结构元数据 (nodeType, name, startLine, endLine)
 *
 * 支持语言: JavaScript, TypeScript, Python, Java, Kotlin, Go, Swift,
 *           Rust, Dart, ObjC (取决于已加载的 tree-sitter grammar)
 *
 * @module infrastructure/vector/ASTChunker
 */

import { estimateTokens } from '../../shared/token-utils.js';

/** Minimal AST node shape from tree-sitter */
interface ASTNode {
  type: string;
  text?: string;
  childCount: number;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  child: (index: number) => ASTNode | null;
  childForFieldName?: (name: string) => ASTNode | null;
}

// AST 相关的延迟加载 (避免 import 时强制初始化 parser)
let _astReady = false;
let _parseToTree: ((content: string, langId: string) => { rootNode: ASTNode } | null) | null = null;
let _isAvailable: (() => boolean) | null = null;
let _supportedLanguages: (() => string[]) | null = null;

/**
 * 各语言的顶层可分块 AST 节点类型
 * 这些节点通常代表独立的代码单元 (函数/类/方法/接口等)
 */
const TOP_LEVEL_TYPES = new Set([
  // JavaScript / TypeScript
  'function_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'export_statement',
  'lexical_declaration',
  'variable_declaration',
  // Python
  'function_definition',
  'class_definition',
  'decorated_definition',
  // Java
  'method_declaration',
  'constructor_declaration',
  'field_declaration',
  'class_body_declaration',
  // Kotlin
  'function_declaration',
  'object_declaration',
  'property_declaration',
  // Go
  'function_declaration',
  'method_declaration',
  'type_declaration',
  'const_declaration',
  'var_declaration',
  // Swift
  'function_declaration',
  'class_declaration',
  'struct_declaration',
  'protocol_declaration',
  'extension_declaration',
  // Rust
  'function_item',
  'struct_item',
  'enum_item',
  'trait_item',
  'impl_item',
  'type_item',
  'mod_item',
  'const_item',
  'static_item',
  'macro_definition',
  // Dart
  'function_definition',
  'class_definition',
  'mixin_declaration',
  'extension_declaration',
  'top_level_definition',
  // ObjC
  'class_implementation',
  'category_implementation',
  'protocol_declaration',
]);

/**
 * 语言 ID → tree-sitter langId 映射
 * LanguageService.inferLang() 返回的 id 可能不完全匹配 AST 插件注册的 langId
 */
const LANG_ID_MAP = {
  javascript: 'javascript',
  typescript: 'typescript',
  tsx: 'tsx',
  python: 'python',
  java: 'java',
  kotlin: 'kotlin',
  go: 'go',
  swift: 'swift',
  rust: 'rust',
  dart: 'dart',
  objectivec: 'objectivec',
  'objective-c': 'objectivec',
  objc: 'objectivec',
};

/**
 * 初始化 AST 解析器 (幂等, 延迟加载)
 * @returns 是否成功初始化
 */
async function ensureParser() {
  if (_astReady) {
    return true;
  }

  try {
    // 触发 AST 插件的顶层 await loadPlugins()
    await import('../../core/ast/index.js');
    const astAnalyzer = await import('../../core/AstAnalyzer.js');
    _parseToTree = astAnalyzer.parseToTree;
    _isAvailable = astAnalyzer.isAvailable;
    _supportedLanguages = astAnalyzer.supportedLanguages;
    _astReady = _isAvailable?.() ?? false;
    return _astReady;
  } catch {
    return false;
  }
}

/**
 * 检查 ASTChunker 是否支持指定语言
 * @param language LanguageService.inferLang() 返回的语言 ID
 */
export function isASTChunkerAvailable(language: string) {
  if (!_astReady || !_supportedLanguages) {
    return false;
  }
  const langId = (LANG_ID_MAP as Record<string, any>)[language] || language;
  const supported = _supportedLanguages();
  return supported.includes(langId);
}

/**
 * 按 AST 节点边界分块
 *
 * 策略:
 * 1. 解析源代码为 AST
 * 2. 提取根节点的直接子节点中的顶层声明 (函数/类/方法/接口等)
 * 3. 小于 maxChunkTokens 的节点作为单独 chunk
 * 4. 超大节点递归拆分 (按子节点边界)
 * 5. 非声明代码 (import, 注释等) 合并为一个 chunk
 *
 * @param content 源代码
 * @param language 语言标识 (来自 LanguageService.inferLang)
 * @param metadata 基础 metadata
 * @returns >}
 */
export function chunkByAST(
  content: string,
  language: string,
  metadata: Record<string, unknown> = {},
  options: { maxChunkTokens?: number } = {}
) {
  const { maxChunkTokens = 512 } = options;

  if (!content || content.trim().length === 0) {
    return [];
  }

  const langId = (LANG_ID_MAP as Record<string, string>)[language] || language;
  if (!_astReady || !_parseToTree) {
    return null; // 返回 null 表示不支持, 调用方应 fallback
  }

  const parsed = _parseToTree(content, langId);
  if (!parsed?.rootNode) {
    return null;
  }

  const rootNode = parsed.rootNode;
  const chunks: Array<{ content: string; metadata: Record<string, unknown> }> = [];
  let preambleLines: string[] = []; // 非声明代码 (imports, comments 等)

  // 遍历根节点的直接子节点
  for (let i = 0; i < rootNode.childCount; i++) {
    const child = rootNode.child(i);
    if (!child) {
      continue;
    }

    const nodeText = content.slice(child.startIndex, child.endIndex);
    const nodeTokens = estimateTokens(nodeText);
    const isTopLevel = TOP_LEVEL_TYPES.has(child.type);

    if (!isTopLevel) {
      // 非顶层声明 → 积累到 preamble
      preambleLines.push(nodeText);
      continue;
    }

    // 先 flush preamble
    if (preambleLines.length > 0) {
      const preamble = preambleLines.join('\n');
      if (preamble.trim().length > 0) {
        chunks.push({
          content: preamble,
          metadata: {
            ...metadata,
            nodeType: 'preamble',
            startLine: chunks.length === 0 ? 1 : undefined,
          },
        });
      }
      preambleLines = [];
    }

    if (nodeTokens <= maxChunkTokens) {
      // 单个 chunk
      chunks.push({
        content: nodeText,
        metadata: {
          ...metadata,
          nodeType: child.type,
          name: extractNodeName(child),
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        },
      });
    } else {
      // 超大节点: 递归拆分
      const subChunks = splitLargeNode(child, content, metadata, maxChunkTokens);
      chunks.push(...subChunks);
    }
  }

  // flush 剩余 preamble
  if (preambleLines.length > 0) {
    const preamble = preambleLines.join('\n');
    if (preamble.trim().length > 0) {
      chunks.push({
        content: preamble,
        metadata: { ...metadata, nodeType: 'epilogue' },
      });
    }
  }

  // 如果 AST 没有产生任何 chunk (例如空文件), 返回 null 让 fallback 处理
  if (chunks.length === 0) {
    return null;
  }

  // 设置 chunkIndex 和 totalChunks
  for (let i = 0; i < chunks.length; i++) {
    chunks[i].metadata.chunkIndex = i;
    chunks[i].metadata.totalChunks = chunks.length;
    chunks[i].metadata.chunkStrategy = 'ast';
  }

  return chunks;
}

/**
 * 递归拆分超大 AST 节点
 *
 * 策略: 按子节点边界分组, 直到每组 ≤ maxChunkTokens
 *
 * @param node tree-sitter AST node
 * @param source 完整源代码
 * @returns >}
 */
function splitLargeNode(
  node: ASTNode,
  source: string,
  metadata: Record<string, unknown>,
  maxChunkTokens: number
) {
  const chunks: Array<{ content: string; metadata: Record<string, unknown> }> = [];
  const parentName = extractNodeName(node);

  // 如果没有子节点, 按行切割
  if (node.childCount === 0) {
    return splitByLines(
      source.slice(node.startIndex, node.endIndex),
      metadata,
      node,
      parentName,
      maxChunkTokens
    );
  }

  // 按子节点分组, 累积到 maxChunkTokens
  let currentLines: string[] = [];
  let currentTokens = 0;
  let groupStartLine = node.startPosition.row + 1;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) {
      continue;
    }

    const childText = source.slice(child.startIndex, child.endIndex);
    const childTokens = estimateTokens(childText);

    // 如果单个子节点就超大, 递归拆分
    if (childTokens > maxChunkTokens && child.childCount > 0) {
      // 先 flush 当前积累
      if (currentLines.length > 0) {
        chunks.push({
          content: currentLines.join('\n'),
          metadata: {
            ...metadata,
            nodeType: node.type,
            name: parentName,
            startLine: groupStartLine,
            endLine: child.startPosition.row,
            splitPart: true,
          },
        });
        currentLines = [];
        currentTokens = 0;
      }
      // 递归
      chunks.push(...splitLargeNode(child, source, metadata, maxChunkTokens));
      groupStartLine = child.endPosition.row + 2;
      continue;
    }

    // 如果加入后超限, 先 flush
    if (currentTokens + childTokens > maxChunkTokens && currentLines.length > 0) {
      chunks.push({
        content: currentLines.join('\n'),
        metadata: {
          ...metadata,
          nodeType: node.type,
          name: parentName,
          startLine: groupStartLine,
          endLine: child.startPosition.row,
          splitPart: true,
        },
      });
      currentLines = [];
      currentTokens = 0;
      groupStartLine = child.startPosition.row + 1;
    }

    currentLines.push(childText);
    currentTokens += childTokens;
  }

  // flush 剩余
  if (currentLines.length > 0) {
    chunks.push({
      content: currentLines.join('\n'),
      metadata: {
        ...metadata,
        nodeType: node.type,
        name: parentName,
        startLine: groupStartLine,
        endLine: node.endPosition.row + 1,
        splitPart: chunks.length > 0,
      },
    });
  }

  return chunks;
}

/** 按行切割 (最后手段, 当 AST 无法进一步拆分时) */
function splitByLines(
  text: string,
  metadata: Record<string, unknown>,
  node: ASTNode,
  parentName: string | undefined,
  maxChunkTokens: number
) {
  const lines = text.split('\n');
  const chunks: Array<{ content: string; metadata: Record<string, unknown> }> = [];
  let current: string[] = [];
  let currentTokens = 0;
  const _maxChars = maxChunkTokens * 4;

  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (currentTokens + lineTokens > maxChunkTokens && current.length > 0) {
      chunks.push({
        content: current.join('\n'),
        metadata: {
          ...metadata,
          nodeType: node.type,
          name: parentName,
          splitPart: true,
        },
      });
      current = [];
      currentTokens = 0;
    }
    current.push(line);
    currentTokens += lineTokens;
  }

  if (current.length > 0) {
    chunks.push({
      content: current.join('\n'),
      metadata: {
        ...metadata,
        nodeType: node.type,
        name: parentName,
        splitPart: chunks.length > 0,
      },
    });
  }

  return chunks;
}

/**
 * 从 AST 节点提取名称
 * @param node tree-sitter node
 */
function extractNodeName(node: ASTNode): string | undefined {
  // 常见模式: 节点有 name 子节点
  const nameNode = node.childForFieldName?.('name') || node.childForFieldName?.('declarator');

  if (nameNode) {
    // 可能是 identifier, operator 等
    return nameNode.text?.slice(0, 100); // 限制长度
  }

  // 某些节点类型有特殊命名子节点
  for (let i = 0; i < Math.min(node.childCount, 5); i++) {
    const child = node.child(i);
    if (child?.type === 'identifier' || child?.type === 'type_identifier') {
      return child.text?.slice(0, 100);
    }
  }

  return undefined;
}

export { ensureParser, TOP_LEVEL_TYPES, LANG_ID_MAP };
