import type {
  LLMResult,
  RuntimeAiProvider,
  RuntimeChatMessage,
  RuntimeChatWithToolsOptions,
  RuntimeToolSchema,
} from "../agent/runtime/index.js";
import type { AiProviderStatus, MainlineEmbeddingPort } from "../mainline/ai/index.js";
import { getModelRegistry, getProviderConfig, type ProviderId } from "../mainline/ai/index.js";

type EnvLike = Record<string, string | undefined>;

type OpenAiCompatibleProviderId = Extract<ProviderId, "openai" | "deepseek" | "ollama">;
type OpenAiCompatibleEmbeddingProviderId = Extract<ProviderId, "openai" | "ollama">;

interface OpenAiCompatibleConfig {
  readonly provider: OpenAiCompatibleProviderId;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
}

interface OpenAiCompatibleEmbeddingConfig {
  readonly provider: OpenAiCompatibleEmbeddingProviderId;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
}

const CHAT_PROVIDERS = new Set<ProviderId>(["openai", "deepseek", "ollama"]);
const EMBEDDING_PROVIDERS = new Set<ProviderId>(["openai", "ollama"]);
const PROVIDER_ORDER: ProviderId[] = ["openai", "deepseek", "ollama", "google", "claude"];
const PROVIDER_KEY_FALLBACKS: Record<ProviderId, readonly string[]> = {
  openai: ["OPENAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
  google: ["GOOGLE_API_KEY"],
  ollama: [],
};

/**
 * 从 Codex/daemon 进程环境构造真实 AgentRuntime provider。
 * 中文注释：这里是插件宿主适配层，不回迁 legacy provider manager；
 * 未配置或不支持的 provider 返回 null，让 AgentDimensionWorkflow 明确 degraded。
 */
export function createCodexRuntimeAiProviderFromEnv(
  env: EnvLike = process.env,
): RuntimeAiProvider | null {
  const config = resolveOpenAiCompatibleConfig(env, {
    providerEnv: "ALEMBIC_AI_PROVIDER",
    modelEnv: "ALEMBIC_AI_MODEL",
    baseUrlEnv: "ALEMBIC_AI_BASE_URL",
    supportedProviders: CHAT_PROVIDERS,
    defaultProvider: "openai",
  });
  return config ? new OpenAiCompatibleRuntimeAiProvider(config) : null;
}

/**
 * 从环境构造编译期 embedding port。
 * 有 provider 时 SearchIndex 仍是硬路径；embedding 失败只进入 compile report。
 */
export function createCodexEmbeddingProviderFromEnv(
  env: EnvLike = process.env,
): MainlineEmbeddingPort | undefined {
  const config = resolveOpenAiCompatibleEmbeddingConfig(env);
  return config ? new OpenAiCompatibleEmbeddingProvider(config) : undefined;
}

export class OpenAiCompatibleRuntimeAiProvider implements RuntimeAiProvider {
  readonly name: string;
  readonly model: string;
  readonly #config: OpenAiCompatibleConfig;

  constructor(config: OpenAiCompatibleConfig) {
    this.#config = config;
    this.name = config.provider;
    this.model = config.model;
  }

  async chatWithTools(
    prompt: string,
    options: RuntimeChatWithToolsOptions = {},
  ): Promise<LLMResult | null> {
    const toolProjection = projectOpenAiTools(options.tools ?? options.toolSchemas ?? []);
    const body = {
      model: this.#config.model,
      messages: projectOpenAiMessages(prompt, options),
      ...(toolProjection.tools.length > 0 ? { tools: toolProjection.tools } : {}),
      ...(toolProjection.tools.length > 0 && options.toolChoice
        ? { tool_choice: options.toolChoice }
        : {}),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
      stream: false,
    };
    const response = await fetch(`${trimTrailingSlash(this.#config.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: requestHeaders(this.#config.apiKey),
      body: JSON.stringify(body),
      signal: options.abortSignal ?? null,
    });
    if (!response.ok) {
      throw new Error(
        `Alembic AI provider ${this.#config.provider} chat failed: HTTP ${response.status} ${await safeResponseText(
          response,
        )}`,
      );
    }

    const payload = (await response.json()) as OpenAiChatResponse;
    const message = payload.choices?.[0]?.message;
    if (!message) {
      return { text: null, functionCalls: [] };
    }
    const usage = projectUsage(payload.usage);
    const reasoningContent = stringOrNull(message.reasoning_content);
    return {
      text: typeof message.content === "string" ? message.content : null,
      functionCalls: projectFunctionCalls(message.tool_calls, toolProjection.nameByExternal),
      ...(usage === undefined ? {} : { usage }),
      ...(reasoningContent === undefined ? {} : { reasoningContent }),
    };
  }
}

export class OpenAiCompatibleEmbeddingProvider implements MainlineEmbeddingPort {
  readonly #config: OpenAiCompatibleEmbeddingConfig;

  constructor(config: OpenAiCompatibleEmbeddingConfig) {
    this.#config = config;
  }

  status(): AiProviderStatus {
    return {
      provider: this.#config.provider,
      model: this.#config.model,
      ready: this.#config.provider === "ollama" || Boolean(this.#config.apiKey),
      mock: false,
    };
  }

  async embedText(text: string): Promise<number[]> {
    return (await this.embedBatch([text]))[0] ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const response = await fetch(`${trimTrailingSlash(this.#config.baseUrl)}/embeddings`, {
      method: "POST",
      headers: requestHeaders(this.#config.apiKey),
      body: JSON.stringify({ model: this.#config.model, input: texts }),
    });
    if (!response.ok) {
      throw new Error(
        `Alembic embedding provider ${this.#config.provider} failed: HTTP ${
          response.status
        } ${await safeResponseText(response)}`,
      );
    }
    const payload = (await response.json()) as OpenAiEmbeddingResponse;
    return [...(payload.data ?? [])]
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((entry) => entry.embedding)
      .filter(isVector);
  }
}

function resolveOpenAiCompatibleEmbeddingConfig(
  env: EnvLike,
): OpenAiCompatibleEmbeddingConfig | null {
  const config = resolveOpenAiCompatibleConfig(env, {
    providerEnv: "ALEMBIC_EMBED_PROVIDER",
    modelEnv: "ALEMBIC_EMBED_MODEL",
    baseUrlEnv: "ALEMBIC_EMBED_BASE_URL",
    supportedProviders: EMBEDDING_PROVIDERS,
    defaultProvider: "openai",
    modelFallbacks: {
      openai: "text-embedding-3-small",
      ollama: "nomic-embed-text",
    },
  });
  if (!config || !isEmbeddingProvider(config.provider)) {
    return null;
  }
  return {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
  };
}

function resolveOpenAiCompatibleConfig(
  env: EnvLike,
  options: {
    readonly providerEnv: string;
    readonly modelEnv: string;
    readonly baseUrlEnv: string;
    readonly supportedProviders: ReadonlySet<ProviderId>;
    readonly defaultProvider: ProviderId;
    readonly modelFallbacks?: Partial<Record<ProviderId, string>>;
  },
): OpenAiCompatibleConfig | null {
  const provider = resolveProviderId(env, options.providerEnv, options.supportedProviders);
  const selectedProvider = provider ?? firstConfiguredProvider(env, options.supportedProviders);
  if (!selectedProvider || !isChatProvider(selectedProvider)) {
    return null;
  }
  const providerConfig = getProviderConfig(selectedProvider);
  if (!providerConfig) {
    return null;
  }
  const apiKey = apiKeyForProvider(env, selectedProvider);
  if (selectedProvider !== "ollama" && !apiKey) {
    return null;
  }

  const model = resolveApiModel(
    selectedProvider,
    stringValue(env[options.modelEnv]) ??
      stringValue(env[`ALEMBIC_${selectedProvider.toUpperCase()}_MODEL`]) ??
      options.modelFallbacks?.[selectedProvider] ??
      providerConfig.defaultModelId,
  );
  const baseUrl =
    stringValue(env[options.baseUrlEnv]) ??
    (providerConfig.baseUrlEnvVar ? stringValue(env[providerConfig.baseUrlEnvVar]) : undefined) ??
    providerConfig.baseUrl;

  return {
    provider: selectedProvider,
    model,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
  };
}

function resolveProviderId(
  env: EnvLike,
  key: string,
  supported: ReadonlySet<ProviderId>,
): ProviderId | undefined {
  const explicit = stringValue(env[key]);
  if (!explicit || !isProviderId(explicit)) {
    return undefined;
  }
  return supported.has(explicit) ? explicit : undefined;
}

function firstConfiguredProvider(
  env: EnvLike,
  supported: ReadonlySet<ProviderId>,
): ProviderId | undefined {
  for (const provider of PROVIDER_ORDER) {
    if (!supported.has(provider)) {
      continue;
    }
    if (provider === "ollama" && stringValue(env.ALEMBIC_AI_PROVIDER) === "ollama") {
      return provider;
    }
    if (apiKeyForProvider(env, provider)) {
      return provider;
    }
  }
  return undefined;
}

function apiKeyForProvider(env: EnvLike, provider: ProviderId): string | undefined {
  const config = getProviderConfig(provider);
  const keys = [
    ...(config?.keyEnvVar ? [config.keyEnvVar] : []),
    ...PROVIDER_KEY_FALLBACKS[provider],
  ];
  return keys.map((key) => stringValue(env[key])).find(Boolean);
}

function resolveApiModel(provider: ProviderId, modelRef: string): string {
  const registry = getModelRegistry();
  if (modelRef.includes(":")) {
    return registry.get(modelRef)?.apiModelId ?? modelRef.split(":").slice(1).join(":");
  }
  return registry.resolve(provider, modelRef)?.apiModelId ?? modelRef;
}

function projectOpenAiMessages(
  prompt: string,
  options: RuntimeChatWithToolsOptions,
): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [];
  if (options.systemPrompt) {
    messages.push({ role: "system", content: options.systemPrompt });
  }
  const projected = options.messages?.map(projectOpenAiMessage).filter((entry) => entry !== null);
  if (projected?.length) {
    messages.push(...projected);
  } else {
    messages.push({ role: "user", content: prompt });
  }
  return messages;
}

function projectOpenAiMessage(message: RuntimeChatMessage): OpenAiMessage | null {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content ?? "",
      tool_call_id: message.toolCallId ?? "",
    };
  }
  if (message.role === "assistant") {
    const toolCalls = message.toolCalls?.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: {
        name: sanitizeToolName(call.name),
        arguments: JSON.stringify(call.args ?? {}),
      },
    }));
    return {
      role: "assistant",
      content: message.content ?? null,
      ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }
  if (message.role === "system" || message.role === "user") {
    return { role: message.role, content: message.content ?? "" };
  }
  return null;
}

