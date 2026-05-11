/**
 * ProviderConfig — Provider 配置集中定义
 *
 * 替代 LlmConfigModal.tsx 和 ai.ts 中分散的硬编码 provider 列表。
 * Dashboard 和 API 路由直接消费此配置。
 */

import type { ProviderConfig } from './model-defs.js';

export const PROVIDER_CONFIGS: ProviderConfig[] = [
  {
    id: 'google',
    displayName: 'Google Gemini',
    defaultModelId: 'google:gemini-3-flash-preview',
    keyEnvVar: 'ALEMBIC_GOOGLE_API_KEY',
    baseUrlEnvVar: 'ALEMBIC_GOOGLE_BASE_URL',
    baseUrl: 'https://generativelanguage.googleapis.com',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    defaultModelId: 'openai:gpt-5.5',
    keyEnvVar: 'ALEMBIC_OPENAI_API_KEY',
    baseUrlEnvVar: 'ALEMBIC_OPENAI_BASE_URL',
    baseUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    defaultModelId: 'deepseek:deepseek-v4-flash',
    keyEnvVar: 'ALEMBIC_DEEPSEEK_API_KEY',
    baseUrlEnvVar: 'ALEMBIC_DEEPSEEK_BASE_URL',
    baseUrl: 'https://api.deepseek.com',
  },
  {
    id: 'claude',
    displayName: 'Claude',
    defaultModelId: 'claude:claude-sonnet-4-6',
    keyEnvVar: 'ALEMBIC_CLAUDE_API_KEY',
    baseUrlEnvVar: 'ALEMBIC_CLAUDE_BASE_URL',
    baseUrl: 'https://api.anthropic.com/v1',
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    defaultModelId: 'ollama:llama3',
    keyEnvVar: '',
    baseUrlEnvVar: 'ALEMBIC_OLLAMA_BASE_URL',
    baseUrl: 'http://127.0.0.1:11434/v1',
  },
];

/** 按 ID 查找 ProviderConfig */
export function getProviderConfig(id: string): ProviderConfig | undefined {
  return PROVIDER_CONFIGS.find((p) => p.id === id);
}
