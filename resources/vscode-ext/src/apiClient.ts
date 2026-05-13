/**
 * ApiClient — 与 Alembic API Server (asd ui / asd start) 通信
 *
 * 通过 HTTP 调用 localhost 上的 API Server 端点，
 * 替代 FileWatcher 直接调用 ServiceContainer 的方式。
 */

import * as http from 'node:http';

export interface SearchResultItem {
  title: string;
  code: string;
  explanation: string;
  headers: string[];
  moduleName?: string;
  trigger?: string;
}

export interface SearchResponse {
  success: boolean;
  data: {
    items?: SearchResultItem[];
    query?: string;
    totalResults?: number;
  };
}

export interface AuditIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  line?: number;
  rule?: string;
  fixSuggestion?: string;
}

export interface AuditSummary {
  total?: number;
  errors?: number;
  warnings?: number;
  infos?: number;
}

export interface AuditResponse {
  success: boolean;
  data: {
    issues?: AuditIssue[];
    violations?: AuditIssue[];
    summary?: AuditSummary;
  };
}

/** 文件变更事件影响级别（与服务端 lib/types/reactive-evolution.ts 对齐） */
export type ImpactLevel = 'direct' | 'reference' | 'pattern';

/** 文件变更事件来源（与服务端对齐） */
export type FileChangeEventSource = 'ide-edit' | 'git-head' | 'git-worktree';

/** ReactiveEvolution 文件变更报告 */
export interface FileChangeReport {
  needsReview: number;
  suggestReview: boolean;
  deprecated: number;
  fixed: number;
  skipped?: number;
  details: Array<{
    recipeId: string;
    recipeTitle: string;
    action: string;
    reason: string;
    impactLevel?: ImpactLevel;
    modifiedPath?: string;
  }>;
  eventSource?: FileChangeEventSource;
}

/** Shape of a parsed content block inside a raw search item */
interface ParsedContent {
  code?: string;
  pattern?: string;
  content?: string;
  body?: string;
  snippet?: string;
  solution?: string;
  example?: string;
  rationale?: string;
  description?: string;
  summary?: string;
  explanation?: string;
  headers?: string[];
  markdown?: string;
}

/** Raw item before normalization (from API response) */
interface RawSearchItem {
  title?: string;
  name?: string;
  id?: string;
  code?: string;
  content?: string | ParsedContent;
  headers?: string | string[];
  summary?: string;
  description?: string;
  moduleName?: string;
  trigger?: string;
  completionKey?: string;
}

/** Generic shape returned by API endpoints */
interface ApiResponse<T = Record<string, unknown>> {
  success?: boolean;
  data?: T;
}

export class ApiClient {
  private host: string;
  private port: number;
  private baseUrl: string;

  constructor(host: string = 'localhost', port: number = 3000) {
    this.host = host;
    this.port = port;
    this.baseUrl = `http://${host}:${port}/api/v1`;
  }

  updateConfig(host: string, port: number): void {
    this.host = host;
    this.port = port;
    this.baseUrl = `http://${host}:${port}/api/v1`;
  }

  /**
   * 健康检查 — 判断 API Server 是否在运行
   */
  async isServerRunning(): Promise<boolean> {
    try {
      const res = await this._get<ApiResponse>('/health');
      return res?.success === true;
    } catch {
      return false;
    }
  }

  /**
   * 搜索知识库
   */
  async search(query: string, limit: number = 10): Promise<SearchResultItem[]> {
    const res = await this._get<SearchResponse>(
      `/search?q=${encodeURIComponent(query)}&mode=auto&limit=${limit}&rank=true`
    );

    if (!res?.success || !res.data) {
      return [];
    }

    // API 返回格式可能是 { items: [...] } 或直接 { data: [...] }
    const rawItems = res.data.items || (Array.isArray(res.data) ? res.data : []);
    return this._normalizeSearchResults(rawItems);
  }

