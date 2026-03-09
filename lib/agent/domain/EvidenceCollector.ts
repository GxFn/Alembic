/**
 * EvidenceCollector.js — 从 Analyst 工具调用中收集结构化证据
 *
 * Bootstrap 质量门控核心组件: 将 Analyst 阶段的 toolCall 序列转化为
 * 类型化的证据地图、探索日志和负空间信号，供 Producer 阶段直接引用。
 *
 * 被 bootstrap-gate.js (buildAnalysisArtifact) 调用。
 *
 * 设计原则:
 * - 不保留原始工具返回值 (体积过大)
 * - 按工具类型萃取关键信息 (代码片段、搜索命中、类结构)
 * - 记录负空间: 搜索但未找到的模式 → 告知 Producer "这不存在"
 * - 预算控制: 代码片段总量 ≤ 32KB (Layer 2 Detail)
 *
 * @module EvidenceCollector
 */

// ── 常量 ──────────────────────────────────────────────────────────

/** 单个代码片段最大行数 */
const MAX_SNIPPET_LINES = 30;

/** 每个文件最多保留的代码片段数 */
const MAX_SNIPPETS_PER_FILE = 3;

/** 每个搜索模式最多保留的匹配条目 */
const MAX_SEARCH_MATCHES = 5;

/** 默认代码片段总字符预算 */
const DEFAULT_SNIPPET_BUDGET = 32_000;

// ── 类型定义 ──────────────────────────────────────────────────────

/** 代码片段 */
export interface CodeSnippet {
  startLine: number;
  endLine: number;
  content: string;
  analystNote?: string;
}

/** 文件证据条目 */
export interface EvidenceEntry {
  filePath: string;
  codeSnippets: CodeSnippet[];
  summary: string;
  role?: string;
}

/** 探索日志条目 */
export interface ExplorationEntry {
  round: number;
  tool: string;
  intent: string;
  resultSummary: string;
  effective: boolean;
}

/** 负空间信号 */
export interface NegativeSignal {
  searchPattern: string;
  result: 'not_found' | 'empty' | 'irrelevant';
  implication: string;
}

/** 收集结果 */
export interface EvidenceCollectorResult {
  evidenceMap: Map<string, EvidenceEntry>;
  explorationLog: ExplorationEntry[];
  negativeSignals: NegativeSignal[];
}

/** 工具调用参数 */
interface ToolCallArgs {
  filePath?: string;
  filePaths?: string[];
  startLine?: number;
  pattern?: string;
  patterns?: string[];
  query?: string;
  className?: string;
  protocolName?: string;
  directory?: string;
  path?: string;
  rootClass?: string;
  methodName?: string;
  finding?: string;
  dimensionId?: string;
  [key: string]: unknown;
}

/** 工具调用 */
export interface ToolCall {
  tool?: string;
  name?: string;
  params?: ToolCallArgs;
  args?: ToolCallArgs;
  result?: ToolResult;
}

/** 搜索匹配条目 */
interface SearchMatch {
  file?: string;
  line?: number;
  context?: string;
}

/** EvidenceCollector 选项 */
interface EvidenceCollectorOptions {
  snippetBudget?: number;
}

/** 工具结果对象 (所有可能的结果属性联合) */
interface ToolResultObject {
  files?: Array<{ path?: string; filePath?: string; content?: string; startLine?: number }>;
  path?: string;
  filePath?: string;
  content?: string;
  startLine?: number;
  matches?: SearchMatch[];
  batchResults?: Record<string, { matches?: SearchMatch[] }>;
  className?: string;
  superClass?: string;
  protocols?: string[];
  methods?: Array<string | { name?: string; selector?: string }>;
  properties?: unknown[];
  protocolName?: string;
  conformers?: string[];
  summary?: string;
  entries?: unknown[];
  children?: unknown[];
  classes?: unknown[];
  hierarchy?: unknown[];
  [key: string]: unknown;
}

/** 工具结果类型 */
type ToolResult = string | ToolResultObject | null | undefined;

