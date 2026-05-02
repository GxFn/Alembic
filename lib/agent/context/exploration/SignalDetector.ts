/**
 * SignalDetector — V2 工具调用信号检测器
 *
 * 检测每次工具调用是否产生了新信息（新文件、新搜索模式、新查询目标）。
 *
 * V2 参数契约:
 *   - code.read / code.outline: params.path (单文件)
 *   - code.search: params.pattern / params.patterns (搜索模式)
 *   - code.structure: params.directory (目录)
 *   - code.write: params.path (写入目标)
 *   - graph.query: params.type + params.entity
 *   - terminal.exec: params.command
 *
 * 搜索结果为紧凑文本格式，从中提取文件路径:
 *   "file.swift:42: content" → 提取 "file.swift"
 *
 * @module SignalDetector
 */

// ─── 搜索工具白名单（用于判断"搜索轮次"）───────────────

export const SEARCH_TOOLS = new Set(['code', 'graph']);

/** 判断是否为搜索 action（更精确的搜索轮次判定） */
export function isSearchAction(toolName: string, args: Record<string, unknown>): boolean {
  const action = (args?.action as string) || '';
  if (toolName === 'code') {
    return action === 'search';
  }
  if (toolName === 'graph') {
    return action === 'query';
  }
  return false;
}

/** 信号检测所需的指标集合引用 */
interface SignalMetrics {
  uniqueFiles: Set<string>;
  uniquePatterns: Set<string>;
  uniqueQueries: Set<string>;
}

export class SignalDetector {
  #metrics: SignalMetrics;

  constructor(metrics: SignalMetrics) {
    this.#metrics = metrics;
  }

  /**
   * 检测工具调用是否产生了新信息
   */
  detect(toolName: string, args: Record<string, unknown>, result: unknown): boolean {
    const action = (args?.action as string) || '';

    switch (toolName) {
      case 'code': {
        if (action === 'search') {
          return this.#detectSearchSignal(args, result);
        }
        if (action === 'read') {
          return this.#detectFileSignal(args);
        }
        if (action === 'outline') {
          return this.#detectFileSignal(args);
        }
        if (action === 'write') {
          return this.#detectFileSignal(args);
        }
        if (action === 'structure') {
          return this.#detectListSignal(args);
        }
        return this.#detectGenericSignal(toolName, args);
      }

      case 'graph':
        return this.#detectGraphSignal(args);

      case 'knowledge':
        if (action === 'submit' || action === 'submit_batch') {
          return false;
        }
        return this.#detectGenericSignal(toolName, args);

      case 'terminal':
        return this.#detectTerminalSignal(args);

      default:
        return this.#detectGenericSignal(toolName, args);
    }
  }

  // ─── 内部检测方法 ──────────────────────────────

  /** code.search — 从 params + 文本结果中提取信号 */
  #detectSearchSignal(args: Record<string, unknown>, result: unknown): boolean {
    let foundNew = false;

    const pattern = (args?.pattern as string) || '';
    const patterns = (args?.patterns as string[]) || [];

    if (pattern && !this.#metrics.uniquePatterns.has(pattern)) {
      this.#metrics.uniquePatterns.add(pattern);
      foundNew = true;
    }
    for (const p of patterns) {
      if (!this.#metrics.uniquePatterns.has(p)) {
        this.#metrics.uniquePatterns.add(p);
        foundNew = true;
      }
    }

    // V2 搜索结果是紧凑文本，从中提取文件路径
    // 格式: "file.swift:42: content" 或 "── file.swift ──"
    if (typeof result === 'string') {
      const files = extractFilesFromSearchText(result);
      for (const f of files) {
        if (!this.#metrics.uniqueFiles.has(f)) {
          this.#metrics.uniqueFiles.add(f);
          foundNew = true;
        }
      }
    }

    return foundNew;
  }

  /** code.read / code.outline / code.write — params.path 信号 */
  #detectFileSignal(args: Record<string, unknown>): boolean {
    const fp = (args?.path as string) || '';
    if (fp && !this.#metrics.uniqueFiles.has(fp)) {
      this.#metrics.uniqueFiles.add(fp);
      return true;
    }
    return false;
  }

  /** code.structure — params.directory 信号 */
  #detectListSignal(args: Record<string, unknown>): boolean {
    const dir = (args?.directory as string) || (args?.path as string) || '/';
    const qKey = `list:${dir}`;
    if (!this.#metrics.uniqueQueries.has(qKey)) {
      this.#metrics.uniqueQueries.add(qKey);
      return true;
    }
    return false;
  }

  /** graph.query — params.type + params.entity 信号 */
  #detectGraphSignal(args: Record<string, unknown>): boolean {
    const action = (args?.action as string) || '';
    const type = (args?.type as string) || '';
    const entity = (args?.entity as string) || '';
    const qKey = `graph:${action}:${type}:${entity}`;
    if (!this.#metrics.uniqueQueries.has(qKey)) {
      this.#metrics.uniqueQueries.add(qKey);
      return true;
    }
    return false;
  }

  /** terminal.exec — command 信号去重 */
  #detectTerminalSignal(args: Record<string, unknown>): boolean {
    const cmd = (args?.command as string) || '';
    const qKey = `terminal:${cmd.substring(0, 100)}`;
    if (!this.#metrics.uniqueQueries.has(qKey)) {
      this.#metrics.uniqueQueries.add(qKey);
      return true;
    }
    return false;
  }

  /** 通用降级 — 按工具名 + 参数指纹去重 */
  #detectGenericSignal(toolName: string, args: Record<string, unknown>): boolean {
    const qKey = `${toolName}:${JSON.stringify(args || {}).substring(0, 80)}`;
    if (!this.#metrics.uniqueQueries.has(qKey)) {
      this.#metrics.uniqueQueries.add(qKey);
      return true;
    }
    return false;
  }
}

// ─── 辅助函数 ──────────────────────────────

/**
 * 从 V2 紧凑搜索文本中提取文件路径。
 *
 * 支持格式:
 *   "── path/to/file.ext ──" (分隔线)
 *   "path/to/file.ext:42: content" (匹配行)
 */
const SEARCH_FILE_SEPARATOR_RE = /^── (.+?) ──/gm;
const SEARCH_FILE_MATCH_RE = /^(\S+?\.\w+):\d+:/gm;

function extractFilesFromSearchText(text: string): Set<string> {
  const files = new Set<string>();

  let m: RegExpExecArray | null;

  SEARCH_FILE_SEPARATOR_RE.lastIndex = 0;
  while ((m = SEARCH_FILE_SEPARATOR_RE.exec(text)) !== null) {
    files.add(m[1]);
  }

  SEARCH_FILE_MATCH_RE.lastIndex = 0;
  while ((m = SEARCH_FILE_MATCH_RE.exec(text)) !== null) {
    files.add(m[1]);
  }

  return files;
}
