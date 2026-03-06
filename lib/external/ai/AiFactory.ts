/**
 * AiFactory - AI 提供商工厂
 *
 * 根据配置/环境变量创建对应的 AI Provider 实例
 * 支持: google-gemini, openai, deepseek, claude, ollama, mock
 */

import Logger from '../../infrastructure/logging/Logger.js';
import { ClaudeProvider } from './providers/ClaudeProvider.js';
import { GoogleGeminiProvider } from './providers/GoogleGeminiProvider.js';
import { MockProvider } from './providers/MockProvider.js';
import { OpenAiProvider } from './providers/OpenAiProvider.js';

const PROVIDER_MAP = {
  google: GoogleGeminiProvider,
  'google-gemini': GoogleGeminiProvider,
  gemini: GoogleGeminiProvider,
  openai: OpenAiProvider,
  deepseek: OpenAiProvider,
  claude: ClaudeProvider,
  anthropic: ClaudeProvider,
  ollama: OpenAiProvider,
  mock: MockProvider,
};

const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

/**
 * 创建 AI Provider 实例
 * @param {object} options - {provider, model, apiKey, baseUrl}
 * @returns {AiProvider}
 */
export function createProvider(options: any = {}) {
  const provider = options.provider || process.env.ASD_AI_PROVIDER || 'google';
  const ProviderClass = PROVIDER_MAP[provider.toLowerCase()];

  if (!ProviderClass) {
    throw new Error(
      `Unknown AI provider: ${provider}. Supported: ${Object.keys(PROVIDER_MAP).join(', ')}`
    );
  }

  const config = { ...options };

  // 针对不同 provider 设置默认值
  switch (provider.toLowerCase()) {
    case 'deepseek':
      config.name = 'deepseek';
      config.baseUrl = config.baseUrl || DEEPSEEK_BASE;
      config.apiKey = config.apiKey || process.env.ASD_DEEPSEEK_API_KEY || '';
      config.model = config.model || 'deepseek-chat';
      break;
    case 'ollama':
      config.name = 'ollama';
      config.baseUrl = config.baseUrl || 'http://localhost:11434/v1';
      config.apiKey = config.apiKey || 'ollama';
      config.model = config.model || 'llama3';
      break;
    default:
      break;
  }

  return new ProviderClass(config);
}

/**
 * 从环境变量自动探测并创建 Provider
 * 优先级: ASD_AI_PROVIDER 指定 > 有 key 的第一个
 */
export function autoDetectProvider() {
  const logger = Logger.getInstance();
  const explicit = process.env.ASD_AI_PROVIDER;

  if (explicit && explicit.toLowerCase() !== 'auto') {
    // 验证显式指定的 provider 是否有对应 API Key
    const keyEnvMap = {
      google: 'ASD_GOOGLE_API_KEY',
      'google-gemini': 'ASD_GOOGLE_API_KEY',
      gemini: 'ASD_GOOGLE_API_KEY',
      openai: 'ASD_OPENAI_API_KEY',
      deepseek: 'ASD_DEEPSEEK_API_KEY',
      claude: 'ASD_CLAUDE_API_KEY',
      anthropic: 'ASD_CLAUDE_API_KEY',
      ollama: null, // Ollama 不需要 key
      mock: null,
    };
    const requiredKeyEnv = keyEnvMap[explicit.toLowerCase()];
    if (requiredKeyEnv && !process.env[requiredKeyEnv]) {
      logger.warn(
        `[AiFactory] ASD_AI_PROVIDER=${explicit} 但 ${requiredKeyEnv} 未配置，尝试自动探测其他可用 provider…`
      );
      // 降级到自动探测，不直接 return
    } else {
      logger.debug(`AI provider explicitly set: ${explicit}`);
      return createProvider({ provider: explicit });
    }
  }

  // 按优先级探测
  if (process.env.ASD_GOOGLE_API_KEY) {
    logger.debug('Auto-detected Google Gemini provider');
    return createProvider({ provider: 'google' });
  }
  if (process.env.ASD_OPENAI_API_KEY) {
    logger.debug('Auto-detected OpenAI provider');
    return createProvider({ provider: 'openai' });
  }
  if (process.env.ASD_CLAUDE_API_KEY) {
    logger.debug('Auto-detected Claude provider');
    return createProvider({ provider: 'claude' });
  }
  if (process.env.ASD_DEEPSEEK_API_KEY) {
    logger.debug('Auto-detected DeepSeek provider');
    return createProvider({ provider: 'deepseek' });
  }

  logger.info(
    '[AiFactory] 未找到任何 AI API Key，AI 功能已跳过。请在 .env 中配置 ASD_GOOGLE_API_KEY 等。'
  );
  return createProvider({ provider: 'mock' });
}

// ─── Fallback 机制 ──────────────────────────────────────────

const PROVIDER_KEY_MAP = {
  google: 'ASD_GOOGLE_API_KEY',
  openai: 'ASD_OPENAI_API_KEY',
  deepseek: 'ASD_DEEPSEEK_API_KEY',
  claude: 'ASD_CLAUDE_API_KEY',
};

/**
 * 获取可用的 fallback provider 列表（排除当前 provider）
 * @param {string} currentProvider
 * @returns {string[]}
 */
export function getAvailableFallbacks(currentProvider) {
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

/**
 * 判断是否为地理限制 / 不可恢复的 provider 级错误（应触发 fallback）
 */
export function isGeoOrProviderError(err) {
  const msg = (err.message || '').toLowerCase();
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
 * @returns {Promise<AiProvider>}
 */
export async function getProviderWithFallback() {
  const logger = Logger.getInstance();
  const primary = autoDetectProvider();
  if (!primary) {
    return null;
  }

  const currentProvider = (process.env.ASD_AI_PROVIDER || 'google').toLowerCase();

  // 用 probe 测试 primary 是否可用
  try {
    if (typeof primary.probe === 'function') {
      await primary.probe();
    }
    return primary;
  } catch (probeErr: any) {
    if (!isGeoOrProviderError(probeErr)) {
      // 非地理限制，可能是临时网络问题，仍返回 primary
      return primary;
    }
    logger.warn(`[AiFactory] Primary provider "${currentProvider}" failed: ${probeErr.message}`);
  }

  // Primary 确认不可用，尝试 fallback
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
    } catch (e: any) {
      logger.warn(`[AiFactory] Fallback "${fbName}" creation failed: ${e.message}`);
    }
  }

  return primary;
}

/**
 * 获取当前 AI 配置信息（同步，用于 UI 展示）
 */
export function getAiConfigInfo() {
  const provider = process.env.ASD_AI_PROVIDER || 'auto';
  const model = process.env.ASD_AI_MODEL || '';
  const hasGoogleKey = !!process.env.ASD_GOOGLE_API_KEY;
  const hasOpenAiKey = !!process.env.ASD_OPENAI_API_KEY;
  const hasClaudeKey = !!process.env.ASD_CLAUDE_API_KEY;
  const hasDeepSeekKey = !!process.env.ASD_DEEPSEEK_API_KEY;

  return {
    provider,
    model,
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
export { GoogleGeminiProvider } from './providers/GoogleGeminiProvider.js';
export { MockProvider } from './providers/MockProvider.js';
export { OpenAiProvider } from './providers/OpenAiProvider.js';

export default {
  createProvider,
  autoDetectProvider,
  getAiConfigInfo,
  getProviderWithFallback,
  getAvailableFallbacks,
  isGeoOrProviderError,
};
