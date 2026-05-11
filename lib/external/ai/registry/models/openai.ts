import type { ModelDef } from '../model-defs.js';

const BASE_OPENAI_CAPS = {
  toolCalling: true,
  vision: true,
  embedding: false,
  jsonMode: true,
  streaming: true,
} as const;

export const OPENAI_MODELS: ModelDef[] = [
  // ── GPT-5.5 (2026-04-23) ──
  {
    id: 'openai:gpt-5.5',
    displayName: 'GPT-5.5',
    provider: 'openai',
    apiModelId: 'gpt-5.5',
    contextWindow: 1_100_000,
    maxOutputTokens: 128_000,
    capabilities: BASE_OPENAI_CAPS,
    reasoning: {
      supported: true,
      mode: 'reasoning_effort',
      defaultEffort: 'medium',
      effortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
      reasoningEffort: {
        allowed: true,
        allowedValues: ['none', 'low', 'medium', 'high', 'xhigh'],
      },
    },
  },
  {
    id: 'openai:gpt-5.5-pro',
    displayName: 'GPT-5.5 Pro',
    provider: 'openai',
    apiModelId: 'gpt-5.5-pro',
    contextWindow: 1_100_000,
    maxOutputTokens: 128_000,
    capabilities: BASE_OPENAI_CAPS,
    reasoning: {
      supported: true,
      mode: 'reasoning_effort',
      defaultEffort: 'medium',
      effortLevels: ['medium', 'high', 'xhigh'],
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
      reasoningEffort: {
        allowed: true,
        allowedValues: ['medium', 'high', 'xhigh'],
      },
    },
  },
  // ── GPT-5.4 (2026-03-05) ──
  {
    id: 'openai:gpt-5.4',
    displayName: 'GPT-5.4',
    provider: 'openai',
    apiModelId: 'gpt-5.4',
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: BASE_OPENAI_CAPS,
    reasoning: {
      supported: true,
      mode: 'reasoning_effort',
      defaultEffort: 'none',
      effortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
      reasoningEffort: {
        allowed: true,
        allowedValues: ['none', 'low', 'medium', 'high', 'xhigh'],
      },
    },
  },
  {
    id: 'openai:gpt-5.4-pro',
    displayName: 'GPT-5.4 Pro',
    provider: 'openai',
    apiModelId: 'gpt-5.4-pro',
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: BASE_OPENAI_CAPS,
    reasoning: {
      supported: true,
      mode: 'reasoning_effort',
      defaultEffort: 'medium',
      effortLevels: ['medium', 'high', 'xhigh'],
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
      reasoningEffort: {
        allowed: true,
        allowedValues: ['medium', 'high', 'xhigh'],
      },
    },
  },
  {
    id: 'openai:gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini',
    provider: 'openai',
    apiModelId: 'gpt-5.4-mini',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: BASE_OPENAI_CAPS,
    reasoning: {
      supported: true,
      mode: 'reasoning_effort',
      defaultEffort: 'medium',
      effortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
      reasoningEffort: {
        allowed: true,
        allowedValues: ['none', 'low', 'medium', 'high', 'xhigh'],
      },
    },
  },
  {
    id: 'openai:gpt-5.4-nano',
    displayName: 'GPT-5.4 Nano',
    provider: 'openai',
    apiModelId: 'gpt-5.4-nano',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: BASE_OPENAI_CAPS,
    reasoning: {
      supported: true,
      mode: 'reasoning_effort',
      defaultEffort: 'medium',
      effortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
      reasoningEffort: {
        allowed: true,
        allowedValues: ['none', 'low', 'medium', 'high', 'xhigh'],
      },
    },
  },
  // ── GPT-5 ──
  {
    id: 'openai:gpt-5',
    displayName: 'GPT-5',
    provider: 'openai',
    apiModelId: 'gpt-5',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: BASE_OPENAI_CAPS,
    reasoning: {
      supported: true,
      mode: 'reasoning_effort',
      defaultEffort: 'medium',
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
    },
  },
  {
    id: 'openai:gpt-5-mini',
    displayName: 'GPT-5 Mini',
    provider: 'openai',
    apiModelId: 'gpt-5-mini',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: BASE_OPENAI_CAPS,
    reasoning: {
      supported: true,
      mode: 'reasoning_effort',
      defaultEffort: 'medium',
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
    },
  },
  {
    id: 'openai:gpt-5-nano',
    displayName: 'GPT-5 Nano',
    provider: 'openai',
    apiModelId: 'gpt-5-nano',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: BASE_OPENAI_CAPS,
    reasoning: { supported: false },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
    },
  },
  // ── Legacy ──
  {
    id: 'openai:gpt-4o',
    displayName: 'GPT-4o (deprecated)',
    provider: 'openai',
    apiModelId: 'gpt-4o',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    capabilities: BASE_OPENAI_CAPS,
    reasoning: { supported: false },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
    },
    deprecated: { retireDate: '2026-07-14', migrateToId: 'openai:gpt-5.4-mini' },
  },
];
