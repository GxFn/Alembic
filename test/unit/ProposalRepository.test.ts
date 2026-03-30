/**
 * ProposalRepository 单元测试
 *
 * 使用 mock DB 验证 CRUD 操作、去重、状态自动分级、过滤查询等。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CreateProposalInput,
  ProposalRepository,
  type ProposalStatus,
  type ProposalType,
} from '../../lib/repository/evolution/ProposalRepository.js';

/* ── Mock DB factory ── */

function createMockDb() {
  const rows: Record<string, unknown>[] = [];
  const runFn = vi.fn(() => ({ changes: 1 }));
  const allFn = vi.fn((..._args: unknown[]) => rows);
  const getFn = vi.fn((..._args: unknown[]) => undefined as Record<string, unknown> | undefined);

  const prepare = vi.fn(() => ({
    run: runFn,
    all: allFn,
    get: getFn,
  }));

  return { prepare, runFn, allFn, getFn, rows };
}

function makeInput(overrides: Partial<CreateProposalInput> = {}): CreateProposalInput {
  return {
    type: 'merge',
    targetRecipeId: 'r-001',
    confidence: 0.85,
    source: 'ide-agent',
    description: 'Test merge proposal',
    ...overrides,
  };
}

describe('ProposalRepository', () => {
  let db: ReturnType<typeof createMockDb>;
  let repo: ProposalRepository;

  beforeEach(() => {
    db = createMockDb();
    repo = new ProposalRepository(db);
  });

  describe('create', () => {
    it('creates a proposal and returns a ProposalRecord', () => {
      // getFn returns undefined (no duplicate)
      db.getFn.mockReturnValue(undefined);

      const result = repo.create(makeInput());

      expect(result).not.toBeNull();
      expect(result?.id).toMatch(/^ep-\d+-[0-9a-f]+$/);
      expect(result?.type).toBe('merge');
      expect(result?.targetRecipeId).toBe('r-001');
      expect(result?.confidence).toBe(0.85);
      expect(result?.source).toBe('ide-agent');
      expect(result?.description).toBe('Test merge proposal');
      expect(result?.relatedRecipeIds).toEqual([]);
      expect(result?.evidence).toEqual([]);
      expect(result?.resolvedAt).toBeNull();
      expect(result?.resolvedBy).toBeNull();
      expect(result?.resolution).toBeNull();

      // DB insert called
      expect(db.runFn).toHaveBeenCalledTimes(1);
    });

    it('returns null when duplicate exists (same target + type pending/observing)', () => {
      // Simulate existing row
      db.getFn.mockReturnValue({ id: 'ep-existing' });

      const result = repo.create(makeInput());
      expect(result).toBeNull();
      // No INSERT
      expect(db.runFn).not.toHaveBeenCalled();
    });

    it('auto-resolves to observing when confidence >= threshold (merge: 0.75)', () => {
      db.getFn.mockReturnValue(undefined);

      const result = repo.create(makeInput({ type: 'merge', confidence: 0.8 }));
      expect(result?.status).toBe('observing');
    });

    it('auto-resolves to pending when confidence < threshold (merge: 0.75)', () => {
      db.getFn.mockReturnValue(undefined);

      const result = repo.create(makeInput({ type: 'merge', confidence: 0.5 }));
      expect(result?.status).toBe('pending');
    });

    it('enhance auto-observes at confidence >= 0.7', () => {
      db.getFn.mockReturnValue(undefined);

      const result = repo.create(makeInput({ type: 'enhance', confidence: 0.7 }));
      expect(result?.status).toBe('observing');
    });

    it('contradiction always starts as pending (threshold = Infinity)', () => {
      db.getFn.mockReturnValue(undefined);

      const result = repo.create(makeInput({ type: 'contradiction', confidence: 0.99 }));
      expect(result?.status).toBe('pending');
    });

    it('reorganize always starts as pending (threshold = Infinity)', () => {
      db.getFn.mockReturnValue(undefined);

      const result = repo.create(makeInput({ type: 'reorganize', confidence: 0.99 }));
      expect(result?.status).toBe('pending');
    });

    it('allows explicit status override', () => {
      db.getFn.mockReturnValue(undefined);

      const result = repo.create(makeInput({ status: 'pending', confidence: 0.99 }));
      expect(result?.status).toBe('pending');
    });

    it('allows explicit expiresAt override', () => {
      db.getFn.mockReturnValue(undefined);

      const customExpiry = Date.now() + 1000;
      const result = repo.create(makeInput({ expiresAt: customExpiry }));
      expect(result?.expiresAt).toBe(customExpiry);
    });

    it('sets type-specific observation windows', () => {
      db.getFn.mockReturnValue(undefined);

      const before = Date.now();
      const result = repo.create(makeInput({ type: 'correction', confidence: 0.8 }));
      // correction: 24h
      expect(result?.expiresAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 100);
      expect(result?.expiresAt).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000 + 100);
    });

    it('stores relatedRecipeIds and evidence', () => {
      db.getFn.mockReturnValue(undefined);

      const result = repo.create(
        makeInput({
          relatedRecipeIds: ['r-002', 'r-003'],
          evidence: [{ snapshotAt: 12345, reason: 'test' }],
        })
      );
      expect(result?.relatedRecipeIds).toEqual(['r-002', 'r-003']);
      expect(result?.evidence).toEqual([{ snapshotAt: 12345, reason: 'test' }]);
    });

    it('covers all 7 proposal types', () => {
      db.getFn.mockReturnValue(undefined);

      const types: ProposalType[] = [
        'merge',
        'supersede',
        'enhance',
        'deprecate',
        'reorganize',
        'contradiction',
        'correction',
      ];
      for (const type of types) {
        const result = repo.create(makeInput({ type, confidence: 0.5 }));
        expect(result).not.toBeNull();
        expect(result?.type).toBe(type);
      }
    });
  });

  describe('findById', () => {
    it('returns null when row not found', () => {
      db.getFn.mockReturnValue(undefined);

      const result = repo.findById('ep-nonexistent');
      expect(result).toBeNull();
    });

    it('maps DB row to ProposalRecord', () => {
      db.getFn.mockReturnValue({
        id: 'ep-123',
        type: 'merge',
        target_recipe_id: 'r-001',
        related_recipe_ids: '["r-002"]',
        confidence: 0.8,
        source: 'ide-agent',
        description: 'test',
        evidence: '[{"reason":"test"}]',
        status: 'observing',
        proposed_at: 1000,
        expires_at: 2000,
        resolved_at: null,
        resolved_by: null,
        resolution: null,
      });

      const result = repo.findById('ep-123');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('ep-123');
      expect(result?.relatedRecipeIds).toEqual(['r-002']);
      expect(result?.evidence).toEqual([{ reason: 'test' }]);
      expect(result?.status).toBe('observing');
    });
  });

  describe('find (filters)', () => {
    it('builds WHERE clause from filter', () => {
      db.allFn.mockReturnValue([]);

      repo.find({ status: 'observing', type: 'merge', targetRecipeId: 'r-001' });

      // prepare should be called with SQL containing WHERE
      const sql = db.prepare.mock.calls.at(-1)?.[0] as string;
      expect(sql).toContain('status = ?');
      expect(sql).toContain('type = ?');
      expect(sql).toContain('target_recipe_id = ?');
    });

    it('supports array status filter', () => {
      db.allFn.mockReturnValue([]);

      repo.find({ status: ['pending', 'observing'] });

      const sql = db.prepare.mock.calls.at(-1)?.[0] as string;
      expect(sql).toContain('status IN (?, ?)');
    });

    it('supports expiredBefore filter', () => {
      db.allFn.mockReturnValue([]);

      repo.find({ expiredBefore: 5000 });

      const sql = db.prepare.mock.calls.at(-1)?.[0] as string;
      expect(sql).toContain('expires_at <= ?');
    });
  });

  describe('findExpiredObserving', () => {
    it('queries observing proposals expired before now', () => {
      db.allFn.mockReturnValue([]);

      repo.findExpiredObserving();

      const sql = db.prepare.mock.calls.at(-1)?.[0] as string;
      expect(sql).toContain('status = ?');
      expect(sql).toContain('expires_at <= ?');
    });
  });

  describe('findActive', () => {
    it('queries pending + observing proposals', () => {
      db.allFn.mockReturnValue([]);

      repo.findActive();

      const sql = db.prepare.mock.calls.at(-1)?.[0] as string;
      expect(sql).toContain('status IN (?, ?)');
    });
  });

  describe('findByTarget', () => {
    it('queries by target + active status', () => {
      db.allFn.mockReturnValue([]);

      repo.findByTarget('r-001');

      const sql = db.prepare.mock.calls.at(-1)?.[0] as string;
      expect(sql).toContain('target_recipe_id = ?');
      expect(sql).toContain('status IN (?, ?)');
    });
  });

  describe('startObserving', () => {
    it('transitions pending → observing', () => {
      db.getFn.mockReturnValue({
        id: 'ep-1',
        type: 'merge',
        target_recipe_id: 'r-001',
        related_recipe_ids: '[]',
        confidence: 0.8,
        source: 'ide-agent',
        description: '',
        evidence: '[]',
        status: 'pending',
        proposed_at: 1000,
        expires_at: 2000,
        resolved_at: null,
        resolved_by: null,
        resolution: null,
      });
      db.runFn.mockReturnValue({ changes: 1 });

      const result = repo.startObserving('ep-1');
      expect(result).toBe(true);
    });

    it('returns false for non-pending proposal', () => {
      db.getFn.mockReturnValue({
        id: 'ep-1',
        type: 'merge',
        target_recipe_id: 'r-001',
        related_recipe_ids: '[]',
        confidence: 0.8,
        source: 'ide-agent',
        description: '',
        evidence: '[]',
        status: 'observing',
        proposed_at: 1000,
        expires_at: 2000,
        resolved_at: null,
        resolved_by: null,
        resolution: null,
      });

      const result = repo.startObserving('ep-1');
      expect(result).toBe(false);
    });

    it('returns false for nonexistent proposal', () => {
      db.getFn.mockReturnValue(undefined);

      const result = repo.startObserving('ep-none');
      expect(result).toBe(false);
    });
  });

  describe('markExecuted', () => {
    it('updates status to executed', () => {
      db.runFn.mockReturnValue({ changes: 1 });

      const result = repo.markExecuted('ep-1', 'FP ok, usage ok');
      expect(result).toBe(true);

      const sql = db.prepare.mock.calls.at(-1)?.[0] as string;
      expect(sql).toContain("status = 'executed'");
      expect(sql).toContain("status = 'observing'");
    });

    it('returns false when no row updated', () => {
      db.runFn.mockReturnValue({ changes: 0 });

      const result = repo.markExecuted('ep-none', 'test');
      expect(result).toBe(false);
    });
  });

  describe('markRejected', () => {
    it('updates status to rejected', () => {
      db.runFn.mockReturnValue({ changes: 1 });

      const result = repo.markRejected('ep-1', 'FP too high');
      expect(result).toBe(true);

      const sql = db.prepare.mock.calls.at(-1)?.[0] as string;
      expect(sql).toContain("status = 'rejected'");
    });
  });

  describe('markExpired', () => {
    it('updates status to expired', () => {
      db.runFn.mockReturnValue({ changes: 1 });

      const result = repo.markExpired('ep-1');
      expect(result).toBe(true);

      const sql = db.prepare.mock.calls.at(-1)?.[0] as string;
      expect(sql).toContain("status = 'expired'");
    });
  });

  describe('updateEvidence', () => {
    it('updates evidence JSON', () => {
      db.runFn.mockReturnValue({ changes: 1 });

      const result = repo.updateEvidence('ep-1', [{ newSnapshot: true }]);
      expect(result).toBe(true);
    });
  });

  describe('stats', () => {
    it('returns counts per status', () => {
      db.allFn.mockReturnValue([
        { status: 'pending', count: 3 },
        { status: 'observing', count: 2 },
        { status: 'executed', count: 5 },
      ]);

      const result = repo.stats();
      expect(result.pending).toBe(3);
      expect(result.observing).toBe(2);
      expect(result.executed).toBe(5);
      expect(result.rejected).toBe(0);
      expect(result.expired).toBe(0);
    });

    it('returns all zeros when empty', () => {
      db.allFn.mockReturnValue([]);

      const result = repo.stats();
      const allStatuses: ProposalStatus[] = [
        'pending',
        'observing',
        'executed',
        'rejected',
        'expired',
      ];
      for (const s of allStatuses) {
        expect(result[s]).toBe(0);
      }
    });
  });
});
