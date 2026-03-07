/**
 * 集成测试：KnowledgeEntry 领域模型 + Lifecycle 状态机
 *
 * 覆盖范围:
 *   - KnowledgeEntry 构造 & 默认值
 *   - Lifecycle 状态流转: pending → active → deprecated → pending
 *   - 无效转移拒绝
 *   - kind 推断 (knowledgeType → rule / pattern / fact)
 *   - normalizeLifecycle
 *   - isCandidate / isValidLifecycle
 *   - KnowledgeEntry 值对象整合
 */

import { KnowledgeEntry } from '../../lib/domain/knowledge/KnowledgeEntry.js';
import {
  inferKind,
  isCandidate,
  isValidLifecycle,
  isValidTransition,
  Lifecycle,
  normalizeLifecycle,
} from '../../lib/domain/knowledge/Lifecycle.js';

describe('Integration: KnowledgeEntry & Lifecycle', () => {
  // ─── Lifecycle State Machine ─────────────────

  describe('Lifecycle constants', () => {
    test('should have three states', () => {
      expect(Lifecycle.PENDING).toBe('pending');
      expect(Lifecycle.ACTIVE).toBe('active');
      expect(Lifecycle.DEPRECATED).toBe('deprecated');
    });
  });

  describe('Valid transitions', () => {
    const validCases: [string, string][] = [
      [Lifecycle.PENDING, Lifecycle.ACTIVE],
      [Lifecycle.PENDING, Lifecycle.DEPRECATED],
      [Lifecycle.ACTIVE, Lifecycle.DEPRECATED],
      [Lifecycle.DEPRECATED, Lifecycle.PENDING],
    ];

    test.each(validCases)('%s → %s should be valid', (from, to) => {
      expect(isValidTransition(from, to)).toBe(true);
    });
  });

  describe('Invalid transitions', () => {
    const invalidCases: [string, string][] = [
      [Lifecycle.ACTIVE, Lifecycle.PENDING],
      [Lifecycle.DEPRECATED, Lifecycle.ACTIVE],
      [Lifecycle.PENDING, Lifecycle.PENDING],
      [Lifecycle.ACTIVE, Lifecycle.ACTIVE],
    ];

    test.each(invalidCases)('%s → %s should be invalid', (from, to) => {
      expect(isValidTransition(from, to)).toBe(false);
    });
  });

  describe('normalizeLifecycle', () => {
    test('should pass through valid lifecycle values', () => {
      expect(normalizeLifecycle('pending')).toBe('pending');
      expect(normalizeLifecycle('active')).toBe('active');
      expect(normalizeLifecycle('deprecated')).toBe('deprecated');
    });

    test('should default invalid values to pending', () => {
      expect(normalizeLifecycle('invalid')).toBe('pending');
      expect(normalizeLifecycle('')).toBe('pending');
      expect(normalizeLifecycle('draft')).toBe('pending');
    });
  });

  describe('isValidLifecycle', () => {
    test('should accept valid states', () => {
      expect(isValidLifecycle('pending')).toBe(true);
      expect(isValidLifecycle('active')).toBe(true);
      expect(isValidLifecycle('deprecated')).toBe(true);
    });

    test('should reject invalid states', () => {
      expect(isValidLifecycle('draft')).toBe(false);
      expect(isValidLifecycle('archived')).toBe(false);
    });
  });

  describe('isCandidate', () => {
    test('should identify pending as candidate', () => {
      expect(isCandidate('pending')).toBe(true);
    });

    test('should not identify active/deprecated as candidate', () => {
      expect(isCandidate('active')).toBe(false);
      expect(isCandidate('deprecated')).toBe(false);
    });
  });

  describe('inferKind', () => {
    test('should infer rule kind', () => {
      expect(inferKind('code-standard')).toBe('rule');
      expect(inferKind('code-style')).toBe('rule');
      expect(inferKind('best-practice')).toBe('rule');
      expect(inferKind('boundary-constraint')).toBe('rule');
    });

    test('should infer pattern kind', () => {
      expect(inferKind('code-pattern')).toBe('pattern');
      expect(inferKind('architecture')).toBe('pattern');
      expect(inferKind('solution')).toBe('pattern');
      expect(inferKind('anti-pattern')).toBe('pattern');
    });

    test('should infer fact kind', () => {
      expect(inferKind('code-relation')).toBe('fact');
      expect(inferKind('inheritance')).toBe('fact');
      expect(inferKind('call-chain')).toBe('fact');
      expect(inferKind('data-flow')).toBe('fact');
      expect(inferKind('module-dependency')).toBe('fact');
      expect(inferKind('dev-document')).toBe('fact');
    });

    test('should default to pattern for unknown types', () => {
      expect(inferKind('unknown-type')).toBe('pattern');
    });
  });

  // ─── KnowledgeEntry Domain Model ─────────────

  describe('KnowledgeEntry construction', () => {
    test('should create with defaults', () => {
      const entry = new KnowledgeEntry();
      expect(entry.id).toBeDefined();
      expect(entry.title).toBe('');
      expect(entry.lifecycle).toBe('pending');
      expect(entry.knowledgeType).toBe('code-pattern');
      expect(entry.kind).toBe('pattern');
      expect(entry.complexity).toBe('intermediate');
      expect(entry.tags).toEqual([]);
      expect(entry.createdAt).toBeDefined();
    });

    test('should create with provided values', () => {
      const entry = new KnowledgeEntry({
        id: 'test-id-1',
        title: 'My Pattern',
        description: 'A useful pattern',
        lifecycle: 'active',
        language: 'typescript',
        category: 'architecture',
        knowledgeType: 'best-practice',
        tags: ['ts', 'architecture'],
        trigger: 'when building services',
      });

      expect(entry.id).toBe('test-id-1');
      expect(entry.title).toBe('My Pattern');
      expect(entry.lifecycle).toBe('active');
      expect(entry.language).toBe('typescript');
      expect(entry.kind).toBe('rule'); // best-practice → rule
      expect(entry.tags).toEqual(['ts', 'architecture']);
    });

    test('should normalize invalid lifecycle to pending', () => {
      const entry = new KnowledgeEntry({ lifecycle: 'bogus' });
      expect(entry.lifecycle).toBe('pending');
    });

    test('should auto-infer kind from knowledgeType', () => {
      const rule = new KnowledgeEntry({ knowledgeType: 'boundary-constraint' });
      expect(rule.kind).toBe('rule');

      const fact = new KnowledgeEntry({ knowledgeType: 'code-relation' });
      expect(fact.kind).toBe('fact');

      const pattern = new KnowledgeEntry({ knowledgeType: 'architecture' });
      expect(pattern.kind).toBe('pattern');
    });
  });

  describe('KnowledgeEntry lifecycle transitions', () => {
    test('should track lifecycle transitions', () => {
      const entry = new KnowledgeEntry({ lifecycle: 'pending' });
      expect(entry.lifecycle).toBe('pending');

      // 模拟 publish (pending → active)
      expect(isValidTransition(entry.lifecycle, 'active')).toBe(true);
    });

    test('should preserve lifecycle history', () => {
      const entry = new KnowledgeEntry({
        lifecycleHistory: [{ from: 'pending', to: 'active', at: Date.now() - 1000 }],
      });
      expect(entry.lifecycleHistory).toHaveLength(1);
      expect(entry.lifecycleHistory[0].from).toBe('pending');
    });
  });

  describe('KnowledgeEntry value objects', () => {
    test('should initialize Content value object', () => {
      const entry = new KnowledgeEntry();
      expect(entry.content).toBeDefined();
    });

    test('should initialize Relations value object', () => {
      const entry = new KnowledgeEntry();
      expect(entry.relations).toBeDefined();
    });

    test('should initialize Constraints value object', () => {
      const entry = new KnowledgeEntry();
      expect(entry.constraints).toBeDefined();
    });

    test('should initialize Quality value object', () => {
      const entry = new KnowledgeEntry();
      expect(entry.quality).toBeDefined();
    });

    test('should initialize Stats value object', () => {
      const entry = new KnowledgeEntry();
      expect(entry.stats).toBeDefined();
    });
  });

  describe('KnowledgeEntry metadata', () => {
    test('should have timestamp fields', () => {
      const entry = new KnowledgeEntry();
      // createdAt/updatedAt 可能是 unix seconds 或 ms
      expect(entry.createdAt).toBeGreaterThan(0);
      expect(entry.updatedAt).toBeGreaterThan(0);
      // 确保 createdAt 和 updatedAt 一致
      expect(entry.updatedAt).toBeGreaterThanOrEqual(entry.createdAt);
    });

    test('should support source tracking', () => {
      const entry = new KnowledgeEntry({
        source: 'agent-scan',
        sourceFile: 'src/auth.ts',
        createdBy: 'insight-agent',
      });
      expect(entry.source).toBe('agent-scan');
      expect(entry.sourceFile).toBe('src/auth.ts');
      expect(entry.createdBy).toBe('insight-agent');
    });
  });
});
