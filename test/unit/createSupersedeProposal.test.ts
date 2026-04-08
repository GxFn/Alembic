/**
 * createSupersedeProposal 单元测试
 *
 * 验证统一的 supersede 提案创建逻辑在各种条件下的行为。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSupersedeProposal,
  type SupersedeInput,
} from '../../lib/service/evolution/createSupersedeProposal.js';

/* ── Mock factories ── */

function createMockProposalRepo(createResult: unknown = null) {
  return {
    create: vi.fn(() => createResult),
  };
}

function createMockDb(recipeExists = true) {
  return {
    getDb: () => ({
      prepare: () => ({
        get: () => (recipeExists ? { id: 'old-recipe-1' } : undefined),
      }),
    }),
  };
}

function createMockContainer(
  options: {
    recipeExists?: boolean;
    proposalRepoAvailable?: boolean;
    proposalResult?: unknown;
  } = {}
) {
  const {
    recipeExists = true,
    proposalRepoAvailable = true,
    proposalResult = {
      id: 'ep-1234-abc',
      type: 'supersede',
      status: 'observing',
      expiresAt: Date.now() + 72 * 60 * 60 * 1000,
    },
  } = options;

  const proposalRepo = proposalRepoAvailable ? createMockProposalRepo(proposalResult) : null;
  const db = createMockDb(recipeExists);

  return {
    get: vi.fn((name: string) => {
      if (name === 'proposalRepository') {
        return proposalRepo;
      }
      if (name === 'database') {
        return db;
      }
      return null;
    }),
    _proposalRepo: proposalRepo,
  };
}

function makeInput(overrides: Partial<SupersedeInput> = {}): SupersedeInput {
  return {
    oldRecipeId: 'old-recipe-1',
    newRecipeIds: ['new-recipe-1'],
    ...overrides,
  };
}

/* ── Tests ── */

describe('createSupersedeProposal', () => {
  it('creates a supersede proposal when all conditions are met', () => {
    const container = createMockContainer();
    const result = createSupersedeProposal(container, makeInput());

    expect(result).not.toBeNull();
    expect(result?.type).toBe('supersede');
    expect(result?.proposalId).toBe('ep-1234-abc');
    expect(result?.targetRecipe.id).toBe('old-recipe-1');
    expect(result?.status).toBe('observing');
    expect(result?.message).toContain('替代提案');

    // Verify ProposalRepository.create was called with correct args
    expect(container._proposalRepo?.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'supersede',
        targetRecipeId: 'old-recipe-1',
        relatedRecipeIds: ['new-recipe-1'],
        confidence: 0.8,
        source: 'ide-agent',
      })
    );
  });

  it('returns null when oldRecipeId is empty', () => {
    const container = createMockContainer();
    const result = createSupersedeProposal(container, makeInput({ oldRecipeId: '' }));
    expect(result).toBeNull();
  });

  it('returns null when newRecipeIds is empty', () => {
    const container = createMockContainer();
    const result = createSupersedeProposal(container, makeInput({ newRecipeIds: [] }));
    expect(result).toBeNull();
  });

  it('returns null when ProposalRepository is not registered', () => {
    const container = createMockContainer({ proposalRepoAvailable: false });
    const result = createSupersedeProposal(container, makeInput());
    expect(result).toBeNull();
  });

  it('returns null when old recipe does not exist in DB', () => {
    const container = createMockContainer({ recipeExists: false });
    const result = createSupersedeProposal(container, makeInput());
    expect(result).toBeNull();
  });

  it('returns null when ProposalRepository.create returns null (dedup)', () => {
    const container = createMockContainer({ proposalResult: null });
    const result = createSupersedeProposal(container, makeInput());
    expect(result).toBeNull();
  });

  it('uses custom source and confidence when provided', () => {
    const container = createMockContainer();
    createSupersedeProposal(
      container,
      makeInput({
        source: 'metabolism',
        confidence: 0.95,
      })
    );

    expect(container._proposalRepo?.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'metabolism',
        confidence: 0.95,
      })
    );
  });

  it('handles multiple new recipe IDs', () => {
    const container = createMockContainer();
    createSupersedeProposal(
      container,
      makeInput({
        newRecipeIds: ['new-1', 'new-2', 'new-3'],
      })
    );

    expect(container._proposalRepo?.create).toHaveBeenCalledWith(
      expect.objectContaining({
        relatedRecipeIds: ['new-1', 'new-2', 'new-3'],
      })
    );
  });

  it('tolerates container.get throwing', () => {
    const container = {
      get: vi.fn(() => {
        throw new Error('DI not initialized');
      }),
    };
    const result = createSupersedeProposal(container, makeInput());
    expect(result).toBeNull();
  });

  it('tolerates database.getDb throwing', () => {
    const proposalRepo = createMockProposalRepo({ id: 'ep-x' });
    const container = {
      get: vi.fn((name: string) => {
        if (name === 'proposalRepository') {
          return proposalRepo;
        }
        if (name === 'database') {
          return {
            getDb: () => {
              throw new Error('DB closed');
            },
          };
        }
        return null;
      }),
    };
    const result = createSupersedeProposal(container, makeInput());
    expect(result).toBeNull();
  });

  it('includes evidence with snapshotAt and declaredBy in proposal', () => {
    const before = Date.now();
    const container = createMockContainer();
    createSupersedeProposal(container, makeInput());
    const after = Date.now();

    const callArg = container._proposalRepo?.create.mock.calls[0]?.[0];
    expect(callArg.evidence).toHaveLength(1);
    expect(callArg.evidence[0].snapshotAt).toBeGreaterThanOrEqual(before);
    expect(callArg.evidence[0].snapshotAt).toBeLessThanOrEqual(after);
    expect(callArg.evidence[0].declaredBy).toBe('ide-agent');
    expect(callArg.evidence[0].newRecipeIds).toEqual(['new-recipe-1']);
  });
});
