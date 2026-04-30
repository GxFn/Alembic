/**
 * AiFactory - AI 提供商工厂
 *
 * 根据配置/环境变量创建对应的 AI Provider 实例。
 * 每个 AI 厂商都有独立的 Provider 类，互不继承。
 *
 * 支持: google-gemini, openai, deepseek, claude, ollama, mock
 */

import Logger from '../../infrastructure/logging/Logger.js';
import { ClaudeProvider } from './providers/ClaudeProvider.js';
import { DeepSeekProvider } from './providers/DeepSeekProvider.js';
import { GoogleGeminiProvider } from './providers/GoogleGeminiProvider.js';
import { MockProvider } from './providers/MockProvider.js';
import { OllamaProvider } from './providers/OllamaProvider.js';
import { OpenAiProvider } from './providers/OpenAiProvider.js';

const PROVIDER_MAP = {
  google: GoogleGeminiProvider,
  'google-gemini': GoogleGeminiProvider,
  gemini: GoogleGeminiProvider,
  openai: OpenAiProvider,
  deepseek: DeepSeekProvider,
  claude: ClaudeProvider,
  anthropic: ClaudeProvider,
  ollama: OllamaProvider,
  mock: MockProvider,
};

type ProviderClass =
  | typeof GoogleGeminiProvider
  | typeof OpenAiProvider
  | typeof DeepSeekProvider
  | typeof ClaudeProvider
  | typeof OllamaProvider
  | typeof MockProvider;

/**
 * 创建 AI Provider 实例
 * @param options {provider, model, apiKey, baseUrl}
 */
export function createProvider(options: Record<string, unknown> = {}) {
  const provider = (options.provider as string) || process.env.ALEMBIC_AI_PROVIDER || 'google';
  const ProviderClass = (PROVIDER_MAP as Record<string, ProviderClass>)[provider.toLowerCase()];

  if (!ProviderClass) {
    throw new Error(
      `Unknown AI provider: ${provider}. Supported: ${Object.keys(PROVIDER_MAP).join(', ')}`
    );
  }

  return new ProviderClass({ ...options });
}

/**
 * 从环境变量自动探测并创建 Provider
 * 优先级: ALEMBIC_AI_PROVIDER 指定 > 有 key 的第一个
 */
export function autoDetectProvider() {
  const logger = Logger.getInstance();
  const explicit = process.env.ALEMBIC_AI_PROVIDER;

  if (explicit && explicit.toLowerCase() !== 'auto') {
    const keyEnvMap: Record<string, string | null> = {
      google: 'ALEMBIC_GOOGLE_API_KEY',
      'google-gemini': 'ALEMBIC_GOOGLE_API_KEY',
      gemini: 'ALEMBIC_GOOGLE_API_KEY',
      openai: 'ALEMBIC_OPENAI_API_KEY',
      deepseek: 'ALEMBIC_DEEPSEEK_API_KEY',
      claude: 'ALEMBIC_CLAUDE_API_KEY',
      anthropic: 'ALEMBIC_CLAUDE_API_KEY',
      ollama: null,
      mock: null,
    };
    const requiredKeyEnv = keyEnvMap[explicit.toLowerCase()];
    if (requiredKeyEnv && !process.env[requiredKeyEnv]) {
      logger.warn(
        `[AiFactory] ALEMBIC_AI_PROVIDER=${explicit} 但 ${requiredKeyEnv} 未配置，尝试自动探测其他可用 provider…`
      );
    } else {
      logger.debug(`AI provider explicitly set: ${explicit}`);
      const envModel = process.env.ALEMBIC_AI_MODEL;
      return createProvider({ provider: explicit, ...(envModel ? { model: envModel } : {}) });
    }
  }

  if (process.env.ALEMBIC_GOOGLE_API_KEY) {
    logger.debug('Auto-detected Google Gemini provider');
    return createProvider({ provider: 'google' });
  }
  if (process.env.ALEMBIC_OPENAI_API_KEY) {
    logger.debug('Auto-detected OpenAI provider');
    return createProvider({ provider: 'openai' });
  }
  if (process.env.ALEMBIC_CLAUDE_API_KEY) {
    logger.debug('Auto-detected Claude provider');
    return createProvider({ provider: 'claude' });
  }
  if (process.env.ALEMBIC_DEEPSEEK_API_KEY) {
    logger.debug('Auto-detected DeepSeek provider');
    return createProvider({ provider: 'deepseek' });
  }

  logger.info(
    '[AiFactory] 未找到任何 AI API Key，AI 功能已跳过。请在 .env 中配置 ALEMBIC_GOOGLE_API_KEY 等。'
  );
  return createProvider({ provider: 'mock' });
}

// ─── Fallback 机制 ──────────────────────────────────────────

const PROVIDER_KEY_MAP = {
  google: 'ALEMBIC_GOOGLE_API_KEY',
  openai: 'ALEMBIC_OPENAI_API_KEY',
  deepseek: 'ALEMBIC_DEEPSEEK_API_KEY',
  claude: 'ALEMBIC_CLAUDE_API_KEY',
};

