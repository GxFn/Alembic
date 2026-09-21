/** 固定向量能力的宿主装配；模型协议与 Qwen 查询格式由 Core 公开 adapter 负责。 */
import { createHash } from 'node:crypto';
import Logger from '@alembic/core/logging';
import {
  type EmbeddingCapabilityDescriptor,
  type EmbeddingExecutionContext,
  type EmbeddingPort,
  isEmbeddingPort,
  OllamaEmbedProvider,
  type OllamaEmbedProviderConfig,
} from '@alembic/core/vector';

// 官方完整输出维度；本适配器不请求 MRL 截断。每次响应仍逐项验证，声明不代替事实。
// https://huggingface.co/Qwen/Qwen3-Embedding-0.6B#qwen3-embedding-series-model-list
const QWEN_DIMENSIONS: Readonly<Record<string, number>> = {
  'qwen3-embedding:0.6b': 1024,
  'qwen3-embedding:4b': 2560,
  'qwen3-embedding:8b': 4096,
};
const DEFAULT_MODEL = 'qwen3-embedding:0.6b';

export class FixedEmbeddingProvider extends OllamaEmbedProvider {
  readonly #dimension: number;
  readonly #timeoutMs: number;
  readonly profileId: string;
  readonly configurationId: string;

  constructor(config: OllamaEmbedProviderConfig, dimension: number, credential = '') {
    super(config);
    this.#dimension = dimension;
    this.#timeoutMs = config.timeoutMs ?? 30_000;
    this.profileId = createHash('sha256')
      .update(
        JSON.stringify({
          adapter: 'qwen3-native-v1',
          ...this.describeCapabilities(),
        })
      )
      .digest('hex');
    // 连接变更与向量空间分开：轮换 embedding 凭据需要重连，不要求重建向量。
    this.configurationId = createHash('sha256')
      .update(JSON.stringify([this.profileId, this.endpoint, credential]))
      .digest('hex');
  }

  override describeCapabilities(): EmbeddingCapabilityDescriptor {
    return { ...super.describeCapabilities(), dimension: this.#dimension };
  }

  override async embedQuery(text: string, context?: EmbeddingExecutionContext): Promise<number[]> {
    return this.#checked(
      (signal) => super.embedQuery(text, { signal }).then((vector) => [vector]),
      context
    ).then((vectors) => vectors[0]);
  }

  override async embedDocuments(
    texts: readonly string[],
    context?: EmbeddingExecutionContext
  ): Promise<number[][]> {
    return this.#checked((signal) => super.embedDocuments(texts, { signal }), context);
  }

  /** 旧 document-only 调用保留；查询消费者须显式用 embedQuery。 */
  override async embed(texts: string | string[]): Promise<number[] | number[][]> {
    const vectors = await this.embedDocuments(typeof texts === 'string' ? [texts] : texts);
    return typeof texts === 'string' ? vectors[0] : vectors;
  }

  async #checked(
    run: (signal: AbortSignal) => Promise<number[][]>,
    context?: EmbeddingExecutionContext
  ): Promise<number[][]> {
    if (context?.signal?.aborted) {
      throw cancelled();
    }
    const deadlineAt = performance.now() + this.#timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const boundary = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        reject(cancelled());
        controller.abort();
      };
      context?.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        timedOut = true;
        reject(
          Object.assign(new Error('Embedding request deadline exceeded'), { code: 'ETIMEDOUT' })
        );
        controller.abort();
      }, this.#timeoutMs);
    });
    try {
      // Core 的 HTTP timer 只包到 headers；本宿主期限覆盖 body 读取和结果校验。
      const work = Promise.resolve().then(() => {
        if (controller.signal.aborted || context?.signal?.aborted) {
          throw cancelled();
        }
        return run(controller.signal);
      });
      const vectors = await Promise.race([work, boundary]);
      if (context?.signal?.aborted) {
        throw cancelled();
      }
      for (const vector of vectors) {
        const valid =
          Array.isArray(vector) &&
          vector.length === this.#dimension &&
          vector.every((value) => typeof value === 'number' && Number.isFinite(value));
        const norm = valid ? vector.reduce((sum, value) => sum + value * value, 0) : NaN;
        if (!valid || !Number.isFinite(norm) || norm <= 0) {
          throw Object.assign(
            new Error(
              `Invalid embedding vector; expected ${this.#dimension} finite nonzero dimensions`
            ),
            { code: 'EMBEDDING_INVALID_VECTOR' }
          );
        }
      }
      if (performance.now() >= deadlineAt) {
        timedOut = true;
        controller.abort();
        throw new Error('Embedding validation exceeded deadline');
      }
      return vectors;
    } catch (err: unknown) {
      if (timedOut && !context?.signal?.aborted) {
        Logger.getInstance().warn('[embedding] request_timeout; fixed profile retained', {
          timeoutMs: this.#timeoutMs,
        });
        throw Object.assign(new Error('Embedding request deadline exceeded'), {
          code: 'ETIMEDOUT',
        });
      }
      if (context?.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        Logger.getInstance().debug('[embedding] request_cancelled; fixed profile retained');
        throw cancelled();
      }
      Logger.getInstance().warn(
        '[embedding] request_failed; fixed profile retained, no LLM fallback',
        { model: this.model }
      );
      if (err instanceof Error && 'code' in err && err.code === 'EMBEDDING_INVALID_VECTOR') {
        throw err;
      }
      // Core 错误可能含原生响应或 endpoint；宿主边界不把这些正文转发到上层诊断。
      throw Object.assign(new Error('Fixed embedding service request failed'), {
        code: 'EMBEDDING_UNAVAILABLE',
      });
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      if (onAbort) {
        context?.signal?.removeEventListener('abort', onAbort);
      }
    }
  }
}

