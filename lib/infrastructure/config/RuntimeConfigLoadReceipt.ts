import { existsSync, readFileSync } from 'node:fs';
import type { StrictColdStartConfigProjectionInputV1 } from '@alembic/core/plans';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { WorkspaceSettingsStore } from '@alembic/core/shared';
import { WorkspaceResolver } from '@alembic/core/workspace';

const DEEPSEEK_DEFAULT_ENDPOINT = 'https://api.deepseek.com';
const DEEPSEEK_DEFAULT_REASONING_EFFORT = 'high';

export const RUNTIME_CONFIG_REQUIRED_KEYS_V1 = [
  'ALEMBIC_PROJECT_DIR',
  'ALEMBIC_HOME',
  'NODE_ENV',
  'ALEMBIC_AI_PROVIDER',
  'ALEMBIC_AI_MODEL',
  'ALEMBIC_AI_PROXY',
  'ALEMBIC_AI_REASONING_EFFORT',
  'ALEMBIC_DEEPSEEK_BASE_URL',
  'ALEMBIC_DEEPSEEK_REASONING_EFFORT',
  'ALEMBIC_AI_MAX_CONCURRENCY',
  'ALEMBIC_DEEPSEEK_API_KEY',
  'ALEMBIC_EMBED_PROVIDER',
  'ALEMBIC_EMBED_MODEL',
  'ALEMBIC_EMBED_BASE_URL',
  'ALEMBIC_EMBED_API_KEY',
] as const;

type RuntimeConfigKey = (typeof RUNTIME_CONFIG_REQUIRED_KEYS_V1)[number];
type RuntimeConfigPresence = 'present' | 'missing' | 'not-applicable';

export interface RuntimeConfigKeyReceiptV1 {
  readonly presence: RuntimeConfigPresence;
  readonly source: string;
  readonly reason?: string;
}

export interface RuntimeConfigLoadReceiptV1 {
  readonly schemaVersion: 1;
  readonly kind: 'RuntimeConfigLoadReceiptV1';
  readonly precedence: readonly [
    'workspace-settings',
    'process-env/provider-specific-override',
    'workspace-resolver-vector-localEmbedding-fallback',
  ];
  readonly keys: Readonly<Record<RuntimeConfigKey, RuntimeConfigKeyReceiptV1>>;
  readonly effective: {
    readonly provider: string | null;
    readonly model: string | null;
    readonly deepSeekEndpointSymbol: string;
    readonly reasoningEffort: string | null;
    readonly embedding: {
      readonly provider: string;
      readonly model: string | null;
      readonly endpointSymbol: string;
      readonly dimensions: number | null;
      readonly normalization: string | null;
      readonly batchSupported: boolean | null;
    };
  };
  readonly promptSopBudgets: {
    readonly modelHash: string;
    readonly promptHash: string;
    readonly promptSopEvaluatorBundleHash: string;
    readonly strictConfigSourceArtifactHash: string;
    readonly strictConfigHash: string;
    readonly budgets: Readonly<Record<string, number>>;
  };
  readonly vector: {
    readonly adapterArtifactHash: string;
    readonly configVersion: number | null;
    readonly localEmbeddingEnabled: boolean;
    readonly localEmbeddingModel: string | null;
    readonly localEmbeddingEndpointSymbol: string;
    readonly store: 'json';
    readonly schema: 'RecipeVectorGenerationManifestV1';
    readonly distance: 'cosine-similarity';
    readonly inspection: 'required-healthy';
    readonly routeAdapter: 'active-generation-routing';
  };
  readonly configHash: string;
  readonly receiptHash: string;
}

interface RuntimeConfigPlanningBinding {
  readonly modelHash: string;
  readonly promptHash: string;
  readonly strictConfig: StrictColdStartConfigProjectionInputV1;
}

let alignedReasoning:
  | {
      readonly source: 'derived-from-ALEMBIC_AI_REASONING_EFFORT' | 'provider-specific-override';
      readonly value: string;
      readonly env: NodeJS.ProcessEnv;
    }
  | undefined;

/** Align the generic workspace setting with the exact DeepSeekProvider env contract. */
export function alignDeepSeekReasoningEffort(env: NodeJS.ProcessEnv = process.env): void {
  const providerSpecific = text(env.ALEMBIC_DEEPSEEK_REASONING_EFFORT);
  if (providerSpecific) {
    alignedReasoning = { source: 'provider-specific-override', value: providerSpecific, env };
    return;
  }
  const generic = text(env.ALEMBIC_AI_REASONING_EFFORT);
  if (!generic) {
    alignedReasoning = undefined;
    return;
  }
  env.ALEMBIC_DEEPSEEK_REASONING_EFFORT = generic;
  alignedReasoning = {
    source: 'derived-from-ALEMBIC_AI_REASONING_EFFORT',
    value: generic,
    env,
  };
}

