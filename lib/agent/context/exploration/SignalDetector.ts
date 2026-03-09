/**
 * SignalDetector — 工具调用信号检测器
 *
 * 从 ExplorationTracker.js 提取的信号收集逻辑。
 * 检测每次工具调用是否产生了新信息（新文件、新搜索模式、新查询目标）。
 *
 * 设计原则:
 *   - 持有对 tracker metrics 的引用（共享 Set 实例避免拷贝开销）
 *   - 纯检测 + 副作用（更新 Sets），不涉及阶段管理
 *   - 可被外部扩展新工具类型
 *
 * @module SignalDetector
 */

// ─── 搜索工具白名单（用于判断"搜索轮次"）───────────────

export const SEARCH_TOOLS = new Set([
  'search_project_code',
  'semantic_search_code',
  'get_class_info',
  'get_class_hierarchy',
  'get_protocol_info',
  'get_method_overrides',
  'get_category_map',
  'list_project_structure',
  'get_project_overview',
  'get_file_summary',
  'query_code_graph',
  'query_call_graph',
]);

/** 信号检测所需的指标集合引用 */
interface SignalMetrics {
  uniqueFiles: Set<string>;
  uniquePatterns: Set<string>;
  uniqueQueries: Set<string>;
}

/** 搜索结果条目 */
interface SearchResultMatch {
  file?: string;
  [key: string]: unknown;
}

/** 搜索工具返回结果 */
interface SearchResult {
  matches?: SearchResultMatch[];
  batchResults?: Record<string, { matches?: SearchResultMatch[] }>;
}

export class SignalDetector {
  /** 共享引用 — 指向 ExplorationTracker 的 metrics 中的三个 Set */
  #metrics: SignalMetrics;

  /**
   * @param {{ uniqueFiles: Set<string>, uniquePatterns: Set<string>, uniqueQueries: Set<string> }} metrics
   */
  constructor(metrics: SignalMetrics) {
    this.#metrics = metrics;
  }

  /**
   * 检测工具调用是否产生了新信息
   *
   * @returns 是否包含新信息
   */
  detect(toolName: string, args: Record<string, unknown>, result: unknown) {
    switch (toolName) {
      case 'search_project_code':
        return this.#detectSearchSignal(args, result);

      case 'read_project_file':
        return this.#detectFileReadSignal(args);

      case 'list_project_structure':
        return this.#detectListSignal(args);

      case 'get_class_info':
      case 'get_class_hierarchy':
      case 'get_protocol_info':
      case 'get_method_overrides':
      case 'get_category_map':
      case 'query_code_graph':
      case 'query_call_graph':
        return this.#detectQuerySignal(toolName, args);

      case 'get_project_overview':
        return this.#detectSingletonQuery('overview');

      case 'submit_knowledge':
      case 'submit_with_check':
        // Submit 本身不算"新信息"（阶段转换由 submitCount 驱动）
        return false;

      default:
        return this.#detectGenericSignal(toolName, args);
    }
  }

  // ─── 内部检测方法 ──────────────────────────────

  #detectSearchSignal(args: Record<string, unknown>, result: unknown) {
    let foundNew = false;
    const pattern = (args?.pattern as string) || '';
    const patterns = (args?.patterns as string[]) || [];
    // 单模式
    if (pattern && !this.#metrics.uniquePatterns.has(pattern)) {
      this.#metrics.uniquePatterns.add(pattern);
      foundNew = true;
    }
    // 批量模式
    for (const p of patterns) {
      if (!this.#metrics.uniquePatterns.has(p)) {
        this.#metrics.uniquePatterns.add(p);
        foundNew = true;
      }
    }
    // 检查搜索结果是否有新文件
    if (result && typeof result === 'object') {
      const r = result as SearchResult;
      const matches = r.matches || [];
      const batchResults: Record<string, { matches?: SearchResultMatch[] }> = r.batchResults || {};
      for (const m of matches) {
        if (m.file && !this.#metrics.uniqueFiles.has(m.file)) {
          this.#metrics.uniqueFiles.add(m.file);
          foundNew = true;
        }
      }
      for (const sub of Object.values(batchResults)) {
        for (const m of sub.matches || []) {
          if (m.file && !this.#metrics.uniqueFiles.has(m.file)) {
            this.#metrics.uniqueFiles.add(m.file);
            foundNew = true;
          }
        }
      }
    }
    return foundNew;
  }

  #detectFileReadSignal(args: Record<string, unknown>) {
    let foundNew = false;
    const fp = (args?.filePath as string) || '';
    const fps = (args?.filePaths as string[]) || [];
    if (fp && !this.#metrics.uniqueFiles.has(fp)) {
      this.#metrics.uniqueFiles.add(fp);
      foundNew = true;
    }
    for (const f of fps) {
      if (!this.#metrics.uniqueFiles.has(f)) {
        this.#metrics.uniqueFiles.add(f);
        foundNew = true;
      }
    }
    return foundNew;
  }

  #detectListSignal(args: Record<string, unknown>) {
    const dir = (args?.directory as string) || '/';
    const qKey = `list:${dir}`;
    if (!this.#metrics.uniqueQueries.has(qKey)) {
      this.#metrics.uniqueQueries.add(qKey);
      return true;
    }
    return false;
  }

  #detectQuerySignal(toolName: string, args: Record<string, unknown>) {
    const queryTarget =
      (args?.className as string) || (args?.protocolName as string) || (args?.name as string) || '';
    const qKey = `${toolName}:${queryTarget}`;
    if (!this.#metrics.uniqueQueries.has(qKey)) {
      this.#metrics.uniqueQueries.add(qKey);
      return true;
    }
    return false;
  }

  #detectSingletonQuery(key: string) {
    if (!this.#metrics.uniqueQueries.has(key)) {
      this.#metrics.uniqueQueries.add(key);
      return true;
    }
    return false;
  }

  #detectGenericSignal(toolName: string, args: Record<string, unknown>) {
    const qKey = `${toolName}:${JSON.stringify(args || {}).substring(0, 80)}`;
    if (!this.#metrics.uniqueQueries.has(qKey)) {
      this.#metrics.uniqueQueries.add(qKey);
      return true;
    }
    return false;
  }
}