  /**
   * 创建候选知识条目
   */
  async createCandidate(data: {
    title: string;
    code: string;
    language: string;
    description?: string;
    filePath?: string;
  }): Promise<{ success: boolean; id?: string; error?: string }> {
    try {
      const res = await this._post<ApiResponse<{ id?: string }>>('/knowledge', {
        title: data.title,
        content: {
          code: data.code,
          description: data.description || '',
        },
        language: data.language,
        lifecycle: 'draft',
        source: data.filePath ? `vscode:${data.filePath}` : 'vscode:selection',
      });
      return { success: true, id: res?.data?.id };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 审计单个文件 — 调用 Guard API
   */
  async auditFile(filePath: string, content: string, language: string): Promise<AuditResponse> {
    return this._post<AuditResponse>('/guard/file', { filePath, content, language });
  }

  /**
   * 批量审计多个文件 — 调用 Guard batch API
   */
  async auditBatch(
    files: Array<{ filePath: string; content?: string; language?: string }>
  ): Promise<AuditResponse> {
    return this._post<AuditResponse>('/guard/batch', { files });
  }

  /**
   * 报告文件变更事件（领域无关）
   *
   * 由 FileChangeCollector 调用。服务端回传 {@link FileChangeReport}
   * （文档 §5.1 I1），VSCode 扩展据此决定是否弹窗。
   *
   * 返回 null 表示：服务端不可用、HTTP 失败、响应 schema 不匹配（文档 §5.1 I4）。
   * 上层需 null-check 后静默跳过弹窗。
   */
  async reportFileChanges(
    events: Array<{
      type: 'created' | 'modified' | 'renamed' | 'deleted';
      path: string;
      oldPath?: string;
      eventSource?: FileChangeEventSource;
    }>
  ): Promise<FileChangeReport | null> {
    try {
      const res = (await this._post('/file-changes', { events })) as {
        success?: boolean;
        data?: Record<string, unknown>;
      };
      if (!res || res.success !== true || !res.data || typeof res.data !== 'object') {
        return null;
      }
      const data = res.data;
      // 基本 schema 校验 + 兜底默认值
      if (typeof data.needsReview !== 'number' || !Array.isArray(data.details)) {
        return null;
      }
      return {
        needsReview: data.needsReview as number,
        suggestReview: (data.suggestReview as boolean) ?? false,
        deprecated: (data.deprecated as number) ?? 0,
        fixed: (data.fixed as number) ?? 0,
        skipped: (data.skipped as number) ?? 0,
        details: (data.details as FileChangeReport['details']) ?? [],
        eventSource: (data.eventSource as FileChangeEventSource | undefined) ?? undefined,
      };
    } catch {
      // 非阻塞，服务端不可用时返回 null
      return null;
    }
  }

  async reportFileChangeHeartbeat(): Promise<boolean> {
    try {
      const res = await this._post<ApiResponse>('/file-changes/heartbeat', {
        source: 'vscode-extension',
      });
      return res?.success === true;
    } catch {
      return false;
    }
  }

  /**
   * @deprecated 使用 reportFileChanges 替代。保留兼容旧调用。
   */
  async notifyFileChanges(
    events: Array<{ type: 'renamed' | 'deleted' | 'modified'; oldPath: string; newPath?: string }>
  ): Promise<FileChangeReport> {
    try {
      const res = await this._post('/evolution/file-changed', { events });
      const data = (res as { data?: Record<string, unknown> })?.data ?? {};
      return {
        needsReview: (data.needsReview as number) ?? 0,
        suggestReview: (data.suggestReview as boolean) ?? false,
        deprecated: (data.deprecated as number) ?? 0,
        fixed: (data.fixed as number) ?? 0,
        details: (data.details as FileChangeReport['details']) ?? [],
      };
    } catch {
      // 非阻塞，服务端不可用时静默忽略
      return { needsReview: 0, suggestReview: false, deprecated: 0, fixed: 0, details: [] };
    }
  }

  /**
   * 标准化搜索结果（与 SearchHandler.normalizeSearchResults 对齐）
   */
  private _normalizeSearchResults(rawItems: RawSearchItem[]): SearchResultItem[] {
    return rawItems
      .map((r: RawSearchItem) => this._normalizeSearchItem(r))
      .filter((item: SearchResultItem) => item.title && item.code !== '(no code)');
  }

  private _normalizeSearchItem(raw: RawSearchItem): SearchResultItem {
    const content = this._parseContent(raw.content);
    const headers = this._resolveHeaders(raw.headers, content?.headers);
    const code = this._resolveCode(raw, content);
    const { cleanedCode, extractedHeaders } = this._separateImports(code);

    return {
      title: raw.title || raw.name || raw.id || 'Recipe',
      code: cleanedCode || '(no code)',
      explanation: this._resolveExplanation(raw, content),
      headers: this._mergeHeaders(headers, extractedHeaders),
      moduleName: raw.moduleName || undefined,
      trigger: raw.trigger || raw.completionKey || '',
    };
  }

  private _parseContent(rawContent: RawSearchItem['content']): ParsedContent | null {
    if (!rawContent) {
      return null;
    }
    return typeof rawContent === 'string'
      ? (this._tryParse(rawContent) as ParsedContent | null)
      : rawContent;
  }

  private _resolveHeaders(
    rawHeaders: RawSearchItem['headers'],
    contentHeaders?: string[]
  ): string[] {
    const headers = this._parseHeaders(rawHeaders);
    if (headers.length === 0 && Array.isArray(contentHeaders)) {
      return [...contentHeaders];
    }
    return headers;
  }

  private _parseHeaders(rawHeaders: RawSearchItem['headers']): string[] {
    if (Array.isArray(rawHeaders)) {
      return [...rawHeaders];
    }
    if (typeof rawHeaders !== 'string') {
      return [];
    }

    const parsed = this._tryParse(rawHeaders);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  }

  private _resolveCode(raw: RawSearchItem, content: ParsedContent | null): string {
    const contentCode = content
      ? content.code ||
        content.pattern ||
        content.content ||
        content.body ||
        content.snippet ||
        content.solution ||
        content.example ||
        ''
      : '';
    if (contentCode) {
      return contentCode;
    }

    const markdownCode = content?.markdown ? this._extractCodeFromMarkdown(content.markdown) : '';
    return markdownCode || raw.code || '';
  }

  private _resolveExplanation(raw: RawSearchItem, content: ParsedContent | null): string {
    const contentExplanation = content
      ? content.rationale || content.description || content.summary || content.explanation || ''
      : '';
    return contentExplanation || raw.summary || raw.description || '';
  }

  private _mergeHeaders(headers: string[], extractedHeaders: string[]): string[] {
    const merged = [...headers];
    for (const h of extractedHeaders) {
      if (!merged.includes(h)) {
        merged.push(h);
      }
    }
    return merged;
  }

  private _separateImports(code: string): {
    cleanedCode: string;
    extractedHeaders: string[];
  } {
    if (!code) {
      return { cleanedCode: code, extractedHeaders: [] };
    }
    const lines = code.split(/\r?\n/);
    const importRe = /^\s*(#import\s|@import\s|#include\s|import\s|from\s+\S+\s+import\s|const\s+.*=\s*require\s*\(|use\s|using\s)/;
    const extractedHeaders: string[] = [];
    let lastImportIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) {
        if (lastImportIdx >= 0) continue;
        continue;
      }
      if (importRe.test(trimmed)) {
        extractedHeaders.push(trimmed);
        lastImportIdx = i;
      } else {
        break;
      }
    }

    if (extractedHeaders.length === 0) {
      return { cleanedCode: code, extractedHeaders: [] };
    }

    const remaining = lines.slice(lastImportIdx + 1);
    while (remaining.length > 0 && !remaining[0]?.trim()) {
      remaining.shift();
    }
    return { cleanedCode: remaining.join('\n').trim(), extractedHeaders };
  }

  private _extractCodeFromMarkdown(md: string): string {
    const fencedRe = /```[\w]*\n([\s\S]*?)```/g;
    const blocks: string[] = [];
    let match;
    while ((match = fencedRe.exec(md)) !== null) {
      const block = match[1].trim();
      if (block) blocks.push(block);
    }
    return blocks.join('\n\n');
  }

  private _tryParse(str: string): unknown {
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  // ─── HTTP helpers ───

  private _get<T = unknown>(path: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const url = `${this.baseUrl}${path}`;
      http
        .get(url, { timeout: 10000 }, (res: http.IncomingMessage) => {
          let data = '';
          res.on('data', (chunk: string) => (data += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error(`Invalid JSON from ${url}`));
            }
          });
        })
        .on('error', reject)
        .on('timeout', function (this: http.ClientRequest) {
          this.destroy();
          reject(new Error('Request timeout'));
        });
    });
  }

  private _post<T = unknown>(path: string, body: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const url = new URL(`${this.baseUrl}${path}`);
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 15000,
        },
        (res: http.IncomingMessage) => {
          let data = '';
          res.on('data', (chunk: string) => (data += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error(`Invalid JSON from POST ${path}`));
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.write(payload);
      req.end();
    });
  }

}
