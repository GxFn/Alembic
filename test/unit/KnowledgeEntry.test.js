import { jest } from '@jest/globals';
import { KnowledgeEntry } from '../../lib/domain/knowledge/KnowledgeEntry.js';
import { Lifecycle, isValidTransition, inferKind } from '../../lib/domain/knowledge/Lifecycle.js';
import { Content } from '../../lib/domain/knowledge/values/Content.js';
import { Relations } from '../../lib/domain/knowledge/values/Relations.js';
import { Constraints } from '../../lib/domain/knowledge/values/Constraints.js';
import { Reasoning } from '../../lib/domain/knowledge/values/Reasoning.js';
import { Quality } from '../../lib/domain/knowledge/values/Quality.js';
import { Stats } from '../../lib/domain/knowledge/values/Stats.js';

/* ════════════════════════════════════════════
 *  值对象测试
 * ════════════════════════════════════════════ */

describe('Content value object', () => {
  test('from(null) returns empty content', () => {
    const c = Content.from(null);
    expect(c.pattern).toBe('');
    expect(c.hasContent()).toBe(false);
  });

  test('from(props) preserves fields', () => {
    const c = Content.from({
      pattern: 'let x = 1',
      rationale: 'idiomatic',
      steps: [{ title: 'step1' }],
      code_changes: [{ file: 'a.js', before: '', after: '', explanation: '' }],
    });
    expect(c.pattern).toBe('let x = 1');
    expect(c.rationale).toBe('idiomatic');
    expect(c.steps).toHaveLength(1);
    expect(c.codeChanges).toHaveLength(1);
    expect(c.hasContent()).toBe(true);
  });

  test('fromLegacyCandidate detects markdown', () => {
    const c = Content.fromLegacyCandidate('# Title\n\nSome content', {});
    expect(c.markdown).toBe('# Title\n\nSome content');
    expect(c.pattern).toBe('');
  });

  test('fromLegacyCandidate keeps code as pattern', () => {
    const c = Content.fromLegacyCandidate('let x = 1', {});
    expect(c.pattern).toBe('let x = 1');
    expect(c.markdown).toBe('');
  });

  test('toJSON → fromJSON round-trip', () => {
    const original = new Content({ pattern: 'abc', rationale: 'why', steps: [{ title: 's' }] });
    const json = original.toJSON();
    const restored = Content.fromJSON(json);
    expect(restored.pattern).toBe('abc');
    expect(restored.rationale).toBe('why');
    expect(restored.steps).toHaveLength(1);
  });
});

describe('Relations value object', () => {
  test('from(null) returns empty', () => {
    const r = Relations.from(null);
    expect(r.isEmpty()).toBe(true);
  });

  test('from(buckets) preserves structure', () => {
    const r = Relations.from({
      extends: [{ target: '@singleton', description: 'base' }],
      depends_on: [{ target: 'lib-x', description: '' }],
    });
    expect(r.getByType('extends')).toHaveLength(1);
    expect(r.getByType('depends_on')).toHaveLength(1);
    expect(r.isEmpty()).toBe(false);
  });

  test('fromFlat converts array to buckets', () => {
    const r = Relations.fromFlat([
      { type: 'extends', target: 'a', description: 'desc' },
      { type: 'related', target: 'b', description: '' },
      { type: 'extends', target: 'c', description: '' },
    ]);
    expect(r.getByType('extends')).toHaveLength(2);
    expect(r.getByType('related')).toHaveLength(1);
  });

  test('add deduplicates by target', () => {
    const r = Relations.from({});
    r.add('extends', 'a', '1st');
    r.add('extends', 'a', '2nd');
    expect(r.getByType('extends')).toHaveLength(1);
  });

  test('toFlatArray returns type-annotated list', () => {
    const r = Relations.from({
      calls: [{ target: 'f1', description: '' }],
      inherits: [{ target: 'c1', description: '' }],
    });
    const flat = r.toFlatArray();
    expect(flat).toHaveLength(2);
    expect(flat.some(x => x.type === 'calls')).toBe(true);
  });

  test('handles legacy camelCase keys', () => {
    const r = Relations.from({
      dependsOn: [{ target: 'x', description: '' }],
      dataFlow: [{ target: 'y', description: '' }],
    });
    expect(r.getByType('depends_on')).toHaveLength(1);
    expect(r.getByType('data_flow')).toHaveLength(1);
  });

  test('toJSON → from round-trip', () => {
    const original = Relations.from({
      extends: [{ target: 'a', description: 'b' }],
    });
    const json = original.toJSON();
    const restored = Relations.from(json);
    expect(restored.getByType('extends')).toEqual([{ target: 'a', description: 'b' }]);
  });
});