/** 获取可用的 fallback provider 列表（排除当前 provider） */
export function getAvailableFallbacks(currentProvider: string) {
  const fallbacks: string[] = [];
  for (const [name, envKey] of Object.entries(PROVIDER_KEY_MAP)) {
    if (name === currentProvider) {
      continue;
    }
    const key = process.env[envKey];
    if (key && key.length > 0) {
      fallbacks.push(name);
    }
  }
  return fallbacks;
}

/** 判断是否为地理限制 / 不可恢复的 provider 级错误（应触发 fallback） */
export function isGeoOrProviderError(err: unknown) {
  const msg = ((err as Error).message || '').toLowerCase();
  return (
    /user location is not supported|failed_precondition|unsupported.*(region|country|location)|geo|blocked/i.test(
      msg
    ) ||
    (/permission.*denied|forbidden/i.test(msg) && !/rate.?limit|quota|429/i.test(msg))
  );
}

/**
 * 获取 AI Provider，带自动 fallback：
 * 当主 provider 调用失败（地理限制等）时自动切换到备选 provider
 */
export async function getProviderWithFallback() {
  const logger = Logger.getInstance();
  const primary = autoDetectProvider();
  if (!primary) {
    return null;
  }

  const currentProvider = (process.env.ALEMBIC_AI_PROVIDER || 'google').toLowerCase();

  try {
    if (typeof primary.probe === 'function') {
      await primary.probe();
    }
    return primary;
  } catch (probeErr: unknown) {
    if (!isGeoOrProviderError(probeErr)) {
      return primary;
    }
    logger.warn(
      `[AiFactory] Primary provider "${currentProvider}" failed: ${(probeErr as Error).message}`
    );
  }

  const fallbacks = getAvailableFallbacks(currentProvider);
  if (fallbacks.length === 0) {
    logger.warn(`[AiFactory] No fallback providers available. Primary: ${currentProvider}`);
    return primary;
  }

  for (const fbName of fallbacks) {
    try {
      logger.info(`[AiFactory] Trying fallback provider: ${fbName}`);
      const fbProvider = createProvider({ provider: fbName });
      fbProvider._fallbackFrom = currentProvider;
      return fbProvider;
    } catch (e: unknown) {
      logger.warn(`[AiFactory] Fallback "${fbName}" creation failed: ${(e as Error).message}`);
    }
  }

  return primary;
}

/**
 * 创建独立的 Embedding Provider
 *
 * 当 ALEMBIC_EMBED_PROVIDER 被设置时，创建一个专用于 embedding 的 provider 实例，
 * 使 embedding 和 LLM 生成可以使用不同的提供商/模型。
 *
 * @returns 独立的 embed provider，或 null（未配置时）
 */
export function createEmbedProvider(): ReturnType<typeof createProvider> | null {
  const embedProviderName = process.env.ALEMBIC_EMBED_PROVIDER;
  if (!embedProviderName) {
    return null;
  }

  const logger = Logger.getInstance();
  logger.info(`[AiFactory] Creating dedicated embed provider: ${embedProviderName}`);

  return createProvider({
    provider: embedProviderName,
    model: process.env.ALEMBIC_EMBED_MODEL || undefined,
    baseUrl: process.env.ALEMBIC_EMBED_BASE_URL || undefined,
    apiKey: process.env.ALEMBIC_EMBED_API_KEY || undefined,
    embedModel: process.env.ALEMBIC_EMBED_MODEL || undefined,
  });
}

/** 获取当前 AI 配置信息（同步，用于 UI 展示） */
export function getAiConfigInfo() {
  const provider = process.env.ALEMBIC_AI_PROVIDER || 'auto';
  const model = process.env.ALEMBIC_AI_MODEL || '';
  const embedProvider = process.env.ALEMBIC_EMBED_PROVIDER || '';
  const embedModel = process.env.ALEMBIC_EMBED_MODEL || '';
  const hasGoogleKey = !!process.env.ALEMBIC_GOOGLE_API_KEY;
  const hasOpenAiKey = !!process.env.ALEMBIC_OPENAI_API_KEY;
  const hasClaudeKey = !!process.env.ALEMBIC_CLAUDE_API_KEY;
  const hasDeepSeekKey = !!process.env.ALEMBIC_DEEPSEEK_API_KEY;

  return {
    provider,
    model,
    embedProvider,
    embedModel,
    hasKey: hasGoogleKey || hasOpenAiKey || hasClaudeKey || hasDeepSeekKey,
    keys: {
      google: hasGoogleKey,
      openai: hasOpenAiKey,
      claude: hasClaudeKey,
      deepseek: hasDeepSeekKey,
    },
  };
}

// 所有提供商的集中导出
export { AiProvider } from './AiProvider.js';
export { ClaudeProvider } from './providers/ClaudeProvider.js';
export { DeepSeekProvider } from './providers/DeepSeekProvider.js';
export { GoogleGeminiProvider } from './providers/GoogleGeminiProvider.js';
export { MockProvider } from './providers/MockProvider.js';
export { OllamaProvider } from './providers/OllamaProvider.js';
export { OpenAiProvider } from './providers/OpenAiProvider.js';

export default {
  createProvider,
  createEmbedProvider,
  autoDetectProvider,
  getAiConfigInfo,
  getProviderWithFallback,
  getAvailableFallbacks,
  isGeoOrProviderError,
};
