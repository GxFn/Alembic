/**
 * ConsolidationAdvisor 单元测试
 *
 * 验证提交前融合分析的 4 种建议路径：
 *   create / merge / reorganize / insufficient
 */
import { describe, expect, it } from 'vitest';
import {
  type CandidateForConsolidation,
  ConsolidationAdvisor,
} from '../../lib/service/evolution/ConsolidationAdvisor.js';

/* ── Mock Repo ── */

// biome-ignore lint/suspicious/noExplicitAny: test mock
function mockRepo(rows: Record<string, unknown>[] = []): any {
  return {
    findAllByLifecyclesAndCategory: async (_lifecycles: string[], category: string) =>
      rows.filter((r) => !category || r.category === category),
    findByLifecyclesAndTriggerPrefix: async (
      _lifecycles: string[],
      _category: string,
      _prefix: string,
      _limit: number
    ) => [],
    findAllByLifecycles: async () => rows,
  };
}

function makeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'existing-1',
    title: 'Existing Recipe',
    doClause: 'Use BDFoundation category methods for safe collection access',
    dontClause: 'Do not use raw objectForKey directly',
    coreCode: '[dict bd_stringForKey:@"key"]',
    category: 'Foundation',
    trigger: '@bd-foundation-safe-access',
    whenClause: 'When accessing dictionary values from network responses',
    guardPattern: null,
    ...overrides,
  };
}

function makeCandidate(
  overrides: Partial<CandidateForConsolidation> = {}
): CandidateForConsolidation {
  return {
    title: 'New Safe Dictionary Access Pattern',
    description: 'Use safe dictionary access methods',
    doClause: 'Use bd_stringForKey for safe string retrieval from dictionaries',
    dontClause: 'Do not access dictionary keys without null checking',
    coreCode: 'NSString *value = [dict bd_stringForKey:@"name"];',
    category: 'Foundation',
    trigger: '@bd-dict-safe-read',
    whenClause: 'When reading string values from NSDictionary parsed from JSON',
    kind: 'rule',
    ...overrides,
  };
}

