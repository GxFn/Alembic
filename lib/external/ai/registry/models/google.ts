import type { ModelDef } from '../model-defs.js';

const BASE_GOOGLE_CAPS = {
  toolCalling: true,
  vision: true,
  embedding: false,
  jsonMode: true,
  streaming: true,
} as const;

export const GOOGLE_MODELS: ModelDef[] = [
  // ── Gemini 3 series (Preview, 2026) ──
  {
    id: 'google:gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro Preview',
    provider: 'google',
    apiModelId: 'gemini-3.1-pro-preview',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    capabilities: BASE_GOOGLE_CAPS,
    reasoning: {
      supported: true,
      mode: 'thinking',
      effortLevels: ['low', 'high'],
      defaultEffort: 'high',
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
    },
  },
  {
    id: 'google:gemini-3-flash-preview',
    displayName: 'Gemini 3 Flash Preview',
    provider: 'google',
    apiModelId: 'gemini-3-flash-preview',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    capabilities: BASE_GOOGLE_CAPS,
    reasoning: {
      supported: true,
      mode: 'thinking',
      effortLevels: ['minimal', 'low', 'medium', 'high'],
      defaultEffort: 'high',
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
    },
  },
  {
    id: 'google:gemini-3.1-flash-lite-preview',
    displayName: 'Gemini 3.1 Flash-Lite Preview',
    provider: 'google',
    apiModelId: 'gemini-3.1-flash-lite-preview',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    capabilities: BASE_GOOGLE_CAPS,
    reasoning: {
      supported: true,
      mode: 'thinking',
      effortLevels: ['minimal', 'low', 'medium', 'high'],
      defaultEffort: 'minimal',
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
    },
  },
  {
    id: 'google:gemini-3.1-flash',
    displayName: 'Gemini 3.1 Flash',
    provider: 'google',
    apiModelId: 'gemini-3.1-flash',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    capabilities: BASE_GOOGLE_CAPS,
    reasoning: {
      supported: true,
      mode: 'thinking',
      effortLevels: ['minimal', 'low', 'medium', 'high'],
      defaultEffort: 'high',
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
    },
  },
  // ── Gemini 2.5 series (Stable) ──
  {
    id: 'google:gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    provider: 'google',
    apiModelId: 'gemini-2.5-pro',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    capabilities: BASE_GOOGLE_CAPS,
    reasoning: { supported: true, mode: 'thinking' },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
    },
  },
  {
    id: 'google:gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    provider: 'google',
    apiModelId: 'gemini-2.5-flash',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    capabilities: BASE_GOOGLE_CAPS,
    reasoning: { supported: true, mode: 'thinking' },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
    },
  },
  // ── Legacy ──
  {
    id: 'google:gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash',
    provider: 'google',
    apiModelId: 'gemini-2.0-flash',
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    capabilities: BASE_GOOGLE_CAPS,
    reasoning: { supported: false },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
    },
  },
  {
    id: 'google:gemini-1.5-pro',
    displayName: 'Gemini 1.5 Pro',
    provider: 'google',
    apiModelId: 'gemini-1.5-pro',
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    capabilities: BASE_GOOGLE_CAPS,
    reasoning: { supported: false },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
    },
  },
];
