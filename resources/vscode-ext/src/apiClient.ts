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

/** ReactiveEvolution 文件变更报告 */
export interface FileChangeReport {
  needsReview: number;
  suggestReview: boolean;
  deprecated: number;
  fixed: number;
  details: Array<{
    recipeId: string;
    recipeTitle: string;
    action: string;
    reason: string;
  }>;
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
   * 通知服务端文件变更事件 — 驱动 Recipe 实时进化
   * 非阻塞调用，失败时静默。
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
      .map((r: RawSearchItem) => {
        let code = '';
        let explanation = '';
        let headers: string[] = [];

        // ── 优先从顶层 r.headers 读取（可能是 JSON 字符串或数组）──
        if (r.headers) {
          if (typeof r.headers === 'string') {
            try {
              const parsed: unknown = JSON.parse(r.headers);
              if (Array.isArray(parsed)) { headers = parsed as string[]; }
            } catch { /* ignored */ }
          } else if (Array.isArray(r.headers)) {
            headers = r.headers;
          }
        }

        if (r.content) {
          const content: ParsedContent | null = typeof r.content === 'string'
            ? (this._tryParse(r.content) as ParsedContent | null)
            : r.content;
          if (content) {
            code =
              content.code ||
              content.pattern ||
              content.content ||
              content.body ||
              content.snippet ||
              content.solution ||
              content.example ||
              '';
            explanation =
              content.rationale ||
              content.description ||
              content.summary ||
              content.explanation ||
              '';
            // content.headers 作为 fallback
            if (headers.length === 0 && Array.isArray(content.headers)) {
              headers = content.headers;
            }
            // 从 Markdown 提取代码
            if (!code && content.markdown) {
              code = this._extractCodeFromMarkdown(content.markdown);
            }
          }
        }

        if (!code && r.code) {
          code = r.code;
        }

        // 从 code 开头分离 import 行
        const { cleanedCode, extractedHeaders } = this._separateImports(code);
        for (const h of extractedHeaders) {
          if (!headers.includes(h)) {
            headers.push(h);
          }
        }

        return {
          title: r.title || r.name || r.id || 'Recipe',
          code: cleanedCode || '(no code)',
          explanation: explanation || r.summary || r.description || '',
          headers,
          moduleName: r.moduleName || undefined,
          trigger: r.trigger || r.completionKey || '',
        };
      })
      .filter((item: SearchResultItem) => item.title && item.code !== '(no code)');
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

  // ─── Remote Command API（飞书 → IDE 桥接） ──────────

  /**
   * 轮询获取一条待执行的远程指令
   */
  async getRemotePending(): Promise<{ id: string; command: string; source: string; userName: string } | null> {
    try {
      const resp = await this._get<ApiResponse<{ id: string; command: string; source: string; userName: string }>>('/remote/pending');
      return resp?.success && resp.data ? resp.data : null;
    } catch {
      return null;
    }
  }

  /**
   * 认领指令（标记为 running）
   */
  async claimRemoteCommand(id: string): Promise<boolean> {
    try {
      const resp = await this._post<ApiResponse>(`/remote/claim/${id}`, {});
      return resp?.success === true;
    } catch {
      return false;
    }
  }

  /**
   * 回写执行结果
   */
  async postRemoteResult(id: string, result: string, status: string = 'completed'): Promise<boolean> {
    try {
      const resp = await this._post<ApiResponse>(`/remote/result/${id}`, { result, status });
      return resp?.success === true;
    } catch {
      return false;
    }
  }

  /**
   * 查询飞书连接状态（用于自动探测）
   */
  async getRemoteLarkStatus(): Promise<{ connected: boolean; queue?: Record<string, number>; projectRoot?: string } | null> {
    try {
      const resp = await this._get<ApiResponse<{ connected: boolean; queue?: Record<string, number>; projectRoot?: string }>>('/remote/lark/status');
      return resp?.success && resp.data ? resp.data : null;
    } catch {
      return null;
    }
  }

  /**
   * 发送飞书主动通知
   */
  async sendLarkNotify(text: string): Promise<boolean> {
    try {
      const resp = await this._post<ApiResponse>('/remote/notify', { text });
      return resp?.success === true;
    } catch {
      return false;
    }
  }

  /**
   * 清理积压的 pending 指令（IDE 重连时调用）
   * 返回被清理的指令数量，0 表示无积压
   */
  async flushStaleCommands(): Promise<{ flushed: number; commands: Array<{ id: string; command: string; age: number }> }> {
    try {
      const resp = await this._post<ApiResponse & { flushed?: number; commands?: Array<{ id: string; command: string; age: number }> }>('/remote/flush', {});
      if (resp?.success) {
        return { flushed: resp.flushed || 0, commands: resp.commands || [] };
      }
      return { flushed: 0, commands: [] };
    } catch {
      return { flushed: 0, commands: [] };
    }
  }

  /**
   * Long-poll: 等待服务端有新的飞书消息写入队列
   * 服务端有新消息时立即返回 { hasNew: true }，无消息则等到超时返回 { hasNew: false }
   */
  async waitForNewCommand(timeout: number, signal?: AbortSignal): Promise<{ hasNew: boolean }> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));

      const req = http.request(
        {
          hostname: this.host,
          port: this.port,
          path: `/api/v1/remote/wait?timeout=${timeout}`,
          method: 'GET',
          timeout: timeout + 5000, // 额外 5s 余量
        },
        (res: http.IncomingMessage) => {
          let body = '';
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => {
            try {
              const data = JSON.parse(body);
              resolve({ hasNew: data?.hasNew === true });
            } catch {
              resolve({ hasNew: false });
            }
          });
        }
      );

      req.on('error', (err: Error) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        resolve({ hasNew: false });
      });

      // 支持 AbortSignal
      const onAbort = () => {
        req.destroy();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal?.removeEventListener('abort', onAbort));

      req.end();
    });
  }

}
