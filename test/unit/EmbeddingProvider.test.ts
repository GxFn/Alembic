import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmbeddingProvider } from '../../lib/injection/EmbeddingProvider.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const env = { ALEMBIC_EMBED_PROVIDER: 'ollama', ALEMBIC_EMBED_MODEL: 'qwen3-embedding:0.6b' };
const vector = () => [1, ...new Array<number>(1023).fill(0)];
function configuredEmbedding(config: Parameters<typeof createEmbeddingProvider>[0] = {}) {
  const provider = createEmbeddingProvider(config, env);
  if (!provider) {
    throw new Error('Expected configured fixture embedding');
  }
  return provider;
}

describe('fixed Qwen embedding provider', () => {
  it('rejects a prototype property as a model before a request', () => {
    expect(() =>
      createEmbeddingProvider({}, { ...env, ALEMBIC_EMBED_MODEL: 'constructor' })
    ).toThrow(/model/i);
  });

  it('does not start native HTTP when the caller is already cancelled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(
      configuredEmbedding().embedQuery('query', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds response-body reading as well as receiving headers', async () => {
    let signal: AbortSignal | undefined;
    let finish!: (value: unknown) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input, init) => {
        signal = init.signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              finish = (value) => {
                controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
                controller.close();
              };
            },
          }),
          { status: 200 }
        );
      })
    );
    const embedding = configuredEmbedding({
      vector: { localEmbedding: { enabled: true, timeoutMs: 10 } },
    });
    const result = embedding.embedQuery('query').catch((err: unknown) => err);
    const outcome = await Promise.race([
      result,
      new Promise((resolve) => setTimeout(() => resolve('still pending'), 60)),
    ]);
    // 让有缺陷的版本也能结束测试，不遗留未完成的 promise。
    finish({ embeddings: [vector()] });
    await result;
    expect(outcome).toMatchObject({ code: 'ETIMEDOUT' });
    expect(signal?.aborted).toBe(true);
  });

  it('is explicitly configured independently of LLM credentials and preserves query/document formats', async () => {
    const calls: { url: string; body: { input: string[]; model: string } }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url: String(url), body });
        return new Response(JSON.stringify({ embeddings: body.input.map(vector) }), {
          status: 200,
        });
      })
    );
    const embedding = createEmbeddingProvider(
      {},
      { ...env, ALEMBIC_EMBED_BASE_URL: 'http://embedding.invalid/v1' }
    );
    expect(embedding?.describeCapabilities()).toMatchObject({
      provider: 'ollama',
      model: env.ALEMBIC_EMBED_MODEL,
      dimension: 1024,
      formatProfile: 'asymmetric',
    });
    await expect(embedding?.embedQuery('query')).resolves.toHaveLength(1024);
    await expect(embedding?.embedDocuments(['document'])).resolves.toHaveLength(1);
    expect(calls.map((call) => call.url)).toEqual([
      'http://embedding.invalid/api/embed',
      'http://embedding.invalid/api/embed',
    ]);
    expect(calls[0].body.input[0]).toContain('Query:query');
    expect(calls[1].body.input).toEqual(['document']);
    expect(calls.every((call) => call.body.model === env.ALEMBIC_EMBED_MODEL)).toBe(true);
  });

  it('does not select a generating provider or silently accept an unpinned embedding model', () => {
    expect(
      createEmbeddingProvider(
        {},
        { ALEMBIC_AI_PROVIDER: 'openai', ALEMBIC_OPENAI_API_KEY: 'fixture-key' }
      )
    ).toBeNull();
    expect(() => createEmbeddingProvider({}, { ALEMBIC_EMBED_PROVIDER: 'openai' })).toThrow(
      /embedding/i
    );
    expect(() => createEmbeddingProvider({}, { ...env, ALEMBIC_EMBED_MODEL: 'qwen3:4b' })).toThrow(
      /model/i
    );
    expect(
      createEmbeddingProvider({ vector: { localEmbedding: { enabled: false } } }, {})
    ).toBeNull();
  });

  it.each([
    'short',
    'non-finite',
    'zero',
  ] as const)('rejects %s vectors before they enter an index', async (shape) => {
    const bad =
      shape === 'short'
        ? [1, 0]
        : shape === 'zero'
          ? new Array(1024).fill(0)
          : [null, ...new Array(1023).fill(0)];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ embeddings: [bad] }), { status: 200 }))
    );
    const embedding = configuredEmbedding();
    await expect(embedding.embedDocuments(['document'])).rejects.toThrow(/vector/i);
  });

  it('passes cancellation to the native request and does not change the model profile', async () => {
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, init) => {
        signal = init.signal;
        start();
        return new Promise<Response>((_resolve, reject) =>
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          )
        );
      })
    );
    const embedding = configuredEmbedding();
    const controller = new AbortController();
    const outcome = embedding
      .embedQuery('query', { signal: controller.signal })
      .catch((err: unknown) => err);
    await started;
    controller.abort();
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(signal?.aborted).toBe(true);
    expect(embedding.describeCapabilities().model).toBe(env.ALEMBIC_EMBED_MODEL);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
