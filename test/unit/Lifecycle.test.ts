/**
 * 六态 Lifecycle 单元测试
 */
import { describe, expect, it } from 'vitest';
import Lifecycle, {
  CANDIDATE_STATES,
  CONSUMABLE_STATES,
  DEGRADED_STATES,
  isCandidate,
  isConsumable,
  isDegraded,
  isValidLifecycle,
  isValidTransition,
  normalizeLifecycle,
} from '../../lib/domain/knowledge/Lifecycle.js';

describe('Lifecycle — 六态状态机', () => {
  it('should define 6 states', () => {
    expect(Object.values(Lifecycle)).toHaveLength(6);
    expect(Lifecycle.PENDING).toBe('pending');
    expect(Lifecycle.STAGING).toBe('staging');
    expect(Lifecycle.ACTIVE).toBe('active');
    expect(Lifecycle.EVOLVING).toBe('evolving');
    expect(Lifecycle.DECAYING).toBe('decaying');
    expect(Lifecycle.DEPRECATED).toBe('deprecated');
  });

  it('should validate all 6 states', () => {
    for (const state of Object.values(Lifecycle)) {
      expect(isValidLifecycle(state)).toBe(true);
    }
    expect(isValidLifecycle('unknown')).toBe(false);
  });

  it('should normalize unknown states to pending', () => {
    expect(normalizeLifecycle('staging')).toBe('staging');
    expect(normalizeLifecycle('evolving')).toBe('evolving');
    expect(normalizeLifecycle('decaying')).toBe('decaying');
    expect(normalizeLifecycle('invalid')).toBe('pending');
  });

  describe('transition table', () => {
    const validTransitions = [
      ['pending', 'staging'],
      ['pending', 'active'],
      ['pending', 'deprecated'],
      ['staging', 'active'],
      ['staging', 'pending'],
      ['active', 'evolving'],
      ['active', 'decaying'],
      ['active', 'deprecated'],
      ['evolving', 'active'],
      ['evolving', 'decaying'],
      ['decaying', 'active'],
      ['decaying', 'deprecated'],
      ['deprecated', 'pending'],
    ];

    for (const [from, to] of validTransitions) {
      it(`${from} → ${to} should be valid`, () => {
        expect(isValidTransition(from, to)).toBe(true);
      });
    }

    const invalidTransitions = [
      ['pending', 'evolving'],
      ['pending', 'decaying'],
      ['staging', 'deprecated'],
      ['staging', 'evolving'],
      ['active', 'staging'],
      ['active', 'pending'],
      ['evolving', 'deprecated'],
      ['evolving', 'pending'],
      ['decaying', 'evolving'],
      ['decaying', 'pending'],
      ['deprecated', 'active'],
      ['deprecated', 'staging'],
    ];

    for (const [from, to] of invalidTransitions) {
      it(`${from} → ${to} should be invalid`, () => {
        expect(isValidTransition(from, to)).toBe(false);
      });
    }
  });

  it('CANDIDATE_STATES includes pending and staging', () => {
    expect(CANDIDATE_STATES).toContain('pending');
    expect(CANDIDATE_STATES).toContain('staging');
    expect(CANDIDATE_STATES).toHaveLength(2);
  });

  it('CONSUMABLE_STATES includes staging, active, evolving', () => {
    expect(CONSUMABLE_STATES).toContain('staging');
    expect(CONSUMABLE_STATES).toContain('active');
    expect(CONSUMABLE_STATES).toContain('evolving');
    expect(CONSUMABLE_STATES).toHaveLength(3);
  });

  it('DEGRADED_STATES includes only decaying', () => {
    expect(DEGRADED_STATES).toContain('decaying');
    expect(DEGRADED_STATES).toHaveLength(1);
  });

  it('isCandidate returns true for pending and staging', () => {
    expect(isCandidate('pending')).toBe(true);
    expect(isCandidate('staging')).toBe(true);
    expect(isCandidate('active')).toBe(false);
  });

  it('isConsumable returns true for staging, active, evolving', () => {
    expect(isConsumable('staging')).toBe(true);
    expect(isConsumable('active')).toBe(true);
    expect(isConsumable('evolving')).toBe(true);
    expect(isConsumable('pending')).toBe(false);
    expect(isConsumable('decaying')).toBe(false);
    expect(isConsumable('deprecated')).toBe(false);
  });

  it('isDegraded returns true only for decaying', () => {
    expect(isDegraded('decaying')).toBe(true);
    expect(isDegraded('active')).toBe(false);
    expect(isDegraded('deprecated')).toBe(false);
  });
});
