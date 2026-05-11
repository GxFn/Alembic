/**
 * LLMTransport — 纯协议转换层抽象
 *
 * Transport 只负责：
 *   1. 将统一的 TransportRequest 转换为厂商 API 的 HTTP 请求体
 *   2. 发送 HTTP 请求（含认证、超时、重试后中止）
 *   3. 将厂商 API 响应解析为统一的 TransportResponse
 *
 * Transport 不负责：
 *   - 参数校验/过滤 → ParameterGuard (Gateway 层)
 *   - 模型能力查询 → ModelRegistry (Gateway 层)
 *   - 业务逻辑 (上下文窗口管理、工具路由等) → AgentRuntime
 */

import type { TokenUsage, ToolSchema, UnifiedMessage } from '../AiProvider.js';
import type { ProviderId } from '../registry/model-defs.js';

// ─── Transport Request ──────────────────────────────────

export interface TransportRequest {
  model: string;
  messages: UnifiedMessage[];
  systemPrompt?: string;

  tools?: ToolSchema[];
  toolChoice?: string;

  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;

  responseFormat?: 'text' | 'json';
  abortSignal?: AbortSignal;
}

// ─── Transport Response ─────────────────────────────────

export interface TransportFunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface TransportResponse {
  text: string | null;
  functionCalls: TransportFunctionCall[] | null;
  usage: TokenUsage | null;
  reasoningContent?: string | null;
}

// ─── Transport Config ───────────────────────────────────

export interface TransportConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
  /** Provider-specific extensions (e.g. DeepSeek reasoningEffort default) */
  [key: string]: unknown;
}

// ─── Abstract Transport ─────────────────────────────────

export abstract class LLMTransport {
  readonly providerId: ProviderId;
  protected apiKey: string;
  protected baseUrl: string;
  protected timeout: number;

  constructor(providerId: ProviderId, config: TransportConfig) {
    this.providerId = providerId;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || '';
    this.timeout = config.timeout ?? 120_000;
  }

  abstract chatWithTools(request: TransportRequest): Promise<TransportResponse>;

  abstract chat(request: TransportRequest): Promise<string>;

  /** embed 能力，不支持的 Transport 返回空数组 */
  async embed(_texts: string[]): Promise<number[][]> {
    return [];
  }

  /** 带 JSON 格式约束的 chat */
  async chatStructured(request: TransportRequest): Promise<unknown> {
    const text = await this.chat({ ...request, responseFormat: 'json' });
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // ─── Shared HTTP utilities ──────────────────────────────

  protected async post(
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    externalSignal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        let detail = '';
        try {
          const errBody = await res.text();
          const parsed = JSON.parse(errBody);
          detail = parsed?.error?.message || errBody.slice(0, 300);
        } catch {
          /* best effort */
        }
        const err = Object.assign(
          new Error(`${this.providerId} API error: ${res.status}${detail ? ` — ${detail}` : ''}`),
          { status: res.status }
        );
        throw err;
      }

      return (await res.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  protected requireApiKey(label: string): void {
    if (!this.apiKey) {
      const err = Object.assign(new Error(`${label} API Key 未配置`), { code: 'API_KEY_MISSING' });
      throw err;
    }
  }
}