function cancelled(): Error {
  return Object.assign(new Error('Embedding request cancelled'), { name: 'AbortError' });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 显式 embedding env > workspace localEmbedding；从不读取生成 provider/model/key。 */
export function createEmbeddingProvider(
  config: Record<string, unknown> = {},
  env: Readonly<Record<string, string | undefined>> = process.env
): FixedEmbeddingProvider | null {
  const local = record(record(config.vector).localEmbedding);
  const selected = env.ALEMBIC_EMBED_PROVIDER?.trim().toLowerCase();
  if (
    (env.ALEMBIC_EMBED_PROVIDER !== undefined && !selected) ||
    (!selected && local.enabled !== true)
  ) {
    Logger.getInstance().debug('[embedding] not_configured; lexical retrieval remains available');
    return null;
  }
  if (selected && selected !== 'ollama') {
    throw new Error('Independent embedding requires the configured Ollama/Qwen embedding service');
  }
  const model =
    env.ALEMBIC_EMBED_MODEL?.trim() || optionalConfigString(local.model, 'model') || DEFAULT_MODEL;
  const dimension = Object.hasOwn(QWEN_DIMENSIONS, model) ? QWEN_DIMENSIONS[model] : undefined;
  if (!dimension) {
    throw new Error('Embedding model must be a pinned qwen3-embedding:0.6b, :4b or :8b model');
  }
  const rawEndpoint =
    env.ALEMBIC_EMBED_BASE_URL?.trim() ||
    optionalConfigString(local.endpoint, 'endpoint') ||
    'http://127.0.0.1:11434';
  const url = new URL(rawEndpoint);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Embedding endpoint must be an HTTP(S) root without inline credentials or query parameters'
    );
  }
  if (/\/v1\/?$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/v1\/?$/, '');
    Logger.getInstance().info('[embedding] legacy_endpoint_normalized; using native /api/embed');
  }
  const endpoint = url.toString().replace(/\/+$/, '');
  const apiKey = env.ALEMBIC_EMBED_API_KEY?.trim();
  return new FixedEmbeddingProvider(
    {
      model,
      endpoint,
      timeoutMs: positiveInteger(local.timeoutMs, 30_000),
      maxInFlightEmbeddings: positiveInteger(local.maxInFlightEmbeddings, 2),
      fetchImpl: async (input, init) => {
        try {
          if (init?.signal?.aborted) {
            throw cancelled();
          }
          const response = await fetch(input, {
            ...init,
            headers: { ...init?.headers, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          });
          // Core 的 timer 要覆盖完整 fetch 边界，包含 /api/tags 等探活的 body。
          const body = await readWithSignal(() => response.text(), init?.signal);
          return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            text: async () => body,
            json: async () => JSON.parse(body) as unknown,
          };
        } catch (err: unknown) {
          if (init?.signal?.aborted) {
            throw cancelled();
          }
          void err;
          throw new Error('Embedding transport failed');
        }
      },
    },
    dimension,
    apiKey ?? ''
  );
}

function positiveInteger(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Embedding timeout and concurrency must be positive integers');
  }
  return value;
}

/** Agent sidecar 的模型空间身份；不把明文 endpoint、凭据写进缓存。 */
export function embeddingProfileId(provider: EmbeddingPort): string {
  return provider instanceof FixedEmbeddingProvider
    ? provider.profileId
    : createHash('sha256').update(JSON.stringify(provider.describeCapabilities())).digest('hex');
}

/** DI 向量入口只接独立 typed port，缺席或旧生成型对象不会变成 embedding。 */
export function getEmbeddingProvider(container: {
  singletons?: Record<string, unknown>;
}): EmbeddingPort | null {
  const provider = container.singletons?._embedProvider;
  if (provider == null) {
    return null;
  }
  if (!isEmbeddingPort(provider)) {
    Logger.getInstance().warn('[embedding] invalid injected port; no generating-provider fallback');
    return null;
  }
  return provider;
}

async function readWithSignal<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    throw cancelled();
  }
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(cancelled());
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(read), stopped]);
  } finally {
    if (onAbort) {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

function optionalConfigString(value: unknown, field: string): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Embedding ${field} must be a string`);
  }
  return value.trim();
}
