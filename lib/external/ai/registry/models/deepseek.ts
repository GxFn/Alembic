import type { ModelDef } from '../model-defs.js';

const BASE_DEEPSEEK_CAPS = {
  toolCalling: true,
  vision: false,
  embedding: false,
  jsonMode: true,
  streaming: true,
} as const;

export const DEEPSEEK_MODELS: ModelDef[] = [
  // ── V4 (2026-04-24, 1M context, dual thinking/non-thinking) ──
  {
    id: 'deepseek:deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash (284B/13B)',
    provider: 'deepseek',
    apiModelId: 'deepseek-v4-flash',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    capabilities: BASE_DEEPSEEK_CAPS,
    reasoning: {
      supported: true,
      mode: 'thinking',
      requiresContentPassback: true,
      defaultEffort: 'high',
      effortLevels: ['high', 'max'],
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true, disabledWhen: 'thinking' },
      reasoningEffort: { allowed: true, allowedValues: ['high', 'max'] },
    },
  },
  {
    id: 'deepseek:deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro (1.6T/49B)',
    provider: 'deepseek',
    apiModelId: 'deepseek-v4-pro',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    capabilities: BASE_DEEPSEEK_CAPS,
    reasoning: {
      supported: true,
      mode: 'thinking',
      requiresContentPassback: true,
      defaultEffort: 'high',
      effortLevels: ['high', 'max'],
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true, disabledWhen: 'thinking' },
      reasoningEffort: { allowed: true, allowedValues: ['high', 'max'] },
    },
  },
  // ── Legacy (routing to V4-Flash, retire 2026-07-24) ──
  {
    id: 'deepseek:deepseek-chat',
    displayName: 'DeepSeek Chat (→ V4 Flash)',
    provider: 'deepseek',
    apiModelId: 'deepseek-chat',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    capabilities: BASE_DEEPSEEK_CAPS,
    reasoning: { supported: false },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
    },
    deprecated: { retireDate: '2026-07-24', migrateToId: 'deepseek:deepseek-v4-flash' },
  },
  {
    id: 'deepseek:deepseek-reasoner',
    displayName: 'DeepSeek Reasoner (→ V4 Flash thinking)',
    provider: 'deepseek',
    apiModelId: 'deepseek-reasoner',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    capabilities: { ...BASE_DEEPSEEK_CAPS, toolCalling: false },
    reasoning: {
      supported: true,
      mode: 'thinking',
      requiresContentPassback: true,
    },
    parameterConstraints: {
      temperature: { allowed: false },
      toolChoice: { allowed: false },
    },
    deprecated: { retireDate: '2026-07-24', migrateToId: 'deepseek:deepseek-v4-flash' },
  },
];
