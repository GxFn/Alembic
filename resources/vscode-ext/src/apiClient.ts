/**
 * ApiClient — 与 AutoSnippet API Server (asd ui / asd start) 通信
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

export interface AuditResponse {
  success: boolean;
  data: {
    issues: AuditIssue[];
    summary?: string;
  };
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
      const res = await this._get('/health');
      return res?.success === true;
    } catch {
      return false;
    }
  }

  /**
   * 搜索知识库
   */
  async search(query: string, limit: number = 10): Promise<SearchResultItem[]> {
    const res = await this._get(
      `/search?q=${encodeURIComponent(query)}&mode=auto&limit=${limit}&rank=true`
    ) as SearchResponse;

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
      const res = await this._post('/knowledge', {
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
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 审计单个文件 — 调用 Guard API
   */
  async auditFile(filePath: string, content: string, language: string): Promise<any> {
    return this._post('/guard/file', { filePath, content, language });
  }

  /**
   * 批量审计多个文件 — 调用 Guard batch API
   */
  async auditBatch(
    files: Array<{ filePath: string; content?: string; language?: string }>
  ): Promise<any> {
    return this._post('/guard/batch', { files });
  }

  /**
   * 标准化搜索结果（与 SearchHandler.normalizeSearchResults 对齐）
   */
  private _normalizeSearchResults(rawItems: any[]): SearchResultItem[] {
    return rawItems
      .map((r: any) => {
        let code = '';
        let explanation = '';
        let headers: string[] = [];

        // ── 优先从顶层 r.headers 读取（可能是 JSON 字符串或数组）──
        if (r.headers) {
          let parsed = r.headers;
          if (typeof parsed === 'string') {
            try { parsed = JSON.parse(parsed); } catch { parsed = null; }
          }
          if (Array.isArray(parsed)) {
            headers = parsed;
          }
        }

        if (r.content) {
          const content = typeof r.content === 'string' ? this._tryParse(r.content) : r.content;
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
          moduleName: r.moduleName || null,
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

  private _tryParse(str: string): any {
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  // ─── HTTP helpers ───

  private _get(path: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = `${this.baseUrl}${path}`;
      http
        .get(url, { timeout: 10000 }, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
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

  private _post(path: string, body: any): Promise<any> {
    return new Promise((resolve, reject) => {
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
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
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
