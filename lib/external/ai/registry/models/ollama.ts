import type { ModelDef } from '../model-defs.js';

/**
 * Ollama 模型是动态的（用户本地安装），这里只定义常见模型的合理默认值。
 * 未注册模型通过 ModelRegistry.createDynamicDef() 自动获得保守配置。
 */

const BASE_OLLAMA_CAPS = {
  toolCalling: true,
  vision: false,
  embedding: false,
  jsonMode: false,
  streaming: true,
} as const;

export const OLLAMA_MODELS: ModelDef[] = [
  {
    id: 'ollama:llama3',
    displayName: 'Llama 3',
    provider: 'ollama',
    apiModelId: 'llama3',
    contextWindow: 8_192,
    maxOutputTokens: 4_096,
    capabilities: BASE_OLLAMA_CAPS,
    reasoning: { supported: false },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
    },
  },
  {
    id: 'ollama:llama3.2',
    displayName: 'Llama 3.2',
    provider: 'ollama',
    apiModelId: 'llama3.2',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    capabilities: BASE_OLLAMA_CAPS,
    reasoning: { supported: false },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
    },
  },
  {
    id: 'ollama:qwen2',
    displayName: 'Qwen 2',
    provider: 'ollama',
    apiModelId: 'qwen2',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    capabilities: BASE_OLLAMA_CAPS,
    reasoning: { supported: false },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
    },
  },
  {
    id: 'ollama:mistral',
    displayName: 'Mistral',
    provider: 'ollama',
    apiModelId: 'mistral',
    contextWindow: 32_000,
    maxOutputTokens: 8_192,
    capabilities: BASE_OLLAMA_CAPS,
    reasoning: { supported: false },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
    },
  },
];
