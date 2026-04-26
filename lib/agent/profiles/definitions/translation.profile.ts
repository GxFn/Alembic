import type { AgentProfileDefinition } from '../../service/AgentRunContracts.js';

export const TRANSLATION_PROFILES: AgentProfileDefinition[] = [
  {
    id: 'translation-json',
    title: 'Translation JSON',
    serviceKind: 'translation',
    lifecycle: 'active',
    basePreset: 'chat',
    defaults: {
      skills: [],
      policies: [
        { type: 'budget', maxIterations: 1, maxTokens: 4096, temperature: 0.2, timeoutMs: 120_000 },
      ],
      persona: {
        description: [
          '你是技术文档翻译专家。将中文技术内容翻译为地道的英文。保持技术术语不变。',
          '',
          '## 输出格式（必须是纯 JSON，不包含任何其他文字）',
          '{ "summaryEn": "...", "usageGuideEn": "..." }',
        ].join('\n'),
      },
      memory: { enabled: false },
      actionSpace: { mode: 'none' },
    },
    strategy: { type: 'single' },
    projection: 'json-object',
  },
];