describe('Constraints value object', () => {
  test('from(null) returns empty', () => {
    const c = Constraints.from(null);
    expect(c.hasGuards()).toBe(false);
    expect(c.isEmpty()).toBe(true);
  });

  test('normalizes guard with regex type', () => {
    const c = Constraints.from({
      guards: [{ pattern: 'URLSession', message: 'no direct use', severity: 'error' }],
    });
    expect(c.guards[0].type).toBe('regex');
    expect(c.getRegexGuards()).toHaveLength(1);
    expect(c.getAstGuards()).toHaveLength(0);
  });

  test('normalizes guard with ast type', () => {
    const c = Constraints.from({
      guards: [{ ast_query: { language: 'swift' }, message: 'ast rule' }],
    });
    expect(c.guards[0].type).toBe('ast');
    expect(c.getAstGuards()).toHaveLength(1);
  });

  test('handles side_effects snake_case', () => {
    const c = Constraints.from({
      side_effects: ['triggers notification'],
      preconditions: ['import needed'],
    });
    expect(c.sideEffects).toEqual(['triggers notification']);
    expect(c.preconditions).toEqual(['import needed']);
  });

  test('toJSON uses snake_case', () => {
    const c = new Constraints({ sideEffects: ['x'] });
    expect(c.toJSON().side_effects).toEqual(['x']);
  });
});

describe('Reasoning value object', () => {
  test('from(null) returns empty', () => {
    const r = Reasoning.from(null);
    expect(r.whyStandard).toBe('');
    expect(r.isValid()).toBe(false);
  });

  test('accepts snake_case input', () => {
    const r = Reasoning.from({
      why_standard: 'reason',
      sources: ['a.m:10'],
      confidence: 0.9,
      quality_signals: { clarity: 0.8 },
    });
    expect(r.whyStandard).toBe('reason');
    expect(r.qualitySignals.clarity).toBe(0.8);
    expect(r.isValid()).toBe(true);
  });

  test('accepts camelCase input (backward compat)', () => {
    const r = Reasoning.from({
      whyStandard: 'reason',
      sources: ['b.m:5'],
      confidence: 0.85,
    });
    expect(r.whyStandard).toBe('reason');
    expect(r.isValid()).toBe(true);
  });

  test('toJSON outputs snake_case', () => {
    const r = new Reasoning({ whyStandard: 'x', sources: ['y'], confidence: 0.5 });
    const json = r.toJSON();
    expect(json.why_standard).toBe('x');
    expect(json).not.toHaveProperty('whyStandard');
  });
});

describe('Quality value object', () => {
  test('from(null) returns zeros', () => {
    const q = Quality.from(null);
    expect(q.overall).toBe(0);
    expect(q.grade).toBe('F');
  });

  test('calcGrade boundaries', () => {
    expect(Quality.calcGrade(0.95)).toBe('A');
    expect(Quality.calcGrade(0.9)).toBe('A');
    expect(Quality.calcGrade(0.89)).toBe('B');
    expect(Quality.calcGrade(0.75)).toBe('B');
    expect(Quality.calcGrade(0.6)).toBe('C');
    expect(Quality.calcGrade(0.4)).toBe('D');
    expect(Quality.calcGrade(0.39)).toBe('F');
  });

  test('recalculate updates overall+grade', () => {
    const q = new Quality({ completeness: 0.9, adaptation: 0.9, documentation: 0.9 });
    q.recalculate();
    expect(q.overall).toBe(0.9);
    expect(q.grade).toBe('A');
  });

  test('fromLegacyRecipe maps old field names', () => {
    const q = Quality.fromLegacyRecipe({
      codeCompleteness: 0.8,
      projectAdaptation: 0.7,
      documentationClarity: 0.6,
      overall: 0.7,
    });
    expect(q.completeness).toBe(0.8);
    expect(q.adaptation).toBe(0.7);
    expect(q.documentation).toBe(0.6);
  });
});

