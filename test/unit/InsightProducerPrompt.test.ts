import { describe, expect, test } from 'vitest';
import { buildProducerPrompt, buildProducerPromptV2 } from '#agent/prompts/insight-producer.js';

describe('Insight producer prompt', () => {
  const dimConfig = {
    id: 'testing-quality',
    label: 'Testing Quality',
    allowedKnowledgeTypes: ['best-practice', 'code-pattern'],
  };
  const projectInfo = { name: 'BiliDili' };

  test('v1 prompt requires dimensionId and forbids category as dimension owner', () => {
    const prompt = buildProducerPrompt(
      {
        analysisText: 'analysis with file evidence',
        referencedFiles: ['Sources/App.swift'],
      },
      dimConfig,
      projectInfo
    );

    expect(prompt).toContain('- dimensionId: testing-quality');
    expect(prompt).toContain('不要用 category 或 knowledgeType 表示维度归属');
    expect(prompt).not.toContain('- category: testing-quality');
  });

  test('v2 prompt keeps the same ownership contract', () => {
    const prompt = buildProducerPromptV2(
      {
        analysisText: 'analysis with file evidence',
        referencedFiles: ['Sources/App.swift'],
        findings: [{ finding: 'MockClient can support repository tests', importance: 8 }],
        negativeSignals: [],
      },
      dimConfig,
      projectInfo
    );

    expect(prompt).toContain('- dimensionId: testing-quality');
    expect(prompt).toContain('category: 只能填写业务/组件分类');
    expect(prompt).not.toContain('- category: testing-quality');
  });
});
