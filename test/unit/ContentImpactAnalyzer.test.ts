import {
  assessDiffImpact,
  type RecipeTokens,
} from '../../lib/service/evolution/ContentImpactAnalyzer.js';
import { parseDiffHunks, tokenizeDiffLines } from '../../lib/shared/diff-parser.js';
import { extractCodeBlocksFromMarkdown } from '../../lib/shared/markdown-utils.js';
import {
  extractApiTokens,
  extractRecipeTokens,
  tokenizeIdentifiers,
} from '../../lib/shared/recipe-tokens.js';

describe('ContentImpactAnalyzer', () => {
  /* ─── tokenizeIdentifiers ─── */

  describe('tokenizeIdentifiers', () => {
    test('提取标识符并跳过注释和字符串', () => {
      const code = `
        // This is a comment
        const foo = "hello world";
        function bar(baz) { return baz; }
      `;
      const tokens = tokenizeIdentifiers(code);
      expect(tokens).toContain('foo');
      expect(tokens).toContain('bar');
      expect(tokens).toContain('baz');
      // 字符串内容不应出现
      expect(tokens).not.toContain('hello');
      expect(tokens).not.toContain('world');
    });

    test('空代码返回空数组', () => {
      expect(tokenizeIdentifiers('')).toEqual([]);
    });

    test('跳过块注释', () => {
      const code = `/* MyClass */ const RealClass = 1;`;
      const tokens = tokenizeIdentifiers(code);
      expect(tokens).toContain('RealClass');
      // MyClass 在块注释内，应被跳过
      expect(tokens).not.toContain('MyClass');
    });
  });

  /* ─── extractApiTokens ─── */

  describe('extractApiTokens', () => {
    test('过滤占位符前缀（My*, Example*）', () => {
      const code = 'class MyService { ServiceRegistry.shared.resolve(MyProtocol.self) }';
      const tokens = extractApiTokens(code);
      expect(tokens).toContain('ServiceRegistry');
      expect(tokens).toContain('shared');
      expect(tokens).toContain('resolve');
      expect(tokens).not.toContain('MyService');
      expect(tokens).not.toContain('MyProtocol');
    });

    test('过滤语言关键字', () => {
      const code = 'func register(_ type: ServiceType.Type, scope: Scope) { return instance }';
      const tokens = extractApiTokens(code);
      expect(tokens).not.toContain('func');
      expect(tokens).not.toContain('return');
      expect(tokens).toContain('register');
      expect(tokens).toContain('ServiceType');
      expect(tokens).toContain('Scope');
      expect(tokens).toContain('instance');
    });

    test('过滤短标识符（< 4 字符）', () => {
      const code = 'let a = foo.bar(x, y)';
      const tokens = extractApiTokens(code);
      expect(tokens).not.toContain('let');
      expect(tokens).not.toContain('a');
      expect(tokens).not.toContain('x');
      expect(tokens).not.toContain('y');
      expect(tokens).not.toContain('foo');
      expect(tokens).not.toContain('bar');
    });

    test('去重', () => {
      const code = 'ServiceRegistry.shared.register(); ServiceRegistry.shared.resolve()';
      const tokens = extractApiTokens(code);
      const registryCount = tokens.filter((t) => t === 'ServiceRegistry').length;
      expect(registryCount).toBe(1);
    });
  });

  /* ─── parseDiffHunks ─── */

  describe('parseDiffHunks', () => {
    test('解析标准 unified diff', () => {
      const diff = `diff --git a/file.swift b/file.swift
index abc..def 100644
--- a/file.swift
+++ b/file.swift
@@ -12 +12 @@
-    func fetchPopular(page: Int) async throws -> [VideoModel]
+    func fetchTrending(page: Int) async throws -> [VideoModel]
@@ -45 +45 @@
-    // Old comment
+    // New comment`;

      const hunks = parseDiffHunks(diff);
      expect(hunks).toHaveLength(2);
      expect(hunks[0].removedLines).toEqual([
        '    func fetchPopular(page: Int) async throws -> [VideoModel]',
      ]);
      expect(hunks[0].addedLines).toEqual([
        '    func fetchTrending(page: Int) async throws -> [VideoModel]',
      ]);
      expect(hunks[1].removedLines).toEqual(['    // Old comment']);
      expect(hunks[1].addedLines).toEqual(['    // New comment']);
    });

    test('空 diff 返回空数组', () => {
      expect(parseDiffHunks('')).toEqual([]);
    });

    test('多行新增', () => {
      const diff = `@@ -100,0 +101,3 @@
+    func newMethod() {
+        print("hello")
+    }`;
      const hunks = parseDiffHunks(diff);
      expect(hunks).toHaveLength(1);
      expect(hunks[0].removedLines).toEqual([]);
      expect(hunks[0].addedLines).toHaveLength(3);
    });
  });

  /* ─── tokenizeDiffLines ─── */

  describe('tokenizeDiffLines', () => {
    test('从 diff hunks 提取标识符', () => {
      const hunks = [
        {
          removedLines: ['    func fetchPopular(page: Int) async throws -> [VideoModel]'],
          addedLines: ['    func fetchTrending(page: Int) async throws -> [VideoModel]'],
        },
      ];
      const tokens = tokenizeDiffLines(hunks);
      expect(tokens.has('fetchPopular')).toBe(true);
      expect(tokens.has('fetchTrending')).toBe(true);
      expect(tokens.has('VideoModel')).toBe(true);
    });

    test('空 hunks 返回空集合', () => {
      expect(tokenizeDiffLines([])).toEqual(new Set());
    });
  });

  /* ─── extractCodeBlocksFromMarkdown ─── */

  describe('extractCodeBlocksFromMarkdown', () => {
    test('提取代码块及语言标识', () => {
      const md = `Some text

\`\`\`swift
func fetchPopular() async throws -> [VideoModel] {
    let response = try await client.send(.popular)
    return response.data ?? []
}
\`\`\`

More text

\`\`\`typescript
const x = 1;
\`\`\``;

      const blocks = extractCodeBlocksFromMarkdown(md);
      expect(blocks).toHaveLength(2);
      expect(blocks[0].language).toBe('swift');
      expect(blocks[0].code).toContain('fetchPopular');
      expect(blocks[1].language).toBe('typescript');
    });

    test('无代码块返回空数组', () => {
      expect(extractCodeBlocksFromMarkdown('just plain text')).toEqual([]);
    });
  });

  /* ─── extractRecipeTokens ─── */

  describe('extractRecipeTokens', () => {
    test('从 coreCode 提取 token', () => {
      const result = extractRecipeTokens({
        coreCode: 'ServiceRegistry.shared.register(Protocol.self)',
      });
      expect(result.tokens.has('ServiceRegistry')).toBe(true);
      expect(result.tokens.has('shared')).toBe(true);
      expect(result.tokens.has('register')).toBe(true);
    });

    test('从 content.markdown 代码块提取 token', () => {
      const result = extractRecipeTokens({
        coreCode: '',
        content: {
          markdown: `说明文字

\`\`\`swift
class NetworkClient {
    func sendRequest(endpoint: Endpoint) async throws -> Response {
        return try await session.data(for: endpoint.urlRequest)
    }
}
\`\`\``,
        },
      });
      expect(result.tokens.has('NetworkClient')).toBe(true);
      expect(result.tokens.has('sendRequest')).toBe(true);
      expect(result.tokens.has('endpoint')).toBe(true);
      expect(result.tokens.has('Endpoint')).toBe(true);
    });

    test('从 content.pattern 提取 token', () => {
      const result = extractRecipeTokens({
        content: {
          pattern: 'class VideoRepository { func fetchAll() {} }',
        },
      });
      expect(result.tokens.has('VideoRepository')).toBe(true);
      expect(result.tokens.has('fetchAll')).toBe(true);
    });

    test('从 content.steps[].code 提取 token', () => {
      const result = extractRecipeTokens({
        content: {
          steps: [{ code: 'let manager = CacheManager.shared' }],
        },
      });
      expect(result.tokens.has('CacheManager')).toBe(true);
      expect(result.tokens.has('manager')).toBe(true);
    });

    test('空 entry 返回空 tokens', () => {
      const result = extractRecipeTokens({});
      expect(result.tokens.size).toBe(0);
    });
  });

  /* ─── assessDiffImpact ─── */

  describe('assessDiffImpact', () => {
    test('高交集 → pattern', () => {
      const diffTokens = new Set(['fetchPopular', 'VideoModel', 'client', 'send', 'popular']);
      const recipeTokens: RecipeTokens = {
        tokens: new Set([
          'fetchPopular',
          'VideoModel',
          'client',
          'send',
          'popular',
          'response',
          'data',
        ]),
        sources: new Map(),
      };
      const result = assessDiffImpact(diffTokens, recipeTokens);
      // 5/7 ≈ 0.71 → pattern
      expect(result.level).toBe('pattern');
      expect(result.score).toBeCloseTo(5 / 7);
      expect(result.matchedTokens).toContain('fetchPopular');
    });

    test('低交集 → reference', () => {
      const diffTokens = new Set(['client', 'newUnrelatedMethod']);
      const recipeTokens: RecipeTokens = {
        tokens: new Set([
          'fetchPopular',
          'VideoModel',
          'client',
          'send',
          'popular',
          'response',
          'data',
        ]),
        sources: new Map(),
      };
      const result = assessDiffImpact(diffTokens, recipeTokens);
      // 1/7 ≈ 0.14 → reference
      expect(result.level).toBe('reference');
      expect(result.score).toBeCloseTo(1 / 7);
    });

    test('无交集 → reference（兜底）', () => {
      const diffTokens = new Set(['totallyUnrelated', 'nothingInCommon']);
      const recipeTokens: RecipeTokens = {
        tokens: new Set(['fetchPopular', 'VideoModel']),
        sources: new Map(),
      };
      const result = assessDiffImpact(diffTokens, recipeTokens);
      expect(result.level).toBe('reference');
      expect(result.score).toBe(0);
      expect(result.matchedTokens).toEqual([]);
    });

    test('空 recipe tokens → reference', () => {
      const diffTokens = new Set(['something']);
      const recipeTokens: RecipeTokens = {
        tokens: new Set(),
        sources: new Map(),
      };
      const result = assessDiffImpact(diffTokens, recipeTokens);
      expect(result.level).toBe('reference');
      expect(result.score).toBe(0);
    });

    test('恰好 30% 交集 → pattern', () => {
      // 10 tokens, 3 matched = 0.3 → pattern
      const recipeTokens: RecipeTokens = {
        tokens: new Set(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10']),
        sources: new Map(),
      };
      const diffTokens = new Set(['t1', 't2', 't3']);
      const result = assessDiffImpact(diffTokens, recipeTokens);
      expect(result.level).toBe('pattern');
      expect(result.score).toBeCloseTo(0.3);
    });

    test('场景：改了注释不动 API → unrelated/reference', () => {
      // diff 只有注释内容，tokenizeIdentifiers 会过滤注释
      const commentDiff = [
        { removedLines: ['// Old architecture doc'], addedLines: ['// New architecture doc'] },
      ];
      const diffTokens = tokenizeDiffLines(commentDiff);
      const recipeTokens: RecipeTokens = {
        tokens: new Set(['fetchPopular', 'VideoModel', 'client']),
        sources: new Map(),
      };
      const result = assessDiffImpact(diffTokens, recipeTokens);
      expect(result.level).toBe('reference');
      expect(result.score).toBe(0);
    });

    test('场景：API 改名 → pattern', () => {
      const renameDiff = [
        {
          removedLines: ['    func fetchPopular(page: Int) async throws -> [VideoModel]'],
          addedLines: ['    func fetchTrending(page: Int) async throws -> [VideoModel]'],
        },
      ];
      const diffTokens = tokenizeDiffLines(renameDiff);
      const recipeTokens: RecipeTokens = {
        tokens: new Set(['fetchPopular', 'VideoModel', 'async', 'throws']),
        sources: new Map(),
      };
      // fetchPopular + VideoModel matched → 2/4 = 0.5 → pattern
      const result = assessDiffImpact(diffTokens, recipeTokens);
      expect(result.level).toBe('pattern');
      expect(result.matchedTokens).toContain('fetchPopular');
      expect(result.matchedTokens).toContain('VideoModel');
    });
  });
});