export function createRuntimeConfigLoadReceiptV1(input: {
  readonly projectRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly planning: RuntimeConfigPlanningBinding;
  readonly artifactBindings: {
    readonly promptSopEvaluatorBundleHash: string;
    readonly vectorAdapterHash: string;
  };
  readonly actualProvider?: unknown;
  readonly actualEmbeddingProvider?: unknown;
  readonly workspaceResolver?: WorkspaceResolver;
}): RuntimeConfigLoadReceiptV1 {
  const env = input.env ?? process.env;
  const resolver = input.workspaceResolver ?? WorkspaceResolver.fromProject(input.projectRoot);
  const workspace = new WorkspaceSettingsStore(resolver).readAiConfig().env;
  const resolverConfig = readResolverVectorConfig(resolver);
  const actualProvider = readProvider(input.actualProvider);
  const actualEmbedding = readEmbeddingProvider(input.actualEmbeddingProvider);
  const provider = actualProvider.name ?? text(env.ALEMBIC_AI_PROVIDER);
  const configuredProvider = text(env.ALEMBIC_AI_PROVIDER);
  if (
    provider &&
    configuredProvider &&
    normalizeProvider(provider) !== normalizeProvider(configuredProvider)
  ) {
    throw new Error('STRICT_RUNTIME_CONFIG_PROVIDER_MISMATCH');
  }
  const model = actualProvider.model ?? text(env.ALEMBIC_AI_MODEL);
  const configuredModel = text(env.ALEMBIC_AI_MODEL);
  if (actualProvider.model && configuredModel && actualProvider.model !== configuredModel) {
    throw new Error('STRICT_RUNTIME_CONFIG_MODEL_MISMATCH');
  }
  const isDeepSeek = normalizeProvider(provider) === 'deepseek';
  const expectedReasoning = isDeepSeek
    ? (text(env.ALEMBIC_DEEPSEEK_REASONING_EFFORT) ?? DEEPSEEK_DEFAULT_REASONING_EFFORT)
    : null;
  if (
    isDeepSeek &&
    actualProvider.reasoningEffort &&
    actualProvider.reasoningEffort !== expectedReasoning
  ) {
    throw new Error('STRICT_RUNTIME_CONFIG_REASONING_MISMATCH');
  }
  if (isDeepSeek && actualProvider.baseUrl) {
    const expectedEndpoint = text(env.ALEMBIC_DEEPSEEK_BASE_URL) ?? DEEPSEEK_DEFAULT_ENDPOINT;
    if (actualProvider.baseUrl !== expectedEndpoint) {
      throw new Error('STRICT_RUNTIME_CONFIG_ENDPOINT_MISMATCH');
    }
  }

  const embeddingProvider =
    actualEmbedding.provider ??
    text(env.ALEMBIC_EMBED_PROVIDER) ??
    (provider ? 'primary-provider-fallback' : 'unavailable');
  const embeddingModel = actualEmbedding.model ?? text(env.ALEMBIC_EMBED_MODEL);
  const configuredEmbeddingProvider = text(env.ALEMBIC_EMBED_PROVIDER);
  if (
    actualEmbedding.provider &&
    configuredEmbeddingProvider &&
    normalizeProvider(actualEmbedding.provider) !== normalizeProvider(configuredEmbeddingProvider)
  ) {
    throw new Error('STRICT_RUNTIME_CONFIG_EMBED_PROVIDER_MISMATCH');
  }
  const configuredEmbeddingModel = text(env.ALEMBIC_EMBED_MODEL);
  if (
    actualEmbedding.model &&
    configuredEmbeddingModel &&
    actualEmbedding.model !== configuredEmbeddingModel
  ) {
    throw new Error('STRICT_RUNTIME_CONFIG_EMBED_MODEL_MISMATCH');
  }
  const keys = Object.freeze(
    Object.fromEntries(
      RUNTIME_CONFIG_REQUIRED_KEYS_V1.map((key) => [
        key,
        Object.freeze(
          keyReceipt({
            env,
            isDeepSeek,
            key,
            localEmbedding: resolverConfig.localEmbedding,
            provider,
            workspace,
          })
        ),
      ])
    )
  ) as Readonly<Record<RuntimeConfigKey, RuntimeConfigKeyReceiptV1>>;
  const deepSeekEndpointSymbol = !isDeepSeek
    ? 'not-applicable:effective-provider-is-not-deepseek'
    : text(env.ALEMBIC_DEEPSEEK_BASE_URL)
      ? 'env:ALEMBIC_DEEPSEEK_BASE_URL'
      : 'provider-default:deepseek';
  const embedEndpointSymbol = text(env.ALEMBIC_EMBED_BASE_URL)
    ? embeddingProvider === 'primary-provider-fallback'
      ? 'primary-provider-fallback'
      : sourceForKey('ALEMBIC_EMBED_BASE_URL', env, workspace, resolverConfig.localEmbedding) ===
          'workspace-resolver-vector-localEmbedding-fallback'
        ? 'workspace-resolver:vector.localEmbedding.endpoint'
        : 'env:ALEMBIC_EMBED_BASE_URL'
    : embeddingProvider === 'primary-provider-fallback'
      ? 'primary-provider-fallback'
      : `provider-default:${embeddingProvider}`;
  const effective = Object.freeze({
    provider: provider ?? null,
    model: model ?? null,
    deepSeekEndpointSymbol,
    reasoningEffort: expectedReasoning,
    embedding: Object.freeze({
      provider: embeddingProvider,
      model: embeddingModel ?? null,
      endpointSymbol: embedEndpointSymbol,
      dimensions: actualEmbedding.dimensions,
      normalization: actualEmbedding.normalization,
      batchSupported: actualEmbedding.batchSupported,
    }),
  });
  const promptSopBudgets = Object.freeze({
    modelHash: input.planning.modelHash,
    promptHash: input.planning.promptHash,
    promptSopEvaluatorBundleHash: input.artifactBindings.promptSopEvaluatorBundleHash,
    strictConfigSourceArtifactHash: input.planning.strictConfig.sourceArtifactHash,
    strictConfigHash: hashCanonicalJson(input.planning.strictConfig),
    budgets: Object.freeze({ ...input.planning.strictConfig.strictColdStart }),
  });
  const vector = Object.freeze({
    adapterArtifactHash: input.artifactBindings.vectorAdapterHash,
    configVersion: resolverConfig.version,
    localEmbeddingEnabled: resolverConfig.localEmbedding.enabled,
    localEmbeddingModel: resolverConfig.localEmbedding.model,
    localEmbeddingEndpointSymbol: resolverConfig.localEmbedding.endpoint
      ? 'workspace-resolver:vector.localEmbedding.endpoint'
      : 'not-configured',
    // Strict private-corpus production constructs this exact store/inspection/routing chain.
    store: 'json' as const,
    schema: 'RecipeVectorGenerationManifestV1' as const,
    distance: 'cosine-similarity' as const,
    inspection: 'required-healthy' as const,
    routeAdapter: 'active-generation-routing' as const,
  });
  const precedence = Object.freeze([
    'workspace-settings',
    'process-env/provider-specific-override',
    'workspace-resolver-vector-localEmbedding-fallback',
  ] as const);
  const configSemantic = { effective, keys, precedence, promptSopBudgets, vector };
  const semantic = {
    schemaVersion: 1 as const,
    kind: 'RuntimeConfigLoadReceiptV1' as const,
    ...configSemantic,
    configHash: hashCanonicalJson(configSemantic),
  };
  return Object.freeze({ ...semantic, receiptHash: hashCanonicalJson(semantic) });
}