function projectOpenAiTools(schemas: readonly RuntimeToolSchema[]): {
  readonly tools: readonly OpenAiTool[];
  readonly nameByExternal: ReadonlyMap<string, string>;
} {
  const nameByExternal = new Map<string, string>();
  const used = new Set<string>();
  const tools: OpenAiTool[] = schemas.map((schema, index) => {
    const originalName = schema.name;
    const externalName = uniqueExternalToolName(sanitizeToolName(originalName), used, index);
    const description =
      externalName === originalName
        ? schema.description
        : `[Alembic tool: ${originalName}] ${schema.description ?? ""}`.trim();
    nameByExternal.set(externalName, originalName);
    return {
      type: "function",
      function: {
        name: externalName,
        ...(description === undefined ? {} : { description }),
        parameters: toolParameters(schema),
      },
    };
  });
  return { tools, nameByExternal };
}

function toolParameters(schema: RuntimeToolSchema): Record<string, unknown> {
  const fn = isRecord(schema.function) ? schema.function : {};
  const parameters = isRecord(fn.parameters) ? fn.parameters : schema.parameters;
  return isRecord(parameters) ? parameters : { type: "object", additionalProperties: true };
}

function projectFunctionCalls(
  toolCalls: readonly OpenAiToolCall[] | undefined,
  nameByExternal: ReadonlyMap<string, string>,
) {
  return (toolCalls ?? []).map((call) => ({
    id: call.id,
    name: nameByExternal.get(call.function.name) ?? call.function.name,
    args: parseJsonObject(call.function.arguments),
  }));
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function projectUsage(usage: OpenAiChatResponse["usage"]): LLMResult["usage"] | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    ...(usage.prompt_tokens === undefined ? {} : { inputTokens: usage.prompt_tokens }),
    ...(usage.completion_tokens === undefined ? {} : { outputTokens: usage.completion_tokens }),
    ...(usage.completion_tokens_details?.reasoning_tokens === undefined
      ? {}
      : { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }),
    ...(usage.prompt_tokens_details?.cached_tokens === undefined
      ? {}
      : { cacheHitTokens: usage.prompt_tokens_details.cached_tokens }),
  };
}

function requestHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "";
  }
}

function sanitizeToolName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_-]/g, "__");
  return sanitized.length > 0 ? sanitized : "tool";
}

function uniqueExternalToolName(name: string, used: Set<string>, index: number): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const candidate = `${name}_${index}`;
  used.add(candidate);
  return candidate;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isProviderId(value: string): value is ProviderId {
  return ["openai", "deepseek", "claude", "google", "ollama"].includes(value);
}

function isChatProvider(value: ProviderId): value is OpenAiCompatibleProviderId {
  return value === "openai" || value === "deepseek" || value === "ollama";
}

function isEmbeddingProvider(value: ProviderId): value is OpenAiCompatibleEmbeddingProviderId {
  return value === "openai" || value === "ollama";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringOrNull(value: unknown): string | null | undefined {
  return typeof value === "string" ? value : value === null ? null : undefined;
}

function isVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

interface OpenAiMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly type: "function";
    readonly function: { readonly name: string; readonly arguments: string };
  }[];
}

interface OpenAiTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: Record<string, unknown>;
  };
}

interface OpenAiToolCall {
  readonly id: string;
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

interface OpenAiChatResponse {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string | null;
      readonly reasoning_content?: string | null;
      readonly tool_calls?: readonly OpenAiToolCall[];
    };
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number };
    readonly completion_tokens_details?: { readonly reasoning_tokens?: number };
  };
}

interface OpenAiEmbeddingResponse {
  readonly data?: readonly {
    readonly index?: number;
    readonly embedding: number[];
  }[];
}
