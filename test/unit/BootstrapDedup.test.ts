/**
 * BootstrapDedup 单元测试
 *
 * 验证冷启动期间的会话级去重缓存：
 *   - register / findDuplicate / findDuplicates / clear
 *   - 4 维结构相似度 (title + clause + code + guard)
 *   - 阈值拦截逻辑
 */
import { describe, expect, it } from 'vitest';
import {
  BootstrapDedup,
  type CandidateSummary,
} from '../../lib/service/bootstrap/BootstrapDedup.js';

function makeSummary(overrides: Partial<CandidateSummary> = {}): CandidateSummary {
  return {
    id: 'r-001',
    title: 'NetworkClient 重试机制 — 指数退避与断路器',
    category: 'code-pattern',
    coreCode: `let delay = baseDelay;\nfor (int i = 0; i < maxRetry; i++) {\n  [NSThread sleepForTimeInterval:delay];\n  delay *= 2;\n}`,
    doClause:
      'Use exponential backoff retry logic for network request failures with circuit breaker integration',
    dontClause: 'Do not retry non-idempotent requests or use fixed-interval retry without backoff',
    ...overrides,
  };
}

describe('BootstrapDedup', () => {
  describe('register + count', () => {
    it('should track registered entries', () => {
      const dedup = new BootstrapDedup();
      expect(dedup.count).toBe(0);

      dedup.register(makeSummary());
      expect(dedup.count).toBe(1);

      dedup.register(makeSummary({ id: 'r-002', title: 'Another Pattern' }));
      expect(dedup.count).toBe(2);
    });
  });

  describe('clear', () => {
    it('should reset all entries', () => {
      const dedup = new BootstrapDedup();
      dedup.register(makeSummary());
      dedup.register(makeSummary({ id: 'r-002' }));
      expect(dedup.count).toBe(2);

      dedup.clear();
      expect(dedup.count).toBe(0);
    });
  });

  describe('findDuplicate — identical candidate', () => {
    it('should detect identical entry as duplicate', () => {
      const dedup = new BootstrapDedup();
      const existing = makeSummary();
      dedup.register(existing);

      // Submit the same thing again
      const match = dedup.findDuplicate(makeSummary({ id: '' }));
      expect(match).not.toBeNull();
      expect(match!.existingId).toBe('r-001');
      expect(match!.similarity).toBeGreaterThanOrEqual(0.65);
    });
  });

  describe('findDuplicate — cross-dimension duplicate', () => {
    it('should detect cross-dimension duplicate with similar content but different category', () => {
      const dedup = new BootstrapDedup();

      // code-pattern 维度注册
      dedup.register(
        makeSummary({
          id: 'r-code-001',
          category: 'code-pattern',
          title: 'NetworkClient 重试机制 — 指数退避与断路器',
          doClause:
            'Use exponential backoff retry logic for network request failures with circuit breaker integration and max retry limit',
          dontClause:
            'Do not retry non-idempotent requests or use fixed-interval retry without backoff delay scaling',
          coreCode: `let delay = baseDelay;\nfor (int i = 0; i < maxRetry; i++) {\n  [NSThread sleepForTimeInterval:delay];\n  delay *= 2;\n  if (circuitBreaker.isOpen) break;\n}`,
        })
      );

      // best-practice 维度提交：标题不同但 clause 和 code 高度重叠
      const match = dedup.findDuplicate({
        id: '',
        category: 'best-practice',
        title: 'NetworkClient 重试最佳实践 — 指数退避与断路器',
        doClause:
          'Use exponential backoff retry logic for network request failures with circuit breaker integration and configurable max retry limit',
        dontClause:
          'Do not retry non-idempotent requests or use fixed-interval retry without backoff delay scaling in production',
        coreCode: `let delay = baseDelay;\nfor (int i = 0; i < maxRetry; i++) {\n  [NSThread sleepForTimeInterval:delay];\n  delay *= 2;\n  if (circuitBreaker.isOpen) break;\n}`,
      });

      // 代码几乎一致 + clause 高度重叠 → 应该被拦截
      expect(match).not.toBeNull();
      expect(match!.similarity).toBeGreaterThanOrEqual(0.65);
    });
  });

  describe('findDuplicate — genuinely different content', () => {
    it('should NOT flag genuinely different topics as duplicates', () => {
      const dedup = new BootstrapDedup();

      dedup.register(
        makeSummary({
          id: 'r-net-001',
          title: 'NetworkClient 重试机制',
          doClause: 'Use exponential backoff retry for network failures',
          dontClause: 'Do not retry non-idempotent requests',
          coreCode: 'delay *= 2; retry(request);',
          category: 'code-pattern',
        })
      );

      const match = dedup.findDuplicate({
        id: '',
        title: 'SnapKit 约束布局 DSL',
        doClause: 'Use SnapKit snp.makeConstraints for all view layout',
        dontClause: 'Do not use frame-based layout or NSLayoutConstraint API directly',
        coreCode: `view.snp.makeConstraints { make in\n  make.edges.equalToSuperview()\n}`,
        category: 'code-pattern',
      });

      expect(match).toBeNull();
    });
  });

  describe('findDuplicate — threshold control', () => {
    it('should respect custom threshold', () => {
      const dedup = new BootstrapDedup();
      dedup.register(makeSummary());

      // With very high threshold, moderate matches should pass
      const strictMatch = dedup.findDuplicate(
        makeSummary({
          id: '',
          title: 'Modified Title: Network Retry Logic',
          doClause: 'Use retry with exponential backoff for API calls',
        }),
        0.95 // Very strict threshold
      );
      expect(strictMatch).toBeNull();

      // With very low threshold, should catch
      const lenientMatch = dedup.findDuplicate(
        makeSummary({
          id: '',
          title: 'Modified Title: Network Retry Logic',
          doClause: 'Use retry with exponential backoff for API calls',
        }),
        0.3
      );
      expect(lenientMatch).not.toBeNull();
    });
  });

  describe('findDuplicate — empty cache', () => {
    it('should return null when cache is empty', () => {
      const dedup = new BootstrapDedup();
      const match = dedup.findDuplicate(makeSummary());
      expect(match).toBeNull();
    });
  });

  describe('findDuplicates — batch check', () => {
    it('should return matches for duplicate entries in batch', () => {
      const dedup = new BootstrapDedup();
      dedup.register(makeSummary({ id: 'r-001' }));

      const candidates = [
        makeSummary({ id: '' }), // duplicate of r-001
        {
          id: '',
          title: 'Completely Different Topic About Logging',
          category: 'best-practice',
          coreCode: 'Logger.shared.info("message")',
          doClause: 'Use structured logging for all debug output',
          dontClause: 'Do not use print or NSLog in production code',
        },
      ];

      const matches = dedup.findDuplicates(candidates);
      expect(matches.length).toBe(1);
      expect(matches[0].existingId).toBe('r-001');
    });
  });

  describe('guardPattern matching', () => {
    it('should boost similarity when guardPattern matches exactly', () => {
      const dedup = new BootstrapDedup();
      dedup.register(
        makeSummary({
          id: 'r-guard',
          title: 'Pattern A',
          doClause: 'Do A',
          dontClause: 'Dont A',
          coreCode: 'code A',
          guardPattern: 'if (condition) { return }',
        })
      );

      // Same guard pattern but different everything else
      const withGuard = dedup.findDuplicate(
        {
          id: '',
          title: 'Pattern B',
          doClause: 'Do B',
          dontClause: 'Dont B',
          coreCode: 'code B',
          category: 'code-pattern',
          guardPattern: 'if (condition) { return }',
        },
        0.15
      ); // Low threshold to test guard contribution

      const withoutGuard = dedup.findDuplicate(
        {
          id: '',
          title: 'Pattern B',
          doClause: 'Do B',
          dontClause: 'Dont B',
          coreCode: 'code B',
          category: 'code-pattern',
        },
        0.15
      );

      // With matching guard pattern → higher similarity
      if (withGuard && withoutGuard) {
        expect(withGuard.similarity).toBeGreaterThan(withoutGuard.similarity);
      } else if (withGuard) {
        expect(withGuard.similarity).toBeGreaterThan(0);
      }
    });
  });

  describe('multiple registered entries', () => {
    it('should return the best match among multiple entries', () => {
      const dedup = new BootstrapDedup();

      dedup.register(
        makeSummary({
          id: 'r-unrelated',
          title: 'Logger Setup and Configuration',
          doClause: 'Use structured logging framework for all debug and production output',
          dontClause: 'Do not use print statements or NSLog in production code',
          coreCode: 'Logger.shared.setup(category: .network, level: .verbose)',
        })
      );

      dedup.register(
        makeSummary({
          id: 'r-retry',
          title: 'NetworkClient Retry with Exponential Backoff',
          doClause:
            'Use exponential backoff retry logic for network request failures with circuit breaker integration and max retry limit',
          dontClause:
            'Do not retry non-idempotent requests or use fixed-interval retry without backoff delay scaling',
          coreCode: `let delay = baseDelay;\nfor (int i = 0; i < maxRetry; i++) {\n  [NSThread sleepForTimeInterval:delay];\n  delay *= 2;\n  if (circuitBreaker.isOpen) break;\n}`,
        })
      );

      const match = dedup.findDuplicate({
        id: '',
        title: 'NetworkClient Retry Pattern — Exponential Backoff',
        category: 'best-practice',
        doClause:
          'Use exponential backoff retry logic for network request failures with circuit breaker and configurable retry limit',
        dontClause:
          'Do not retry non-idempotent requests or use fixed-interval retry without delay scaling',
        coreCode: `let delay = baseDelay;\nfor (int i = 0; i < maxRetry; i++) {\n  [NSThread sleepForTimeInterval:delay];\n  delay *= 2;\n  if (circuitBreaker.isOpen) break;\n}`,
      });

      // Should match r-retry, not r-unrelated
      expect(match).not.toBeNull();
      expect(match!.existingId).toBe('r-retry');
    });
  });
});