describe('Stats value object', () => {
  test('from(null) returns zeros', () => {
    const s = Stats.from(null);
    expect(s.views).toBe(0);
    expect(s.guardHits).toBe(0);
  });

  test('accepts snake_case input', () => {
    const s = Stats.from({ guard_hits: 5, search_hits: 10 });
    expect(s.guardHits).toBe(5);
    expect(s.searchHits).toBe(10);
  });

  test('increment', () => {
    const s = new Stats();
    s.increment('views', 3);
    expect(s.views).toBe(3);
  });

  test('toJSON uses snake_case', () => {
    const s = new Stats({ guardHits: 7 });
    expect(s.toJSON().guard_hits).toBe(7);
  });
});

/* ════════════════════════════════════════════
 *  Lifecycle 状态机测试
 * ════════════════════════════════════════════ */

describe('Lifecycle', () => {
  test('inferKind maps correctly', () => {
    expect(inferKind('code-standard')).toBe('rule');
    expect(inferKind('code-pattern')).toBe('pattern');
    expect(inferKind('code-relation')).toBe('fact');
    expect(inferKind('unknown')).toBe('pattern');
  });

  test('valid transitions (3-state model)', () => {
    expect(isValidTransition('pending', 'active')).toBe(true);
    expect(isValidTransition('pending', 'deprecated')).toBe(true);
    expect(isValidTransition('active', 'deprecated')).toBe(true);
    expect(isValidTransition('deprecated', 'pending')).toBe(true);
  });

  test('invalid transitions (3-state model)', () => {
    expect(isValidTransition('pending', 'pending')).toBe(false);
    expect(isValidTransition('active', 'pending')).toBe(false);
    expect(isValidTransition('deprecated', 'active')).toBe(false);
    expect(isValidTransition('deprecated', 'deprecated')).toBe(false);
  });
});

/* ════════════════════════════════════════════
 *  KnowledgeEntry 实体测试
 * ════════════════════════════════════════════ */