// ── 主类 ──────────────────────────────────────────────────────────

export class EvidenceCollector {
  /** @type {Map<string, EvidenceEntry>} 文件 → 证据条目 */
  #evidenceMap = new Map<string, EvidenceEntry>();

  /** @type {ExplorationEntry[]} 探索日志 */
  #explorationLog: ExplorationEntry[] = [];

  /** @type {NegativeSignal[]} 负空间信号 */
  #negativeSignals: NegativeSignal[] = [];

  /** @type {number} 代码片段总字符预算 */
  #snippetBudget;

  /** @type {number} 当前已使用的片段字符数 */
  #snippetCharsUsed = 0;

  /** @param [options.snippetBudget=32000] 代码片段总字符预算 */
  constructor(options: EvidenceCollectorOptions = {}) {
    this.#snippetBudget = options.snippetBudget ?? DEFAULT_SNIPPET_BUDGET;
  }

  // ─── 公开 API ──────────────────────────────────────────

  /**
   * 处理单个工具调用，提取证据
   *
   * @param toolCall { tool/name, params/args, result }
   * @param [round=0] 调用序号
   */
  processToolCall(toolCall: ToolCall, round = 0) {
    const tool = toolCall.tool || toolCall.name;
    const args = toolCall.params || toolCall.args || {};
    const result = toolCall.result;
    const hasResult = result != null && result !== '';

    // 按工具类型提取证据
    if (hasResult) {
      try {
        switch (tool) {
          case 'read_project_file':
            this.#extractFileEvidence(args, result);
            break;
          case 'search_project_code':
          case 'semantic_search_code':
            this.#extractSearchEvidence(args, result);
            break;
          case 'get_class_info':
            this.#extractClassEvidence(args, result);
            break;
          case 'get_protocol_info':
            this.#extractProtocolEvidence(args, result);
            break;
          case 'get_file_summary':
            this.#extractFileSummary(args, result);
            break;
          // note_finding → WorkingMemory 已处理，不在此重复采集
          // get_project_overview / list_project_structure → 仅入日志
        }
      } catch {
        // 证据提取失败不影响整体流程，仅记入探索日志
      }
    }

    // 所有工具调用都记入探索日志
    this.#explorationLog.push({
      round,
      tool: tool!,
      intent: this.#inferIntent(tool, args),
      resultSummary: this.#summarizeResult(tool, result),
      effective: hasResult && this.#isEffective(tool, result),
    });
  }

  /**
   * 构建收集结果
   *
   * @returns {{
   *   evidenceMap: Map<string, EvidenceEntry>,
   *   explorationLog: ExplorationEntry[],
   *   negativeSignals: NegativeSignal[]
   * }}
   */
  build() {
    return {
      evidenceMap: this.#evidenceMap,
      explorationLog: this.#explorationLog,
      negativeSignals: this.#negativeSignals,
    };
  }

  // ─── 工具特化提取 ─────────────────────────────────────

  /**
   * read_project_file — 提取代码片段
   * 支持批量读取 (result.files) 和单文件读取 (result.content)
   */
  #extractFileEvidence(args: ToolCallArgs, result: ToolResult) {
    // 字符串结果 — 可能是错误消息或直接内容
    if (typeof result === 'string') {
      if (this.#isErrorString(result)) {
        return;
      }
      const filePath = args.filePath;
      if (filePath) {
        this.#addCodeSnippet(filePath, result, args.startLine || 1);
      }
      return;
    }

    if (!result || typeof result !== 'object') {
      return;
    }

    // 批量读取: result.files 数组
    if (Array.isArray(result.files)) {
      for (const f of result.files) {
        const filePath = f.path || f.filePath;
        if (filePath && f.content) {
          this.#addCodeSnippet(filePath, f.content, f.startLine || 1);
        }
      }
      return;
    }

    // 单文件: result.content
    const filePath = result.path || result.filePath || args.filePath;
    if (filePath && result.content) {
      this.#addCodeSnippet(filePath, result.content, result.startLine || args.startLine || 1);
    }
  }

  /**
   * search_project_code / semantic_search_code — 提取匹配 + 负空间信号
   * 支持批量搜索 (result.batchResults) 和单模式搜索 (result.matches)
   */
  #extractSearchEvidence(args: ToolCallArgs, result: ToolResult) {
    const patterns = this.#extractSearchPatterns(args);

    if (typeof result === 'string') {
      if (this.#isErrorString(result) || result.length < 10) {
        for (const p of patterns) {
          this.#addNegativeSignal(p);
        }
      }
      return;
    }

    if (!result || typeof result !== 'object') {
      return;
    }

    const matches = result.matches || [];
    const batchResults = result.batchResults || {};

    // 批量搜索
    if (Object.keys(batchResults).length > 0) {
      for (const [pattern, sub] of Object.entries(batchResults)) {
        const subMatches = (sub as { matches?: SearchMatch[] }).matches || [];
        if (subMatches.length === 0) {
          this.#addNegativeSignal(pattern);
        } else {
          for (const m of subMatches.slice(0, MAX_SEARCH_MATCHES)) {
            this.#addSearchMatch(m, pattern);
          }
        }
      }
      return;
    }

    // 单模式搜索
    if (matches.length === 0) {
      for (const p of patterns) {
        this.#addNegativeSignal(p);
      }
    } else {
      const searchNote = patterns[0] || '?';
      for (const m of matches.slice(0, MAX_SEARCH_MATCHES)) {
        this.#addSearchMatch(m, searchNote);
      }
    }
  }

  /** get_class_info — 提取类结构 → evidenceMap */
  #extractClassEvidence(args: ToolCallArgs, result: ToolResult) {
    if (typeof result !== 'object' || !result) {
      return;
    }

    const className = result.className || args.className;
    const filePath = result.filePath;
    if (!filePath) {
      return;
    }

    const entry = this.#getOrCreateEntry(filePath);
    entry.role = entry.role || 'class-definition';

    const parts = [`Class: ${className}`];
    if (result.superClass) {
      parts.push(`Extends: ${result.superClass}`);
    }
    if (result.protocols?.length) {
      parts.push(`Implements: ${result.protocols.join(', ')}`);
    }
    if (result.methods?.length) {
      const names = result.methods
        .slice(0, 5)
        .map((m) => (typeof m === 'string' ? m : m.name || m.selector || '?'));
      parts.push(`Methods(${result.methods.length}): ${names.join(', ')}`);
    }
    if (result.properties?.length) {
      parts.push(`Props: ${result.properties.length}`);
    }

    const classSummary = parts.join(' | ');
    entry.summary = entry.summary ? `${entry.summary}; ${classSummary}` : classSummary;
  }

  /** get_protocol_info — 提取协议结构 → evidenceMap */
  #extractProtocolEvidence(args: ToolCallArgs, result: ToolResult) {
    if (typeof result !== 'object' || !result) {
      return;
    }

    const protocolName = result.protocolName || args.protocolName;
    const filePath = result.filePath;
    if (!filePath) {
      return;
    }

    const entry = this.#getOrCreateEntry(filePath);
    entry.role = entry.role || 'protocol-definition';

    const parts = [`Protocol: ${protocolName}`];
    if (result.methods?.length) {
      parts.push(`Methods: ${result.methods.length}`);
    }
    if (result.conformers?.length) {
      parts.push(`Conformers: ${result.conformers.slice(0, 5).join(', ')}`);
    }

    const summary = parts.join(' | ');
    entry.summary = entry.summary ? `${entry.summary}; ${summary}` : summary;
  }

  /** get_file_summary — 提取文件级摘要 → evidenceMap */
  #extractFileSummary(args: ToolCallArgs, result: ToolResult) {
    const filePath = args.filePath || (typeof result === 'object' && result?.filePath);
    if (!filePath) {
      return;
    }

    const entry = this.#getOrCreateEntry(filePath);
    const summaryText =
      typeof result === 'string'
        ? result.substring(0, 200)
        : result?.summary
          ? String(result.summary).substring(0, 200)
          : null;

    if (summaryText) {
      entry.summary = entry.summary ? `${entry.summary}; ${summaryText}` : summaryText;
    }
  }

  // ─── 内部辅助 ─────────────────────────────────────────

  /** 获取或创建 evidence entry */
  #getOrCreateEntry(filePath: string) {
    let entry = this.#evidenceMap.get(filePath);
    if (!entry) {
      entry = { filePath, codeSnippets: [], summary: '' };
      this.#evidenceMap.set(filePath, entry);
    }
    return entry;
  }

  /** 向 evidenceMap 添加代码片段 (带预算控制) */
  #addCodeSnippet(filePath: string, content: string, startLine = 1) {
    if (!filePath || !content) {
      return;
    }
    if (this.#snippetCharsUsed >= this.#snippetBudget) {
      return;
    }

    const entry = this.#getOrCreateEntry(filePath);
    if (entry.codeSnippets.length >= MAX_SNIPPETS_PER_FILE) {
      return;
    }

    const lines = String(content).split('\n');
    const trimmed = lines.slice(0, MAX_SNIPPET_LINES);
    const snippetContent = trimmed.join('\n');
    if (!snippetContent) {
      return;
    }

    // 预算检查
    if (this.#snippetCharsUsed + snippetContent.length > this.#snippetBudget) {
      return;
    }

    entry.codeSnippets.push({
      startLine,
      endLine: startLine + trimmed.length - 1,
      content: snippetContent,
    });
    this.#snippetCharsUsed += snippetContent.length;
  }

  /** 向 evidenceMap 添加搜索匹配 */
  #addSearchMatch(match: SearchMatch, searchNote: string) {
    if (!match?.file) {
      return;
    }

    const entry = this.#getOrCreateEntry(match.file);
    if (!match.line || !match.context) {
      return;
    }
    if (entry.codeSnippets.length >= MAX_SNIPPETS_PER_FILE) {
      return;
    }

    // 去重: 同一行不重复添加
    if (entry.codeSnippets.some((s) => s.startLine === match.line)) {
      return;
    }

    const ctx = String(match.context).substring(0, 500);
    entry.codeSnippets.push({
      startLine: match.line,
      endLine: match.line + (ctx.split('\n').length - 1),
      content: ctx,
      analystNote: `search: "${searchNote}"`,
    });
  }

  /** 添加负空间信号 (去重) */
  #addNegativeSignal(pattern: string) {
    if (!pattern) {
      return;
    }
    if (this.#negativeSignals.some((ns) => ns.searchPattern === pattern)) {
      return;
    }
    this.#negativeSignals.push({
      searchPattern: pattern,
      result: 'not_found',
      implication: `未在项目中找到 "${pattern}" 相关模式`,
    });
  }

  /** 检测错误字符串 */
  #isErrorString(str: string) {
    return /not found|error|不存在|无法|failed/i.test(str);
  }

  /** 从搜索参数中提取搜索模式 */
  #extractSearchPatterns(args: ToolCallArgs) {
    if (args.patterns && Array.isArray(args.patterns)) {
      return args.patterns;
    }
    if (args.pattern) {
      return [args.pattern];
    }
    if (args.query) {
      return [args.query];
    }
    return [];
  }

  /** 推断工具调用意图 — WHY */
  #inferIntent(tool: string | undefined, args: ToolCallArgs) {
    switch (tool) {
      case 'read_project_file':
        if (args.filePaths?.length) {
          const preview = args.filePaths.slice(0, 3).join(', ');
          return `Read ${args.filePaths.length} files: ${preview}${args.filePaths.length > 3 ? '…' : ''}`;
        }
        return `Read ${args.filePath || '?'}`;
      case 'search_project_code': {
        const pats = this.#extractSearchPatterns(args);
        if (pats.length > 1) {
          return `Search ${pats.length} patterns: ${pats.slice(0, 3).join(', ')}`;
        }
        return `Search "${pats[0] || '?'}"`;
      }
      case 'semantic_search_code':
        return `Semantic search: "${args.query || '?'}"`;
      case 'get_class_info':
        return `Inspect class ${args.className || '?'}`;
      case 'get_protocol_info':
        return `Inspect protocol ${args.protocolName || '?'}`;
      case 'get_class_hierarchy':
        return `Get class hierarchy${args.rootClass ? ` from ${args.rootClass}` : ''}`;
      case 'get_project_overview':
        return 'Get project overview';
      case 'list_project_structure':
        return `List ${args.directory || args.path || '/'}`;
      case 'get_file_summary':
        return `Summarize ${args.filePath || '?'}`;
      case 'get_method_overrides':
        return `Get overrides${args.methodName ? ` for ${args.methodName}` : ''}`;
      case 'get_category_map':
        return 'Get category map';
      case 'note_finding':
        return `Note: ${(args.finding || '').substring(0, 50)}`;
      case 'get_previous_analysis':
        return `Get prev analysis${args.dimensionId ? ` for ${args.dimensionId}` : ''}`;
      case 'get_previous_evidence':
        return `Get prev evidence${args.query ? ` "${args.query}"` : ''}`;
      case 'query_code_graph':
        return `Query graph: ${(args.query || '').substring(0, 50)}`;
      default:
        return `${tool}(${JSON.stringify(args).substring(0, 50)})`;
    }
  }

  /** 生成工具结果摘要 — WHAT */
  #summarizeResult(tool: string | undefined, result: ToolResult) {
    if (result == null) {
      return '(no result)';
    }
    if (typeof result === 'string') {
      return result.length > 100 ? `${result.substring(0, 100)}…` : result;
    }
    if (typeof result !== 'object') {
      return String(result).substring(0, 100);
    }

    switch (tool) {
      case 'read_project_file':
        if (result.files) {
          return `${result.files.length} files read`;
        }
        if (result.content) {
          return `${(result.content || '').split('\n').length} lines from ${result.path || '?'}`;
        }
        return JSON.stringify(result).substring(0, 100);
      case 'search_project_code':
      case 'semantic_search_code': {
        const batchKeys = Object.keys(result.batchResults || {});
        if (batchKeys.length > 0) {
          const total = batchKeys.reduce(
            (s, k) => s + (result.batchResults![k]?.matches?.length || 0),
            0
          );
          return `${total} matches across ${batchKeys.length} patterns`;
        }
        return `${(result.matches || []).length} matches`;
      }
      case 'get_class_info':
        return `class ${result.className || '?'}${result.superClass ? ` < ${result.superClass}` : ''}, ${result.methods?.length || 0} methods`;
      case 'get_class_hierarchy':
        return `${(result.classes || result.hierarchy || []).length} classes`;
      case 'get_project_overview':
        return 'overview loaded';
      case 'list_project_structure':
        return `${(result.entries || result.children || []).length} entries`;
      default:
        return JSON.stringify(result).substring(0, 100);
    }
  }

  /** 判断工具调用是否有效 (获取到新信息) */
  #isEffective(tool: string | undefined, result: ToolResult) {
    if (!result) {
      return false;
    }
    if (typeof result === 'string') {
      return !this.#isErrorString(result) && result.length > 10;
    }
    if (typeof result !== 'object') {
      return true;
    }

    switch (tool) {
      case 'read_project_file':
        return !!(result.content || result.files?.length);
      case 'search_project_code':
      case 'semantic_search_code':
        return (
          (result.matches?.length ?? 0) > 0 ||
          Object.values(result.batchResults || {}).some(
            (r: { matches?: SearchMatch[] }) => (r.matches?.length ?? 0) > 0
          )
        );
      case 'get_class_info':
        return !!result.className;
      default:
        return true;
    }
  }
}

// ──────────────────────────────────────────────────────────────────
// 类型定义 (JSDoc)
// ──────────────────────────────────────────────────────────────────

export default EvidenceCollector;