describe('ConsolidationAdvisor', () => {
  describe('create — no related recipes', () => {
    it('should advise create when no related recipes exist', async () => {
      const advisor = new ConsolidationAdvisor(mockRepo([]));
      const advice = await advisor.analyze(makeCandidate());

      expect(advice.action).toBe('create');
      expect(advice.confidence).toBeGreaterThan(0.8);
    });
  });

  describe('insufficient — insufficient substance', () => {
    it('should flag candidates with minimal content as insufficient', async () => {
      const advisor = new ConsolidationAdvisor(mockRepo([]));
      const advice = await advisor.analyze({
        title: 'Short',
        doClause: 'Use it',
        dontClause: '',
        coreCode: '',
        trigger: 'x',
        whenClause: '',
      });

      expect(advice.action).toBe('insufficient');
      expect(advice.reason).toContain('实质性评分');
    });

    it('should flag candidates without trigger and whenClause as insufficient', async () => {
      const advisor = new ConsolidationAdvisor(mockRepo([]));
      const advice = await advisor.analyze({
        title: 'Some rule',
        doClause: 'Do something properly',
        dontClause: '',
        coreCode: '',
      });

      expect(advice.action).toBe('insufficient');
    });

    it('should include coveredBy when related recipes exist', async () => {
      const existingRow = makeDbRow();
      const advisor = new ConsolidationAdvisor(mockRepo([existingRow]));
      const advice = await advisor.analyze({
        title: 'Short',
        doClause: 'Use it',
        dontClause: '',
        coreCode: '',
        category: 'Foundation',
        trigger: 'x',
        whenClause: '',
      });

      expect(advice.action).toBe('insufficient');
      expect(advice.coveredBy).toBeDefined();
      expect(advice.coveredBy!.length).toBeGreaterThan(0);
      expect(advice.reason).toContain('已有 Recipe 覆盖');
    });
  });

  describe('merge — high overlap with single recipe', () => {
    it('should advise merge when candidate overlaps with existing recipe', async () => {
      const existingRow = makeDbRow();
      const advisor = new ConsolidationAdvisor(mockRepo([existingRow]));

      // Candidate that is very similar to existing
      const advice = await advisor.analyze(
        makeCandidate({
          title: 'BDFoundation Safe Dictionary Access',
          doClause: 'Use BDFoundation category methods for safe collection access to dictionaries',
          dontClause: 'Do not use raw objectForKey without safety checks',
          coreCode: '[dict bd_stringForKey:@"key"]',
        })
      );

      expect(advice.action).toBe('merge');
      expect(advice.targetRecipe).toBeDefined();
      expect(advice.targetRecipe!.id).toBe('existing-1');
      expect(advice.confidence).toBeGreaterThan(0.4);
    });
  });

  describe('reorganize — high overlap with multiple recipes', () => {
    it('should advise merge or reorganize when candidate overlaps with 2+ recipes', async () => {
      // Use nearly-identical text across all three to guarantee high similarity
      const sharedDo =
        'Use BDFoundation category methods bd_stringForKey and bd_objectForKeyCheck for safe collection dictionary access';
      const sharedDont =
        'Do not use raw objectForKey or subscript operator without null checking in dictionaries';
      const sharedCode = '[dict bd_stringForKey:@"key"]; [dict bd_objectForKeyCheck:@"data"];';

      const rows = [
        makeDbRow({
          id: 'r1',
          title: 'BDFoundation Safe Dictionary String Access',
          doClause: sharedDo,
          dontClause: sharedDont,
          coreCode: sharedCode,
        }),
        makeDbRow({
          id: 'r2',
          title: 'BDFoundation Safe Dictionary Object Access',
          doClause: `${sharedDo} including NSNull filtering`,
          dontClause: `${sharedDont} especially for network response parsing`,
          coreCode: sharedCode,
        }),
      ];
      const advisor = new ConsolidationAdvisor(mockRepo(rows));

      const advice = await advisor.analyze(
        makeCandidate({
          title: 'BDFoundation Safe Dictionary Access Pattern',
          doClause: sharedDo,
          dontClause: sharedDont,
          coreCode: sharedCode,
        })
      );

      // With near-identical content, should detect overlap
      expect(['merge', 'reorganize']).toContain(advice.action);
      // At minimum there should be related recipes
      expect(advice.relatedRecipes).toBeDefined();
    });
  });

  describe('create — moderate overlap but new dimensions', () => {
    it('should allow create when candidate provides new dimensions', async () => {
      const existingRow = makeDbRow({
        title: 'Network Request Retry',
        doClause: 'Use retry logic for network requests',
        dontClause: 'Do not retry indefinitely',
        coreCode: '', // no code in existing
        whenClause: '', // no whenClause in existing
      });
      const advisor = new ConsolidationAdvisor(mockRepo([existingRow]));

      const advice = await advisor.analyze(
        makeCandidate({
          title: 'Network Request Retry with Exponential Backoff',
          doClause: 'Use exponential backoff retry logic for network request failures',
          dontClause: 'Do not use fixed-interval retry or retry non-idempotent requests',
          coreCode: `
let delay = baseDelay;
for (int i = 0; i < maxRetry; i++) {
    [NSThread sleepForTimeInterval:delay];
    delay *= 2;
}`,
          whenClause: 'When handling transient network errors in API calls that are idempotent',
          category: 'Network',
          trigger: '@network-retry-backoff',
        })
      );

      // Should create because candidate provides coreCode + whenClause that existing lacks
      expect(advice.action).toBe('create');
    });
  });

  describe('create — low overlap', () => {
    it('should advise create for genuinely different topics', async () => {
      const existingRow = makeDbRow({
        title: 'UITableView Cell Registration',
        doClause: 'Register cells in viewDidLoad',
        dontClause: 'Do not register cells in cellForRowAt',
        coreCode:
          '[self.tableView registerClass:[UITableViewCell class] forCellReuseIdentifier:@"cell"]',
        category: 'UIKit',
      });
      const advisor = new ConsolidationAdvisor(mockRepo([existingRow]));

      const advice = await advisor.analyze(
        makeCandidate({
          title: 'AES Encryption for Sensitive Data',
          doClause: 'Use NSData bd_encryptAES for encrypting sensitive local data',
          dontClause: 'Do not store sensitive data in plaintext UserDefaults',
          coreCode: 'NSData *encrypted = [data bd_encryptAES:key iv:iv];',
          category: 'Foundation',
          trigger: '@bd-aes-encrypt',
          whenClause: 'When persisting sensitive user credentials or tokens locally',
        })
      );

      expect(advice.action).toBe('create');
      expect(advice.confidence).toBeGreaterThanOrEqual(0.8);
    });
  });

  describe('merge direction analysis', () => {
    it('should suggest merge when candidate adds nothing new', async () => {
      // Existing already has everything — candidate is a near-duplicate
      const existingRow = makeDbRow({
        title: 'BDFoundation Safe Array Element Access Using bd_safeObjectAtIndex',
        doClause:
          'Use bd_safeObjectAtIndex for safe array element retrieval to prevent out-of-bounds crashes',
        dontClause: 'Do not use objectAtIndex without bounds checking',
        coreCode: 'id obj = [array bd_safeObjectAtIndex:index];',
        whenClause: 'When accessing array elements from parsed server data',
        category: 'Foundation',
      });
      const advisor = new ConsolidationAdvisor(mockRepo([existingRow]));

      const advice = await advisor.analyze(
        makeCandidate({
          title: 'BDFoundation Safe Array Element Access Using bd_safeObjectAtIndex',
          doClause:
            'Use bd_safeObjectAtIndex for safe array element retrieval to prevent out-of-bounds crashes',
          dontClause:
            'Do not use objectAtIndex without bounds checking for data-driven collections',
          coreCode: 'id obj = [array bd_safeObjectAtIndex:index];',
          category: 'Foundation',
          trigger: '@bd-array-safe-access',
          whenClause:
            'When accessing array elements from parsed server data or user-generated lists',
        })
      );

      // Near-duplicate with nothing new → merge into existing recipe
      expect(advice.action).toBe('merge');
      expect(advice.targetRecipe).toBeDefined();
    });

    it('should allow create when candidate adds new dimensions to partial recipe', async () => {
      // Existing is incomplete — candidate fills gaps
      const existingRow = makeDbRow({
        title: 'BDFoundation Safe Array Element Access',
        doClause: 'Use bd_safeObjectAtIndex for safe array element access',
        dontClause: null,
        coreCode: null,
        whenClause: null,
        category: 'Foundation',
      });
      const advisor = new ConsolidationAdvisor(mockRepo([existingRow]));

      const advice = await advisor.analyze(
        makeCandidate({
          title: 'BDFoundation Safe Array Element Access Pattern',
          doClause: 'Use bd_safeObjectAtIndex for safe array element retrieval',
          dontClause: 'Do not use objectAtIndex without bounds checking',
          coreCode: 'id obj = [array bd_safeObjectAtIndex:index];',
          category: 'Foundation',
          trigger: '@bd-array-safe-access',
          whenClause: 'When accessing array elements from parsed server data',
        })
      );

      if (advice.action === 'create') {
        // Allowed because candidate provides new dimensions
        expect(advice.relatedRecipes).toBeDefined();
      } else {
        // Also valid: merge with the existing one
        expect(advice.action).toBe('merge');
        expect(advice.mergeDirection).toBeDefined();
        expect(advice.mergeDirection!.addedDimensions.length).toBeGreaterThan(0);
      }
    });
  });

  describe('substance scoring', () => {
    it('should pass substance check for well-formed candidates', async () => {
      const advisor = new ConsolidationAdvisor(mockRepo([]));
      const advice = await advisor.analyze(makeCandidate());

      // makeCandidate has good doClause, dontClause, coreCode, trigger, whenClause
      expect(advice.action).not.toBe('insufficient');
    });

    it('should pass substance check with long clauses even without code', async () => {
      const advisor = new ConsolidationAdvisor(mockRepo([]));
      const advice = await advisor.analyze(
        makeCandidate({
          doClause:
            'Always dispatch UI updates to the main queue using dispatch_async(dispatch_get_main_queue()) and verify main thread',
          dontClause:
            'Never perform UI updates on background threads or use dispatch_sync to main queue from the main thread which may deadlock',
          coreCode: '',
          trigger: '@bd-main-thread-ui',
          whenClause: 'When updating any UIKit views from completion handlers or callback blocks',
        })
      );

      expect(advice.action).not.toBe('insufficient');
    });
  });
});