function keyReceipt(input: {
  env: NodeJS.ProcessEnv;
  workspace: Record<string, string>;
  key: RuntimeConfigKey;
  provider: string | null;
  isDeepSeek: boolean;
  localEmbedding: LocalEmbeddingConfig;
}): RuntimeConfigKeyReceiptV1 {
  const { env, key, workspace, isDeepSeek, localEmbedding } = input;
  if (key.startsWith('ALEMBIC_DEEPSEEK_') && !isDeepSeek) {
    return notApplicable('effective-provider-is-not-deepseek');
  }
  const embedProvider = text(env.ALEMBIC_EMBED_PROVIDER);
  if (key === 'ALEMBIC_EMBED_API_KEY' && !embedProvider) {
    return notApplicable('embedding-uses-primary-provider-fallback');
  }
  if (key === 'ALEMBIC_EMBED_API_KEY' && embedProvider === 'ollama') {
    return notApplicable('embedding-provider-does-not-require-credential');
  }
  const value = text(env[key]);
  if (value) {
    return {
      presence: 'present',
      source: sourceForKey(key, env, workspace, localEmbedding),
    };
  }
  if (key === 'ALEMBIC_DEEPSEEK_BASE_URL' && isDeepSeek) {
    return { presence: 'missing', source: 'provider-default', reason: 'deepseek-default-endpoint' };
  }
  if (key === 'ALEMBIC_DEEPSEEK_REASONING_EFFORT' && isDeepSeek) {
    return {
      presence: 'missing',
      source: 'provider-default',
      reason: 'deepseek-default-reasoning-effort',
    };
  }
  if (key === 'NODE_ENV') {
    return { presence: 'missing', source: 'runtime-default', reason: 'default-development' };
  }
  if (key === 'ALEMBIC_AI_PROXY') {
    return { presence: 'missing', source: 'not-configured', reason: 'direct-provider-transport' };
  }
  if (key === 'ALEMBIC_AI_MAX_CONCURRENCY') {
    return { presence: 'missing', source: 'runtime-default', reason: 'provider-runtime-default' };
  }
  return { presence: 'missing', source: 'not-configured', reason: 'key-not-present' };
}

