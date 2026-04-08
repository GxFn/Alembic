/**
 * ContentPatcher 单元测试
 *
 * Mock DB，验证:
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

const DEFAULT_RECIPE = {
  id: 'r-001',
  title: 'Test Recipe',
  coreCode: 'func original() {}',
  doClause: 'Use original pattern',
  dontClause: 'Do not skip validation',
  whenClause: 'When creating instances',
  content: JSON.stringify({
    markdown: '### 使用指南\nOriginal guide\n\n### 示例\nSome example',
    rationale: 'Original rationale',
  }),
  sourceRefs: JSON.stringify(['src/original.swift']),
  headers: JSON.stringify(['import UIKit']),
};

function createMockDb(recipe?: typeof DEFAULT_RECIPE) {
  const recipeData = recipe ?? { ...DEFAULT_RECIPE };
  const updates: { sql: string; args: unknown[] }[] = [];

  return {
    recipeData,
    updates,
    prepare: vi.fn((sql: string) => {
      // SELECT recipe fields
      if (sql.includes('SELECT id, title, coreCode')) {
        return {
          all: vi.fn(),
          get: vi.fn((...args: unknown[]) => {
            const id = args[0] as string;
            return id === recipeData.id ? { ...recipeData } : undefined;
          }),
          run: vi.fn(() => ({ changes: 1 })),
        };
      }

      // UPDATE knowledge_entries
      if (sql.includes('UPDATE knowledge_entries')) {
        return {
          all: vi.fn(),
          get: vi.fn(),
          run: vi.fn((...args: unknown[]) => {
            updates.push({ sql, args: [...args] });
            // Update in-memory for subsequent reads
            if (sql.includes('coreCode')) {
              recipeData.coreCode = args[0] as string;
              recipeData.doClause = args[1] as string;
              recipeData.dontClause = args[2] as string;
              recipeData.whenClause = args[3] as string;
              recipeData.content = args[4] as string;
              recipeData.sourceRefs = args[5] as string;
              recipeData.headers = args[6] as string;
            }
            return { changes: 1 };
          }),
        };
      }

      return {
        all: vi.fn(() => []),
        get: vi.fn(() => undefined),
        run: vi.fn(() => ({ changes: 0 })),
      };
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
  let db: ReturnType<typeof createMockDb>;
  let patcher: ContentPatcher;

  beforeEach(() => {
    db = createMockDb();
    patcher = new ContentPatcher(db);
  });

  describe('applyProposal — structured JSON patch', () => {
    it('applies coreCode replacement', () => {
      const proposal = makeProposal();
      const result = patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.fieldsPatched).toContain('coreCode');
      expect(result.beforeSnapshot.coreCode).toBe('func original() {}');
      expect(result.afterSnapshot.coreCode).toBe('func updated() {}');
    });

    it('applies multiple field changes', () => {
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

      const result = patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(true);
      expect(result.fieldsPatched).toHaveLength(3);
      expect(result.fieldsPatched).toContain('coreCode');
      expect(result.fieldsPatched).toContain('doClause');
      expect(result.fieldsPatched).toContain('whenClause');
    });

    it('applies content.markdown replacement', () => {
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

      const result = patcher.applyProposal(proposal, 'correction');

      expect(result.success).toBe(true);
      expect(result.fieldsPatched).toContain('content.markdown');
      expect(result.patchSource).toBe('correction');
    });

    it('applies content.markdown section replacement', () => {
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

      const result = patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(true);
      expect(result.fieldsPatched).toContain('content.markdown');
      // Verify section was replaced but other sections preserved
      const content = JSON.parse(db.recipeData.content);
      expect(content.markdown).toContain('Updated guide content');
      expect(content.markdown).toContain('### 示例'); // other section preserved
    });

    it('applies sourceRefs replacement', () => {
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

      const result = patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(true);
      expect(result.fieldsPatched).toContain('sourceRefs');
      expect(result.afterSnapshot.sourceRefs).toEqual(['src/new-location.swift']);
    });

    it('applies append action', () => {
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

      const result = patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(true);
      expect(result.fieldsPatched).toContain('content.rationale');
    });
  });

  describe('applyProposal — fallback text patch', () => {
    it('falls back to content.markdown replacement for non-JSON text', () => {
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

      const result = patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(true);
      expect(result.fieldsPatched).toContain('content.markdown');
    });
  });

  describe('applyProposal — skip conditions', () => {
    it('skips when recipe not found', () => {
      const proposal = {
        id: 'ep-missing',
        type: 'enhance',
        targetRecipeId: 'r-nonexistent',
        evidence: [{ suggestedChanges: '{"changes":[]}' }],
      };

      const result = patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('not found');
    });

    it('skips when no suggestedChanges in evidence', () => {
      const proposal = {
        id: 'ep-nochanges',
        type: 'enhance',
        targetRecipeId: 'r-001',
        evidence: [{ sourceStatus: 'modified', currentCode: 'func foo() {}' }],
      };

      const result = patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('No suggestedChanges');
    });

    it('skips when suggestedChanges is empty string', () => {
      const proposal = {
        id: 'ep-empty',
        type: 'enhance',
        targetRecipeId: 'r-001',
        evidence: [{ suggestedChanges: '' }],
      };

      const result = patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(false);
      expect(result.skipped).toBe(true);
    });

    it('skips when suggestedChanges JSON has empty changes array', () => {
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

      const result = patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(false);
      expect(result.skipped).toBe(true);
    });

    it('skips when suggestedChanges text is too short', () => {
      const proposal = {
        id: 'ep-short',
        type: 'enhance',
        targetRecipeId: 'r-001',
        evidence: [{ suggestedChanges: 'too short' }],
      };

      const result = patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(false);
      expect(result.skipped).toBe(true);
    });
  });

  describe('applyProposal — field whitelist', () => {
    it('skips non-patchable fields', () => {
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

      const result = patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.success).toBe(true);
      // Only coreCode should be patched, id and lifecycle should be skipped
      expect(result.fieldsPatched).toEqual(['coreCode']);
    });
  });

  describe('applyProposal — snapshots', () => {
    it('creates before and after snapshots', () => {
      const proposal = makeProposal();
      const result = patcher.applyProposal(proposal, 'agent-suggestion');

      expect(result.beforeSnapshot).toBeDefined();
      expect(result.afterSnapshot).toBeDefined();

      // Before snapshot matches original
      expect(result.beforeSnapshot.coreCode).toBe('func original() {}');
      expect(result.beforeSnapshot.doClause).toBe('Use original pattern');
      expect(result.beforeSnapshot.sourceRefs).toEqual(['src/original.swift']);

      // After snapshot reflects patch
      expect(result.afterSnapshot.coreCode).toBe('func updated() {}');
    });
  });

  describe('applyProposal — DB persistence', () => {
    it('persists updated recipe to DB', () => {
      const proposal = makeProposal();
      patcher.applyProposal(proposal, 'agent-suggestion');

      // Verify UPDATE was called
      expect(db.updates.length).toBeGreaterThan(0);
      const updateCall = db.updates.find((u) => u.sql.includes('coreCode'));
      expect(updateCall).toBeDefined();
    });
  });
});
