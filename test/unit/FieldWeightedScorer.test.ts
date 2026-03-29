import { beforeEach, describe, expect, test } from 'vitest';
import { FieldWeightedScorer } from '../../lib/service/search/FieldWeightedScorer.js';

/* ────────────────────────────────────────────
 *  FieldWeightedScorer — 基础操作
 * ──────────────────────────────────────────── */
describe('FieldWeightedScorer', () => {
  let scorer: FieldWeightedScorer;

  beforeEach(() => {
    scorer = new FieldWeightedScorer();
  });

  test('should start with 0 documents', () => {
    expect(scorer.totalDocs).toBe(0);
    expect(scorer.documents).toHaveLength(0);
  });

  test('addDocument should increment totals', () => {
    scorer.addDocument('doc1', 'hello world', { title: 'Hello', trigger: 'hello' });
    expect(scorer.totalDocs).toBe(1);
    expect(scorer.avgLength).toBeGreaterThan(0);
  });

  test('addDocument should track doc frequency', () => {
    scorer.addDocument('doc1', 'swift networking', {
      title: 'Swift Networking',
      trigger: 'swift',
      tags: ['swift', 'networking'],
    });
    scorer.addDocument('doc2', 'swift ui', {
      title: 'Swift UI',
      trigger: 'ui',
      tags: ['swift', 'ui'],
    });
    expect(scorer.docFreq.swift).toBe(2);
    expect(scorer.docFreq.networking).toBe(1);
  });

  test('addDocument should be idempotent (re-add same id)', () => {
    scorer.addDocument('doc1', 'text v1', { title: 'V1' });
    scorer.addDocument('doc1', 'text v2', { title: 'V2' });
    expect(scorer.totalDocs).toBe(1);
  });

  test('search should return empty for empty query', () => {
    scorer.addDocument('doc1', 'hello world', { title: 'Hello' });
    expect(scorer.search('')).toEqual([]);
  });

  test('search should return matching documents', () => {
    scorer.addDocument('doc1', 'swift networking', {
      title: 'Swift Networking',
      trigger: '@swift-network',
      tags: ['swift', 'network'],
    });
    scorer.addDocument('doc2', 'python requests', {
      title: 'Python HTTP',
      trigger: '@python-http',
      tags: ['python', 'http'],
    });
    scorer.addDocument('doc3', 'swift uikit', {
      title: 'Swift UIKit',
      trigger: '@swift-uikit',
      tags: ['swift', 'ui'],
    });

    const results = scorer.search('swift');
    expect(results.length).toBe(2);
    expect(results.map((r) => r.id)).toContain('doc1');
    expect(results.map((r) => r.id)).toContain('doc3');
  });

  test('search should respect limit', () => {
    for (let i = 0; i < 30; i++) {
      scorer.addDocument(`doc${i}`, `swift document ${i}`, {
        title: `Swift Doc ${i}`,
        trigger: `@swift-${i}`,
        tags: ['swift'],
      });
    }
    const results = scorer.search('swift', 5);
    expect(results.length).toBe(5);
  });

  test('search should include meta in results', () => {
    const meta = { type: 'recipe', title: 'Net', trigger: 'net' };
    scorer.addDocument('doc1', 'swift networking', meta);
    const results = scorer.search('swift');
    expect(results[0].meta).toEqual(meta);
  });

  test('clear should reset all state', () => {
    scorer.addDocument('doc1', 'hello world', { title: 'Hello' });
    scorer.clear();
    expect(scorer.totalDocs).toBe(0);
    expect(scorer.documents).toHaveLength(0);
    expect(scorer.avgLength).toBe(0);
    expect(Object.keys(scorer.docFreq)).toHaveLength(0);
  });

  test('removeDocument should return false for non-existent id', () => {
    expect(scorer.removeDocument('nope')).toBe(false);
  });

  test('removeDocument should decrement totals', () => {
    scorer.addDocument('doc1', 'hello', { title: 'Hello' });
    scorer.addDocument('doc2', 'world', { title: 'World' });
    expect(scorer.totalDocs).toBe(2);

    expect(scorer.removeDocument('doc1')).toBe(true);
    expect(scorer.totalDocs).toBe(1);
    expect(scorer.hasDocument('doc1')).toBe(false);
  });

  test('updateDocument should replace content', () => {
    scorer.addDocument('doc1', 'swift old', { title: 'Old', trigger: 'old' });
    scorer.updateDocument('doc1', 'swift new', { title: 'New', trigger: 'new' });
    expect(scorer.totalDocs).toBe(1);

    const results = scorer.search('new');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('doc1');
  });

  test('hasDocument should return correct state', () => {
    expect(scorer.hasDocument('doc1')).toBe(false);
    scorer.addDocument('doc1', 'test', { title: 'Test' });
    expect(scorer.hasDocument('doc1')).toBe(true);
    scorer.removeDocument('doc1');
    expect(scorer.hasDocument('doc1')).toBe(false);
  });
});

/* ────────────────────────────────────────────
 *  FieldWeightedScorer — 排序质量
 * ──────────────────────────────────────────── */