function sourceForKey(
  key: RuntimeConfigKey,
  env: NodeJS.ProcessEnv,
  workspace: Record<string, string>,
  localEmbedding: LocalEmbeddingConfig
): string {
  const value = text(env[key]);
  if (
    key === 'ALEMBIC_DEEPSEEK_REASONING_EFFORT' &&
    alignedReasoning?.env === env &&
    alignedReasoning.value === value
  ) {
    return alignedReasoning.source;
  }
  if (workspace[key] && workspace[key] === value) {
    return 'workspace-settings';
  }
  if (key === 'ALEMBIC_EMBED_PROVIDER' && value === 'ollama' && localEmbedding.enabled) {
    return 'workspace-resolver-vector-localEmbedding-fallback';
  }
  if (key === 'ALEMBIC_EMBED_MODEL' && value === localEmbedding.model && localEmbedding.enabled) {
    return 'workspace-resolver-vector-localEmbedding-fallback';
  }
  if (
    key === 'ALEMBIC_EMBED_BASE_URL' &&
    value === localEmbedding.endpoint &&
    localEmbedding.enabled
  ) {
    return 'workspace-resolver-vector-localEmbedding-fallback';
  }
  if (key.startsWith('ALEMBIC_DEEPSEEK_')) {
    return 'provider-specific-override';
  }
  return 'process-env';
}

function notApplicable(reason: string): RuntimeConfigKeyReceiptV1 {
  return { presence: 'not-applicable', source: 'not-applicable', reason };
}

interface LocalEmbeddingConfig {
  readonly enabled: boolean;
  readonly model: string | null;
  readonly endpoint: string | null;
}

function readResolverVectorConfig(resolver: WorkspaceResolver): {
  readonly version: number | null;
  readonly localEmbedding: LocalEmbeddingConfig;
} {
  if (!existsSync(resolver.configPath)) {
    return { version: null, localEmbedding: { enabled: false, model: null, endpoint: null } };
  }
  try {
    const config = record(JSON.parse(readFileSync(resolver.configPath, 'utf8')));
    const local = record(record(config.vector).localEmbedding);
    return {
      version: finiteInteger(config.version),
      localEmbedding: {
        enabled: local.enabled === true,
        model: text(local.model),
        endpoint: text(local.endpoint),
      },
    };
  } catch {
    throw new Error('STRICT_RUNTIME_CONFIG_WORKSPACE_RESOLVER_INVALID');
  }
}

function readProvider(value: unknown): {
  readonly name: string | null;
  readonly model: string | null;
  readonly baseUrl: string | null;
  readonly reasoningEffort: string | null;
} {
  const provider = record(value);
  return {
    name: text(provider.name),
    model: text(provider.model),
    baseUrl: text(provider.baseUrl),
    reasoningEffort: text(record(provider._transportExtras).reasoningEffort),
  };
}

function readEmbeddingProvider(value: unknown): {
  readonly provider: string | null;
  readonly model: string | null;
  readonly dimensions: number | null;
  readonly normalization: string | null;
  readonly batchSupported: boolean | null;
} {
  const provider = record(value);
  const describe = provider.describeCapabilities;
  let capabilities: Record<string, unknown> = {};
  if (typeof describe === 'function') {
    try {
      capabilities = record(describe.call(value));
    } catch {
      capabilities = {};
    }
  }
  return {
    provider: text(capabilities.provider) ?? text(provider.name),
    model: text(capabilities.model) ?? text(provider.model),
    dimensions: finiteInteger(capabilities.dimension),
    normalization: text(capabilities.normalization),
    batchSupported:
      typeof capabilities.batchSupported === 'boolean' ? capabilities.batchSupported : null,
  };
}

function normalizeProvider(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase().replace('-', '');
  return normalized === 'google' || normalized === 'googlegemini' || normalized === 'gemini'
    ? 'google'
    : normalized;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}