describe('KnowledgeEntry', () => {
  function makeEntry(overrides = {}) {
    return new KnowledgeEntry({
      title: 'Singleton Pattern',
      language: 'swift',
      category: 'Architecture',
      content: { pattern: 'static let shared = Self()' },
      reasoning: {
        why_standard: 'widely used',
        sources: ['Manager.swift:10'],
        confidence: 0.9,
      },
      ...overrides,
    });
  }

  describe('construction', () => {
    test('creates with defaults', () => {
      const e = makeEntry();
      expect(e.id).toBeDefined();
      expect(e.lifecycle).toBe('pending');
      expect(e.kind).toBe('pattern');
      expect(e.content).toBeInstanceOf(Content);
      expect(e.relations).toBeInstanceOf(Relations);
      expect(e.constraints).toBeInstanceOf(Constraints);
      expect(e.reasoning).toBeInstanceOf(Reasoning);
      expect(e.quality).toBeInstanceOf(Quality);
      expect(e.stats).toBeInstanceOf(Stats);
    });

    test('infers kind from knowledgeType', () => {
      const e = makeEntry({ knowledgeType: 'code-standard' });
      expect(e.kind).toBe('rule');
    });

    test('isValid checks title + content', () => {
      expect(makeEntry().isValid()).toBe(true);
      expect(makeEntry({ title: '' }).isValid()).toBe(false);
      expect(makeEntry({ content: {} }).isValid()).toBe(false);
    });
  });

  describe('lifecycle transitions', () => {
    test('submit: no-op (already pending)', () => {
      const e = makeEntry();
      const r = e.submit();
      expect(r.success).toBe(true);
      expect(e.lifecycle).toBe('pending');
    });

    test('approve: pending → active (alias for publish)', () => {
      const e = makeEntry({ lifecycle: 'pending' });
      const r = e.approve('reviewer-1');
      expect(r.success).toBe(true);
      expect(e.lifecycle).toBe('active');
      expect(e.publishedBy).toBe('reviewer-1');
      expect(e.publishedAt).toBeGreaterThan(0);
    });

    test('autoApprove: no-op (stays pending)', () => {
      const e = makeEntry({ lifecycle: 'pending' });
      const r = e.autoApprove();
      expect(r.success).toBe(true);
      expect(e.lifecycle).toBe('pending');
    });

    test('reject: pending → deprecated (alias for deprecate)', () => {
      const e = makeEntry({ lifecycle: 'pending' });
      const r = e.reject('reviewer-1', 'not standard');
      expect(r.success).toBe(true);
      expect(e.lifecycle).toBe('deprecated');
      expect(e.rejectionReason).toBe('not standard');
    });

    test('publish: pending → active', () => {
      const e = makeEntry({ lifecycle: 'pending' });
      const r = e.publish('admin');
      expect(r.success).toBe(true);
      expect(e.lifecycle).toBe('active');
      expect(e.publishedBy).toBe('admin');
      expect(e.publishedAt).toBeGreaterThan(0);
    });

    test('publish invalid content fails', () => {
      const e = new KnowledgeEntry({ lifecycle: 'pending', title: '' });
      const r = e.publish('admin');
      expect(r.success).toBe(false);
      expect(r.error).toContain('不完整');
    });

    test('deprecate: active → deprecated', () => {
      const e = makeEntry({ lifecycle: 'active' });
      const r = e.deprecate('outdated');
      expect(r.success).toBe(true);
      expect(e.lifecycle).toBe('deprecated');
    });

    test('reactivate: deprecated → pending', () => {
      const e = makeEntry({ lifecycle: 'deprecated' });
      const r = e.reactivate();
      expect(r.success).toBe(true);
      expect(e.lifecycle).toBe('pending');
    });

    test('invalid transition returns error', () => {
      const e = makeEntry({ lifecycle: 'active' });
      const r = e.reactivate(); // active → pending is not valid
      expect(r.success).toBe(false);
      expect(r.error).toContain('Invalid lifecycle transition');
    });

    test('fastTrack: pending → active (alias for publish)', () => {
      const e = makeEntry();
      const r = e.fastTrack('bot');
      expect(r.success).toBe(true);
      expect(e.lifecycle).toBe('active');
      expect(e.publishedBy).toBe('bot');
      expect(e.lifecycleHistory).toHaveLength(1);
    });

    test('lifecycle history tracks all transitions', () => {
      const e = makeEntry();
      e.publish('admin');       // pending → active
      e.deprecate('outdated');  // active → deprecated
      expect(e.lifecycleHistory).toHaveLength(2);
      expect(e.lifecycleHistory[0].from).toBe('pending');
      expect(e.lifecycleHistory[0].to).toBe('active');
      expect(e.lifecycleHistory[1].to).toBe('deprecated');
    });
  });

  describe('predicates', () => {
    test('isCandidate for pending state', () => {
      expect(makeEntry({ lifecycle: 'pending' }).isCandidate()).toBe(true);
    });

    test('isCandidate false for active/deprecated', () => {
      expect(makeEntry({ lifecycle: 'active' }).isCandidate()).toBe(false);
      expect(makeEntry({ lifecycle: 'deprecated' }).isCandidate()).toBe(false);
    });

    test('isActive', () => {
      expect(makeEntry({ lifecycle: 'active' }).isActive()).toBe(true);
      expect(makeEntry({ lifecycle: 'pending' }).isActive()).toBe(false);
    });

    test('isRule', () => {
      expect(makeEntry({ kind: 'rule' }).isRule()).toBe(true);
      expect(makeEntry({ kind: 'pattern' }).isRule()).toBe(false);
    });
  });

  describe('getGuardRules', () => {
    test('returns empty for non-active non-rule', () => {
      const e = makeEntry({
        lifecycle: 'pending',
        kind: 'rule',
        constraints: {
          guards: [{ pattern: 'test', message: 'msg' }],
        },
      });
      expect(e.getGuardRules()).toEqual([]);
    });

    test('returns regex guards for active rule', () => {
      const e = makeEntry({
        lifecycle: 'active',
        kind: 'rule',
        constraints: {
          guards: [
            { pattern: 'URLSession\\.shared', message: 'no direct URLSession', severity: 'error' },
            { pattern: '', message: 'empty pattern' }, // should be filtered
          ],
        },
      });
      const rules = e.getGuardRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].type).toBe('regex');
      expect(rules[0].pattern).toBe('URLSession\\.shared');
      expect(rules[0].severity).toBe('error');
      expect(rules[0].source).toBe('knowledge_entry');
    });

    test('returns ast guards', () => {
      const e = makeEntry({
        lifecycle: 'active',
        kind: 'rule',
        constraints: {
          guards: [
            { ast_query: { language: 'swift', node_type: 'call' }, message: 'ast guard' },
          ],
        },
      });
      const rules = e.getGuardRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].type).toBe('ast');
      expect(rules[0].astQuery.language).toBe('swift');
    });
  });

  describe('serialization', () => {
    test('toJSON → fromJSON round-trip preserves all fields', () => {
      const original = makeEntry({
        trigger: '@singleton',
        summaryCn: '单例模式',
        summaryEn: 'Singleton pattern',
        usageGuideCn: '使用指南',
        usageGuideEn: 'Usage guide',
        tags: ['pattern', 'architecture'],
        relations: {
          extends: [{ target: '@base', description: 'extends base' }],
        },
        constraints: {
          guards: [{ pattern: 'test', message: 'msg' }],
          boundaries: ['iOS 15+'],
        },
        headers: ['#import <Foundation/Foundation.h>'],
        headerPaths: ['Foundation'],
        moduleName: 'FoundationKit',
        includeHeaders: true,
        source: 'bootstrap',
      });

      const json = original.toJSON();

      // verify snake_case keys
      expect(json.knowledge_type).toBe('code-pattern');
      expect(json.summary_cn).toBe('单例模式');
      expect(json.usage_guide_cn).toBe('使用指南');
      expect(json.header_paths).toEqual(['Foundation']);
      expect(json.module_name).toBe('FoundationKit');
      expect(json.include_headers).toBe(true);
      expect(json.created_by).toBeDefined();

      // round-trip
      const restored = KnowledgeEntry.fromJSON(json);
      expect(restored.title).toBe(original.title);
      expect(restored.trigger).toBe('@singleton');
      expect(restored.summaryCn).toBe('单例模式');
      expect(restored.usageGuideEn).toBe('Usage guide');
      expect(restored.tags).toEqual(['pattern', 'architecture']);
      expect(restored.relations.getByType('extends')).toHaveLength(1);
      expect(restored.constraints.getRegexGuards()).toHaveLength(1);
      expect(restored.content.pattern).toBe('static let shared = Self()');
      expect(restored.reasoning.whyStandard).toBe('widely used');
      expect(restored.headers).toEqual(['#import <Foundation/Foundation.h>']);
      expect(restored.moduleName).toBe('FoundationKit');
      expect(restored.includeHeaders).toBe(true);
    });

    test('fromJSON handles empty/null input', () => {
      const e = KnowledgeEntry.fromJSON(null);
      expect(e.lifecycle).toBe('pending');
      expect(e.content).toBeInstanceOf(Content);
    });
  });
});
