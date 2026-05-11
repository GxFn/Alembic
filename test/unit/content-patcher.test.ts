/**
 * ContentPatcher 单元测试
 *
 * Mock KnowledgeRepository，验证:
 *   - 结构化 JSON patch 应用
 *   - 纯文本降级 patch
 *   - content.markdown section 替换
 *   - 字段白名单过滤
 *   - 无 suggestedChanges 时跳过
 *   - before/after 快照创建
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentPatcher } from '../../lib/service/evolution/ContentPatcher.js';

/* ── Mock factories ── */

/** KnowledgeEntry shape (content is object, headers is array) */
const DEFAULT_ENTRY = {
  id: 'r-001',
  title: 'Test Recipe',
  coreCode: 'func original() {}',
  doClause: 'Use original pattern',
  dontClause: 'Do not skip validation',
  whenClause: 'When creating instances',
  content: {
    markdown: '### 使用指南\nOriginal guide\n\n### 示例\nSome example',
    rationale: 'Original rationale',
  },
  headers: ['import UIKit'],
};

function createMockSourceRefRepo() {
  return {
    findByRecipeId: vi.fn(() => []),
    deleteByRecipeId: vi.fn(),
    upsert: vi.fn(),
  };
}

function createMockRepo(entry?: typeof DEFAULT_ENTRY) {
  const entryData = entry ?? {
    ...DEFAULT_ENTRY,
    content: { ...DEFAULT_ENTRY.content },
    headers: [...DEFAULT_ENTRY.headers],
  };
  const updates: { id: string; data: Record<string, unknown> }[] = [];

  return {
    entryData,
    updates,
    findById: vi.fn(async (id: string) => {
      return id === entryData.id
        ? { ...entryData, content: { ...entryData.content }, headers: [...entryData.headers] }
        : null;
    }),
    update: vi.fn(async (id: string, data: Record<string, unknown>) => {
      updates.push({ id, data });
      // Update in-memory for subsequent reads
      if (data.coreCode !== undefined) {
        entryData.coreCode = data.coreCode as string;
      }
      if (data.doClause !== undefined) {
        entryData.doClause = data.doClause as string;
      }
      if (data.dontClause !== undefined) {
        entryData.dontClause = data.dontClause as string;
      }
      if (data.whenClause !== undefined) {
        entryData.whenClause = data.whenClause as string;
      }
      if (data.content !== undefined) {
        entryData.content = data.content as typeof entryData.content;
      }
      if (data.headers !== undefined) {
        entryData.headers = data.headers as string[];
      }
    }),
  };
}

function makeProposal(evidenceOverrides?: Record<string, unknown>) {
  return {
    id: 'ep-001',
    type: 'enhance',
    targetRecipeId: 'r-001',
    evidence: [
      {
        sourceStatus: 'modified',
        currentCode: 'func updated() {}',
        suggestedChanges: JSON.stringify({
          patchVersion: 1,
          changes: [
            {
              field: 'coreCode',
              action: 'replace',
              newValue: 'func updated() {}',
            },
          ],
          reasoning: 'Function renamed from original to updated',
        }),
        verifiedBy: 'evolution-agent',
        verifiedAt: Date.now(),
        ...evidenceOverrides,
      },
    ],
  };
}

/* ── Tests ── */