describe('FieldWeightedScorer ranking', () => {
  let scorer: FieldWeightedScorer;

  beforeEach(() => {
    scorer = new FieldWeightedScorer();
  });

  test('trigger exact match should rank highest', () => {
    scorer.addDocument('exact', 'some content', {
      title: 'Router Dispatch',
      trigger: 'SchemeRouter',
      tags: ['routing'],
    });
    scorer.addDocument('partial', 'SchemeRouter related content', {
      title: 'Other Topic',
      trigger: 'other',
      tags: ['misc'],
    });

    const results = scorer.search('SchemeRouter');
    expect(results[0].id).toBe('exact');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  test('title match should rank above content-only match', () => {
    scorer.addDocument('title-match', 'some random content', {
      title: 'BDBaseRequest 继承请求模式',
      trigger: '@bd-base-request',
      tags: ['networking'],
    });
    scorer.addDocument('content-match', 'BDBaseRequest is used in the codebase for networking', {
      title: '通用代码规范',
      trigger: '@code-standard',
      tags: ['standard'],
    });

    const results = scorer.search('BDBaseRequest');
    expect(results[0].id).toBe('title-match');
  });

  test('tag match should contribute to relevance', () => {
    scorer.addDocument('tagged', 'generic content', {
      title: 'Some Topic',
      trigger: '@topic',
      tags: ['routing', 'ModuleKit', 'SchemeRouter'],
    });
    scorer.addDocument('untagged', 'generic content', {
      title: 'Another Topic',
      trigger: '@another',
      tags: [],
    });

    const results = scorer.search('routing');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe('tagged');
  });

  test('Chinese query should match Chinese title and content', () => {
    scorer.addDocument('chinese', '错误处理网络请求异常的最佳实践', {
      title: '网络错误处理模式',
      trigger: '@network-error',
      tags: ['网络', 'error-handling'],
      description: '如何处理网络请求中的各种错误情况',
    });
    scorer.addDocument('unrelated', 'swift code style guide', {
      title: 'Swift 代码风格',
      trigger: '@code-style',
      tags: ['swift'],
    });

    const results = scorer.search('网络错误');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe('chinese');
  });

  test('description field should contribute via IDF-weighted overlap', () => {
    scorer.addDocument('with-desc', 'content text', {
      title: 'Generic',
      trigger: '@generic',
      tags: [],
      description: 'WebSocket 连接管理与心跳检测机制',
    });
    scorer.addDocument('without-desc', 'content text', {
      title: 'Other',
      trigger: '@other',
      tags: [],
      description: '',
    });

    const results = scorer.search('WebSocket');
    expect(results[0].id).toBe('with-desc');
  });

  test('facet match (language) should boost score', () => {
    scorer.addDocument('swift-doc', 'generic content', {
      title: 'Pattern',
      trigger: '@pattern',
      tags: ['pattern'],
      language: 'swift',
      category: 'architecture',
    });
    scorer.addDocument('python-doc', 'generic content', {
      title: 'Pattern',
      trigger: '@pattern2',
      tags: ['pattern'],
      language: 'python',
      category: 'architecture',
    });

    const results = scorer.search('swift pattern');
    // Both should match 'pattern', but 'swift-doc' should rank higher due to facet match
    expect(results[0].id).toBe('swift-doc');
  });

  test('contentText in meta should be used for content scoring', () => {
    scorer.addDocument('with-content', 'fallback text', {
      title: 'Generic',
      trigger: '@generic',
      tags: [],
      contentText: 'Alamofire SessionManager configuration for custom SSL pinning',
    });
    scorer.addDocument('no-content', 'fallback text', {
      title: 'Other',
      trigger: '@other',
      tags: [],
    });

    const results = scorer.search('Alamofire');
    expect(results[0].id).toBe('with-content');
  });
});

/* ────────────────────────────────────────────
 *  FieldWeightedScorer — 边界情况
 * ──────────────────────────────────────────── */
describe('FieldWeightedScorer edge cases', () => {
  let scorer: FieldWeightedScorer;

  beforeEach(() => {
    scorer = new FieldWeightedScorer();
  });

  test('no meta fields should still work via text fallback', () => {
    scorer.addDocument('no-meta', 'swift networking URLSession', {});
    const results = scorer.search('swift');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('no-meta');
  });

  test('very long query should not throw', () => {
    scorer.addDocument('doc1', 'test', { title: 'Test', trigger: 'test' });
    const longQuery = 'swift '.repeat(100);
    expect(() => scorer.search(longQuery)).not.toThrow();
  });

  test('documents with no matching tokens should score 0', () => {
    scorer.addDocument('doc1', 'alpha beta gamma', {
      title: 'Alpha',
      trigger: 'alpha',
      tags: ['alpha'],
    });
    const results = scorer.search('zzzzz');
    expect(results.length).toBe(0);
  });

  test('trigger substring match (query contains trigger)', () => {
    scorer.addDocument('doc1', 'content', {
      title: 'Short',
      trigger: 'router',
      tags: [],
    });
    const results = scorer.search('SchemeRouter module dispatch');
    // 'router' (length > 3) is contained in 'schemerouter' → reverse containment should match
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});
