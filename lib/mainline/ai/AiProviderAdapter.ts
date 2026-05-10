import { AiCapabilityPolicy } from "./AiCapabilityPolicy.js";
import type {
  AiJsonRequest,
  AiJsonResult,
  AiProviderStatus,
  AiStructuredOutputOptions,
  AiTextChatOptions,
  AiTextRequest,
  AiTextResult,
  AiToolChatOptions,
  AiToolChatResult,
  MainlineAgentAiPort,
  MainlineAiPort,
  MainlineEmbeddingPort,
} from "./AiPort.js";

export type MainlineAiProviderResolver =
  | MainlineAgentAiPort
  | null
  | (() => MainlineAgentAiPort | null);

export type MainlineAiStatusResolver = AiProviderStatus | (() => AiProviderStatus);

export interface AiProviderMainlineAdapterOptions {
  provider: MainlineAiProviderResolver;
  embeddingProvider?: MainlineAiProviderResolver;
  status?: MainlineAiStatusResolver;
}

/**
 * AiProviderMainlineAdapter 是旧 provider 对象进入新主线的直接入口。
 * 它不制造 mock、不做旧链路兼容，只把真实 AI、tool calling 和 embedding 暴露成主线端口。
 *
 * provider readiness 在每次调用前重新判断，允许外层 provider manager 热切换；
 * 但一旦状态缺失、未 ready 或标记为 mock，调用会在这里被硬拦截。
 */
export class AiProviderMainlineAdapter
  implements MainlineAiPort, MainlineAgentAiPort, MainlineEmbeddingPort
{
  readonly #provider: MainlineAiProviderResolver;
  readonly #embeddingProvider: MainlineAiProviderResolver | undefined;
  readonly #status: MainlineAiStatusResolver | undefined;
  readonly #policy: AiCapabilityPolicy;

  constructor(options: AiProviderMainlineAdapterOptions, policy = new AiCapabilityPolicy()) {
    this.#provider = options.provider;
    this.#embeddingProvider = options.embeddingProvider;
    this.#status = options.status;
    this.#policy = policy;
  }

  get name(): string {
    return this.#resolveProvider()?.name ?? this.status().provider;
  }

  get model(): string {
    return this.#resolveProvider()?.model ?? this.status().model ?? "unknown";
  }

  get _circuitState(): string | undefined {
    return this.#resolveProvider()?._circuitState;
  }

  status(): AiProviderStatus {
    const resolved =
      typeof this.#status === "function"
        ? this.#status()
        : (this.#status ?? inferProviderStatus(this.#resolveProvider()));
    return { ...resolved };
  }

  async generateText(request: AiTextRequest): Promise<AiTextResult> {
    const provider = this.#assertReadyProvider();
    const text = await provider.chat(request.task.prompt, {
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      abortSignal: request.abortSignal,
    });

    return {
      text,
      provider: this.status().provider,
      model: this.status().model,
    };
  }

  async generateJson(request: AiJsonRequest): Promise<AiJsonResult> {
    const provider = this.#assertReadyProvider();
    const value =
      typeof provider.chatWithStructuredOutput === "function"
        ? await provider.chatWithStructuredOutput(request.task.prompt, {
            schema: request.schema,
            temperature: request.temperature,
            maxTokens: request.maxTokens,
            abortSignal: request.abortSignal,
          })
        : await this.#generateJsonViaText(request);

    return {
      value,
      provider: this.status().provider,
      model: this.status().model,
    };
  }

  async chat(prompt: string, context: AiTextChatOptions = {}): Promise<string> {
    return this.#assertReadyProvider().chat(prompt, context);
  }

  async chatWithTools(prompt: string, opts: AiToolChatOptions = {}): Promise<AiToolChatResult> {
    return this.#assertReadyProvider().chatWithTools(prompt, opts);
  }

  async chatWithStructuredOutput(
    prompt: string,
    opts: AiStructuredOutputOptions = {},
  ): Promise<unknown> {
    const provider = this.#assertReadyProvider();
    if (typeof provider.chatWithStructuredOutput === "function") {
      return provider.chatWithStructuredOutput(prompt, opts);
    }
    return parseJsonFromText(await provider.chat(prompt, opts));
  }

  async embed(text: string | string[]): Promise<number[] | number[][]> {
    return this.#assertEmbeddingProvider().embed?.(text) as Promise<number[] | number[][]>;
  }

  supportsEmbedding(): boolean {
    const provider = this.#resolveEmbeddingProvider();
    return !!provider?.embed && (provider.supportsEmbedding?.() ?? true);
  }

  async embedText(text: string): Promise<number[]> {
    const result = await this.#assertEmbeddingProvider().embed?.(text);
    return normalizeEmbeddingTextResult(result);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const result = await this.#assertEmbeddingProvider().embed?.(texts);
    return normalizeEmbeddingBatchResult(result, texts.length);
  }

  async #generateJsonViaText(request: AiJsonRequest): Promise<unknown> {
    const text = await this.#assertReadyProvider().chat(request.task.prompt, {
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      abortSignal: request.abortSignal,
    });
    return parseJsonFromText(text);
  }

  #assertReadyProvider(): MainlineAgentAiPort {
    const provider = this.#resolveProvider();
    const decision = this.#policy.decide(this.status());
    if (!provider || !decision.allowed) {
      throw new Error(`Mainline AI call blocked: ${decision.reason}`);
    }
    return provider;
  }

  #assertEmbeddingProvider(): MainlineAgentAiPort {
    const provider = this.#resolveEmbeddingProvider();
    const status = inferProviderStatus(provider);
    const decision = this.#policy.decide(status);
    if (!provider?.embed || !decision.allowed || !this.supportsEmbedding()) {
      throw new Error(`Mainline embedding call blocked: ${decision.reason}`);
    }
    return provider;
  }

  #resolveProvider(): MainlineAgentAiPort | null {
    return resolveProvider(this.#provider);
  }

  #resolveEmbeddingProvider(): MainlineAgentAiPort | null {
    return resolveProvider(this.#embeddingProvider ?? this.#provider);
  }
}

export function inferProviderStatus(provider: MainlineAgentAiPort | null): AiProviderStatus {
  const name = provider?.name ?? "missing";
  // mock 名称是禁止信号，不是 fallback 能力。主线只能消费真实 provider。
  const mock = name === "mock";
  return {
    provider: name,
    model: provider?.model,
    ready: !!provider && !mock,
    mock,
    reason: provider ? undefined : "AI provider 缺失。",
  };
}

function resolveProvider(resolver: MainlineAiProviderResolver | undefined) {
  return typeof resolver === "function" ? resolver() : (resolver ?? null);
}

function parseJsonFromText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `AiProviderMainlineAdapter expected JSON output but received invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function normalizeEmbeddingTextResult(result: number[] | number[][] | undefined): number[] {
  if (isVector(result)) {
    return result;
  }
  if (Array.isArray(result) && isVector(result[0])) {
    return result[0];
  }
  throw new Error("Mainline embedding provider returned an invalid vector.");
}

function normalizeEmbeddingBatchResult(
  result: number[] | number[][] | undefined,
  expectedLength: number,
): number[][] {
  if (isVector(result)) {
    if (expectedLength === 1) {
      return [result];
    }
    throw new Error("Mainline embedding provider returned one vector for a batch request.");
  }
  if (Array.isArray(result) && result.every(isVector)) {
    if (result.length !== expectedLength) {
      throw new Error("Mainline embedding provider returned a batch with unexpected length.");
    }
    return result;
  }
  throw new Error("Mainline embedding provider returned an invalid vector batch.");
}

function isVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}