describe('ContentPatcher', () => {
  let mockRepo: ReturnType<typeof createMockRepo>;
  let mockSourceRefRepo: ReturnType<typeof createMockSourceRefRepo>;
  let patcher: ContentPatcher;

  beforeEach(() => {
    mockRepo = createMockRepo();
    mockSourceRefRepo = createMockSourceRefRepo();
    patcher = new ContentPatcher(mockRepo as never, mockSourceRefRepo as never);
  });

  describe('applyProposal — structured JSON patch', () => {
    it('applies coreCode replacement', async () => {
      const proposal = makeProposal();
      const result = await patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.fieldsPatched).toContain('coreCode');
      expect(result.beforeSnapshot.coreCode).toBe('func original() {}');
      expect(result.afterSnapshot.coreCode).toBe('func updated() {}');
    });

    it('applies multiple field changes', async () => {
      const proposal = {
        id: 'ep-002',
        type: 'enhance',
        targetRecipeId: 'r-001',
        evidence: [
          {
            suggestedChanges: JSON.stringify({
              patchVersion: 1,
              changes: [
                { field: 'coreCode', action: 'replace', newValue: 'func newCode() {}' },
                { field: 'doClause', action: 'replace', newValue: 'Use new pattern' },
                { field: 'whenClause', action: 'replace', newValue: 'When handling events' },
              ],
              reasoning: 'Major refactor',
            }),
          },
        ],
      };

      const result = await patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(true);
      expect(result.fieldsPatched).toHaveLength(3);
      expect(result.fieldsPatched).toContain('coreCode');
      expect(result.fieldsPatched).toContain('doClause');
      expect(result.fieldsPatched).toContain('whenClause');
    });

    it('applies content.markdown replacement', async () => {
      const proposal = {
        id: 'ep-003',
        type: 'correction',
        targetRecipeId: 'r-001',
        evidence: [
          {
            suggestedChanges: JSON.stringify({
              patchVersion: 1,
              changes: [
                {
                  field: 'content.markdown',
                  action: 'replace',
                  newValue: '### Updated Guide\nNew content',
                },
              ],
              reasoning: 'Content outdated',
            }),
          },
        ],
      };

      const result = await patcher.applyProposal(proposal, 'correction');

      expect(result.success).toBe(true);
      expect(result.fieldsPatched).toContain('content.markdown');
      expect(result.patchSource).toBe('correction');
    });

    it('applies content.markdown section replacement', async () => {
      const proposal = {
        id: 'ep-004',
        type: 'enhance',
        targetRecipeId: 'r-001',
        evidence: [
          {
            suggestedChanges: JSON.stringify({
              patchVersion: 1,
              changes: [
                {
                  field: 'content.markdown',
                  action: 'replace-section',
                  section: '### 使用指南',
                  newContent: '### 使用指南\nUpdated guide content',
                },
              ],
              reasoning: 'Updated usage guide',
            }),
          },
        ],
      };

      const result = await patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(true);
      expect(result.fieldsPatched).toContain('content.markdown');
      // Verify section was replaced but other sections preserved
      expect(result.afterSnapshot.content.markdown).toContain('Updated guide content');
      expect(result.afterSnapshot.content.markdown).toContain('### 示例'); // other section preserved
    });

    it('applies sourceRefs replacement', async () => {
      const proposal = {
        id: 'ep-005',
        type: 'enhance',
        targetRecipeId: 'r-001',
        evidence: [
          {
            suggestedChanges: JSON.stringify({
              patchVersion: 1,
              changes: [
                {
                  field: 'sourceRefs',
                  action: 'replace',
                  newValue: '["src/new-location.swift"]',
                },
              ],
              reasoning: 'File moved',
            }),
          },
        ],
      };

      const result = await patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(true);
      expect(result.fieldsPatched).toContain('sourceRefs');
      expect(result.afterSnapshot.sourceRefs).toEqual(['src/new-location.swift']);
    });

    it('applies append action', async () => {
      const proposal = {
        id: 'ep-006',
        type: 'enhance',
        targetRecipeId: 'r-001',
        evidence: [
          {
            suggestedChanges: JSON.stringify({
              patchVersion: 1,
              changes: [
                {
                  field: 'content.rationale',
                  action: 'append',
                  newValue: '\n\nAdditional context about the pattern.',
                },
              ],
              reasoning: 'Additional context',
            }),
          },
        ],
      };

      const result = await patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(true);
      expect(result.fieldsPatched).toContain('content.rationale');
    });
  });

  describe('applyProposal — fallback text patch', () => {
    it('falls back to content.markdown replacement for non-JSON text', async () => {
      const proposal = {
        id: 'ep-fallback',
        type: 'enhance',
        targetRecipeId: 'r-001',
        evidence: [
          {
            suggestedChanges:
              'This is a plain text suggestion that should replace the markdown content because it is long enough.',
          },
        ],
      };

      const result = await patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(true);
      expect(result.fieldsPatched).toContain('content.markdown');
    });
  });

  describe('applyProposal — skip conditions', () => {
    it('skips when recipe not found', async () => {
      const proposal = {
        id: 'ep-missing',
        type: 'enhance',
        targetRecipeId: 'r-nonexistent',
        evidence: [{ suggestedChanges: '{"changes":[]}' }],
      };

      const result = await patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('not found');
    });

    it('skips when no suggestedChanges in evidence', async () => {
      const proposal = {
        id: 'ep-nochanges',
        type: 'enhance',
        targetRecipeId: 'r-001',
        evidence: [{ sourceStatus: 'modified', currentCode: 'func foo() {}' }],
      };

      const result = await patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('No suggestedChanges');
    });

    it('skips when suggestedChanges is empty string', async () => {
      const proposal = {
        id: 'ep-empty',
        type: 'enhance',
        targetRecipeId: 'r-001',
        evidence: [{ suggestedChanges: '' }],
      };

      const result = await patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(false);
      expect(result.skipped).toBe(true);
    });

    it('skips when suggestedChanges JSON has empty changes array', async () => {
      const proposal = {
        id: 'ep-empty-changes',
        type: 'enhance',
        targetRecipeId: 'r-001',
        evidence: [
          {
            suggestedChanges: JSON.stringify({
              patchVersion: 1,
              changes: [],
              reasoning: 'no changes',
            }),
          },
        ],
      };

      const result = await patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(false);
      expect(result.skipped).toBe(true);
    });

    it('skips when suggestedChanges text is too short', async () => {
      const proposal = {
        id: 'ep-short',
        type: 'enhance',
        targetRecipeId: 'r-001',
        evidence: [{ suggestedChanges: 'too short' }],
      };

      const result = await patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(false);
      expect(result.skipped).toBe(true);
    });
  });

  describe('applyProposal — field whitelist', () => {
    it('skips non-patchable fields', async () => {
      const proposal = {
        id: 'ep-illegal',
        type: 'enhance',
        targetRecipeId: 'r-001',
        evidence: [
          {
            suggestedChanges: JSON.stringify({
              patchVersion: 1,
              changes: [
                { field: 'id', action: 'replace', newValue: 'hacked-id' },
                { field: 'lifecycle', action: 'replace', newValue: 'active' },
                { field: 'coreCode', action: 'replace', newValue: 'func safe() {}' },
              ],
              reasoning: 'test',
            }),
          },
        ],
      };

      const result = await patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(true);
      // Only coreCode should be patched, id and lifecycle should be skipped
      expect(result.fieldsPatched).toEqual(['coreCode']);
    });
  });

  describe('applyProposal — snapshots', () => {
    it('creates before and after snapshots', async () => {
      const proposal = makeProposal();
      const result = await patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.beforeSnapshot).toBeDefined();
      expect(result.afterSnapshot).toBeDefined();

      // Before snapshot matches original
      expect(result.beforeSnapshot.coreCode).toBe('func original() {}');
      expect(result.beforeSnapshot.doClause).toBe('Use original pattern');
      expect(result.beforeSnapshot.sourceRefs).toEqual([]);

      // After snapshot reflects patch
      expect(result.afterSnapshot.coreCode).toBe('func updated() {}');
    });
  });

  describe('applyProposal — DB persistence', () => {
    it('persists updated recipe to repo', async () => {
      const proposal = makeProposal();
      await patcher.applyProposal(proposal, 'agent-suggestion');

      // Verify update was called
      expect(mockRepo.update).toHaveBeenCalled();
      expect(mockRepo.updates.length).toBeGreaterThan(0);
      const updateCall = mockRepo.updates[0];
      expect(updateCall.id).toBe('r-001');
      expect(updateCall.data.coreCode).toBe('func updated() {}');
    });
  });
});
