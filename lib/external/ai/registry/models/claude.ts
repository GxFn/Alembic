import type { ModelDef } from '../model-defs.js';

const BASE_CLAUDE_CAPS = {
  toolCalling: true,
  vision: true,
  embedding: false,
  jsonMode: false,
  streaming: true,
} as const;

export const CLAUDE_MODELS: ModelDef[] = [
  // ── Opus 4.7 (latest flagship, 2026-04) ──
  // Breaking: temperature/top_p/top_k 全部禁止, extended thinking 移除, 仅支持 adaptive
  {
    id: 'claude:claude-opus-4-7',
    displayName: 'Claude Opus 4.7',
    provider: 'claude',
    apiModelId: 'claude-opus-4-7',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: BASE_CLAUDE_CAPS,
    reasoning: {
      supported: true,
      mode: 'adaptive',
    },
    parameterConstraints: {
      temperature: { allowed: false },
      topP: { allowed: false },
      topK: { allowed: false },
      toolChoice: { allowed: true },
    },
  },
  // ── Sonnet 4.6 (balanced, 2025-12) ──
  {
    id: 'claude:claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    provider: 'claude',
    apiModelId: 'claude-sonnet-4-6',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    capabilities: BASE_CLAUDE_CAPS,
    reasoning: {
      supported: true,
      mode: 'thinking',
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 1 },
      toolChoice: { allowed: true },
    },
  },
  // ── Opus 4.6 ──
  {
    id: 'claude:claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    provider: 'claude',
    apiModelId: 'claude-opus-4-6',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: BASE_CLAUDE_CAPS,
    reasoning: {
      supported: true,
      mode: 'adaptive',
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 1 },
      toolChoice: { allowed: true },
    },
  },
  // ── Opus 4.5 ──
  {
    id: 'claude:claude-opus-4-5',
    displayName: 'Claude Opus 4.5',
    provider: 'claude',
    apiModelId: 'claude-opus-4-5',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    capabilities: BASE_CLAUDE_CAPS,
    reasoning: {
      supported: true,
      mode: 'thinking',
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 1 },
      toolChoice: { allowed: true },
    },
  },
  // ── Haiku 4.5 (fastest) ──
  {
    id: 'claude:claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    provider: 'claude',
    apiModelId: 'claude-haiku-4-5',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    capabilities: BASE_CLAUDE_CAPS,
    reasoning: {
      supported: true,
      mode: 'thinking',
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 1 },
      toolChoice: { allowed: true },
    },
  },
  // ── Sonnet 4.5 ──
  {
    id: 'claude:claude-sonnet-4-5',
    displayName: 'Claude Sonnet 4.5',
    provider: 'claude',
    apiModelId: 'claude-sonnet-4-5',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    capabilities: BASE_CLAUDE_CAPS,
    reasoning: {
      supported: true,
      mode: 'thinking',
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 1 },
      toolChoice: { allowed: true },
    },
  },
  // ── Opus 4.1 ──
  {
    id: 'claude:claude-opus-4-1',
    displayName: 'Claude Opus 4.1',
    provider: 'claude',
    apiModelId: 'claude-opus-4-1',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    capabilities: BASE_CLAUDE_CAPS,
    reasoning: {
      supported: true,
      mode: 'thinking',
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 1 },
      toolChoice: { allowed: true },
    },
  },
  // ── Deprecated ──
  {
    id: 'claude:claude-sonnet-4-20250514',
    displayName: 'Claude Sonnet 4 (deprecated)',
    provider: 'claude',
    apiModelId: 'claude-sonnet-4-20250514',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    capabilities: BASE_CLAUDE_CAPS,
    reasoning: { supported: true, mode: 'thinking' },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 1 },
      toolChoice: { allowed: true },
    },
    deprecated: { retireDate: '2026-06-15', migrateToId: 'claude:claude-sonnet-4-6' },
  },
  {
    id: 'claude:claude-opus-4-20250514',
    displayName: 'Claude Opus 4 (deprecated)',
    provider: 'claude',
    apiModelId: 'claude-opus-4-20250514',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    capabilities: BASE_CLAUDE_CAPS,
    reasoning: { supported: true, mode: 'thinking' },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 1 },
      toolChoice: { allowed: true },
    },
    deprecated: { retireDate: '2026-06-15', migrateToId: 'claude:claude-opus-4-7' },
  },
];
