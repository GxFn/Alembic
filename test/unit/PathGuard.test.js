/**
 * PathGuard — 路径安全守卫单元测试（双层防护）
 */

import path from 'node:path';
import pathGuard, { PathGuardError } from '../../lib/shared/PathGuard.js';

describe('PathGuard', () => {
  const PROJECT_ROOT = '/Users/test/projects/MyApp';
  const PACKAGE_ROOT = '/Users/test/.nvm/versions/node/v20/lib/node_modules/autosnippet';

  beforeEach(() => {
    pathGuard._reset();
  });

  describe('configure', () => {
    test('should accept absolute projectRoot', () => {
      pathGuard.configure({ projectRoot: PROJECT_ROOT });
      expect(pathGuard.configured).toBe(true);
      expect(pathGuard.projectRoot).toBe(PROJECT_ROOT);
    });

    test('should reject relative projectRoot', () => {
      expect(() => pathGuard.configure({ projectRoot: 'relative/path' })).toThrow(
        'projectRoot 必须是绝对路径'
      );
    });

    test('should reject empty projectRoot', () => {
      expect(() => pathGuard.configure({ projectRoot: '' })).toThrow('projectRoot 必须是绝对路径');
    });

    test('should accept knowledgeBaseDir', () => {
      pathGuard.configure({ projectRoot: PROJECT_ROOT, knowledgeBaseDir: 'Knowledge' });
      // Knowledge/ should be writable
      expect(
        pathGuard.isProjectWriteSafe(path.join(PROJECT_ROOT, 'Knowledge/recipes/test.md'))
      ).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════
  //  Layer 1: assertSafe — 边界检查（projectRoot 外拦截）
  // ═══════════════════════════════════════════════════════

  describe('assertSafe (Layer 1 — boundary)', () => {
    beforeEach(() => {
      pathGuard.configure({
        projectRoot: PROJECT_ROOT,
        packageRoot: PACKAGE_ROOT,
      });
    });

    test('should allow paths within projectRoot', () => {
      expect(() =>
        pathGuard.assertSafe(path.join(PROJECT_ROOT, '.autosnippet/autosnippet.db'))
      ).not.toThrow();
      expect(() =>
        pathGuard.assertSafe(path.join(PROJECT_ROOT, 'AutoSnippet/recipes/general/test.md'))
      ).not.toThrow();
      expect(() => pathGuard.assertSafe(path.join(PROJECT_ROOT, 'src/main.m'))).not.toThrow();
    });

    test('should allow paths within packageRoot', () => {
      expect(() =>
        pathGuard.assertSafe(path.join(PACKAGE_ROOT, 'logs/error-2024.log'))
      ).not.toThrow();
    });

    test('should allow Xcode snippets directory', () => {
      const HOME = process.env.HOME || process.env.USERPROFILE;
      if (HOME) {
        const xcodePath = path.join(
          HOME,
          'Library/Developer/Xcode/UserData/CodeSnippets/test.codesnippet'
        );
        expect(() => pathGuard.assertSafe(xcodePath)).not.toThrow();
      }
    });

    test('should allow global .autosnippet cache', () => {
      const HOME = process.env.HOME || process.env.USERPROFILE;
      if (HOME) {
        const cachePath = path.join(HOME, '.autosnippet/cache/embeddings.json');
        expect(() => pathGuard.assertSafe(cachePath)).not.toThrow();
      }
    });

    test('should block paths outside project boundaries', () => {
      expect(() => pathGuard.assertSafe('/Users/test/projects/OtherProject/data/test.db')).toThrow(
        PathGuardError
      );
    });

    test('should block sibling project directories (BiliDemo scenario)', () => {
      expect(() =>
        pathGuard.assertSafe('/Users/test/projects/BiliDemo/data/autosnippet.db')
      ).toThrow(PathGuardError);
    });

    test('should block parent directory traversal', () => {
      expect(() => pathGuard.assertSafe(path.resolve(PROJECT_ROOT, '../other/file.txt'))).toThrow(
        PathGuardError
      );
    });

    test('should block path that starts with projectRoot as prefix but not a child', () => {
      expect(() => pathGuard.assertSafe('/Users/test/projects/MyApp-backup/file.txt')).toThrow(
        PathGuardError
      );
    });

    test('should block null/undefined paths', () => {
      expect(() => pathGuard.assertSafe(null)).toThrow(PathGuardError);
      expect(() => pathGuard.assertSafe(undefined)).toThrow(PathGuardError);
    });

    test('should not throw when unconfigured (graceful degradation for tests)', () => {
      pathGuard._reset();
      expect(() => pathGuard.assertSafe('/anywhere/file.txt')).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════
  //  Layer 2: assertProjectWriteSafe — 项目内作用域检查
  // ═══════════════════════════════════════════════════════

  describe('assertProjectWriteSafe (Layer 2 — project write scope)', () => {
    beforeEach(() => {
      pathGuard.configure({
        projectRoot: PROJECT_ROOT,
        packageRoot: PACKAGE_ROOT,
        knowledgeBaseDir: 'AutoSnippet',
      });
    });

    // ── 允许的写入路径 ──

    test('should allow .autosnippet/ (DB, memory, conversations)', () => {
      expect(() =>
        pathGuard.assertProjectWriteSafe(path.join(PROJECT_ROOT, '.autosnippet/autosnippet.db'))
      ).not.toThrow();
      expect(() =>
        pathGuard.assertProjectWriteSafe(path.join(PROJECT_ROOT, '.autosnippet/memory.jsonl'))
      ).not.toThrow();
      expect(() =>
        pathGuard.assertProjectWriteSafe(
          path.join(PROJECT_ROOT, '.autosnippet/conversations/abc.jsonl')
        )
      ).not.toThrow();
      expect(() =>
        pathGuard.assertProjectWriteSafe(
          path.join(PROJECT_ROOT, '.autosnippet/signal-snapshot.json')
        )
      ).not.toThrow();
    });

    test('should allow AutoSnippet/ (knowledge base: recipes, candidates, skills)', () => {
      expect(() =>
        pathGuard.assertProjectWriteSafe(
          path.join(PROJECT_ROOT, 'AutoSnippet/recipes/general/test.md')
        )
      ).not.toThrow();
      expect(() =>
        pathGuard.assertProjectWriteSafe(
          path.join(PROJECT_ROOT, 'AutoSnippet/candidates/ui/widget.md')
        )
      ).not.toThrow();
      expect(() =>
        pathGuard.assertProjectWriteSafe(
          path.join(PROJECT_ROOT, 'AutoSnippet/skills/coldstart/SKILL.md')
        )
      ).not.toThrow();
      expect(() =>
        pathGuard.assertProjectWriteSafe(
          path.join(PROJECT_ROOT, 'AutoSnippet/guard-exclusions.json')
        )
      ).not.toThrow();
      expect(() =>
        pathGuard.assertProjectWriteSafe(path.join(PROJECT_ROOT, 'AutoSnippet/guard-learner.json'))
      ).not.toThrow();
      expect(() =>
        pathGuard.assertProjectWriteSafe(path.join(PROJECT_ROOT, 'AutoSnippet/recipe-stats.json'))
      ).not.toThrow();
      expect(() =>
        pathGuard.assertProjectWriteSafe(path.join(PROJECT_ROOT, 'AutoSnippet/feedback.json'))
      ).not.toThrow();
    });

    test('should allow AutoSnippet/.autosnippet/ (vector index, context)', () => {
      expect(() =>
        pathGuard.assertProjectWriteSafe(
          path.join(PROJECT_ROOT, 'AutoSnippet/.autosnippet/context/index/vector_index.json')
        )
      ).not.toThrow();
    });

    test('should allow .cursor/ (IDE integration)', () => {
      expect(() =>
        pathGuard.assertProjectWriteSafe(path.join(PROJECT_ROOT, '.cursor/mcp.json'))
      ).not.toThrow();
      expect(() =>
        pathGuard.assertProjectWriteSafe(
          path.join(PROJECT_ROOT, '.cursor/rules/autosnippet-skills.mdc')
        )
      ).not.toThrow();
    });

    test('should allow .vscode/ (IDE integration)', () => {
      expect(() =>
        pathGuard.assertProjectWriteSafe(path.join(PROJECT_ROOT, '.vscode/settings.json'))
      ).not.toThrow();
    });

    test('should allow .github/ (Copilot instructions)', () => {
      expect(() =>
        pathGuard.assertProjectWriteSafe(path.join(PROJECT_ROOT, '.github/copilot-instructions.md'))
      ).not.toThrow();
    });

    test('should allow .gitignore in project root', () => {
      expect(() =>
        pathGuard.assertProjectWriteSafe(path.join(PROJECT_ROOT, '.gitignore'))
      ).not.toThrow();
    });

    test('should allow .env in project root', () => {
      expect(() => pathGuard.assertProjectWriteSafe(path.join(PROJECT_ROOT, '.env'))).not.toThrow();
    });

    test('should allow writes within packageRoot', () => {
      expect(() =>
        pathGuard.assertProjectWriteSafe(path.join(PACKAGE_ROOT, 'logs/error.log'))
      ).not.toThrow();
    });

    test('should allow writes to external whitelist paths (cache only)', () => {
      const HOME = process.env.HOME || process.env.USERPROFILE;
      if (HOME) {
        expect(() =>
          pathGuard.assertProjectWriteSafe(path.join(HOME, '.autosnippet/cache/test.json'))
        ).not.toThrow();
      }
    });

    test('should BLOCK ~/.autosnippet/autosnippet.db (not in cache scope)', () => {
      const HOME = process.env.HOME || process.env.USERPROFILE;
      if (HOME) {
        expect(() =>
          pathGuard.assertProjectWriteSafe(path.join(HOME, '.autosnippet/autosnippet.db'))
        ).toThrow(PathGuardError);
      }
    });

    // ── 禁止的写入路径 ──

    test('should BLOCK data/ directory (BiliDemo incident root cause)', () => {
      expect(() =>
        pathGuard.assertProjectWriteSafe(path.join(PROJECT_ROOT, 'data/autosnippet.db'))
      ).toThrow(PathGuardError);
      expect(() =>
        pathGuard.assertProjectWriteSafe(path.join(PROJECT_ROOT, 'data/autosnippet.db-shm'))
      ).toThrow(PathGuardError);
    });

    test('should BLOCK src/ directory (user source code)', () => {
      expect(() =>
        pathGuard.assertProjectWriteSafe(path.join(PROJECT_ROOT, 'src/NewFile.swift'))
      ).toThrow(PathGuardError);
    });

    test('should BLOCK random directories at project root', () => {
      expect(() =>
        pathGuard.assertProjectWriteSafe(path.join(PROJECT_ROOT, 'temp/debug.log'))
      ).toThrow(PathGuardError);
      expect(() =>
        pathGuard.assertProjectWriteSafe(path.join(PROJECT_ROOT, 'logs/error.log'))
      ).toThrow(PathGuardError);
      expect(() =>
        pathGuard.assertProjectWriteSafe(path.join(PROJECT_ROOT, 'build/output.txt'))
      ).toThrow(PathGuardError);
    });

    test('should BLOCK arbitrary files at project root', () => {
      expect(() =>
        pathGuard.assertProjectWriteSafe(path.join(PROJECT_ROOT, 'random-file.txt'))
      ).toThrow(PathGuardError);
    });

    test('should BLOCK paths outside project entirely', () => {
      expect(() =>
        pathGuard.assertProjectWriteSafe('/Users/test/projects/BiliDemo/data/test.db')
      ).toThrow(PathGuardError);
    });

    test('should not throw when unconfigured', () => {
      pathGuard._reset();
      expect(() => pathGuard.assertProjectWriteSafe('/anywhere/data/file.txt')).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════
  //  自定义知识库目录名
  // ═══════════════════════════════════════════════════════

  describe('custom knowledgeBaseDir', () => {
    test('should allow writes under custom KB dir', () => {
      pathGuard.configure({
        projectRoot: PROJECT_ROOT,
        knowledgeBaseDir: 'Knowledge',
      });
      expect(() =>
        pathGuard.assertProjectWriteSafe(path.join(PROJECT_ROOT, 'Knowledge/recipes/test.md'))
      ).not.toThrow();
      // Default 'AutoSnippet' should be blocked since kbDir is 'Knowledge'
      expect(() =>
        pathGuard.assertProjectWriteSafe(path.join(PROJECT_ROOT, 'AutoSnippet/recipes/test.md'))
      ).toThrow(PathGuardError);
    });

    test('should support setKnowledgeBaseDir after configure', () => {
      pathGuard.configure({ projectRoot: PROJECT_ROOT });
      pathGuard.setKnowledgeBaseDir('MyKB');
      expect(() =>
        pathGuard.assertProjectWriteSafe(path.join(PROJECT_ROOT, 'MyKB/recipes/test.md'))
      ).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════
  //  便捷方法
  // ═══════════════════════════════════════════════════════

  describe('isSafe / isProjectWriteSafe', () => {
    beforeEach(() => {
      pathGuard.configure({ projectRoot: PROJECT_ROOT, knowledgeBaseDir: 'AutoSnippet' });
    });

    test('isSafe should return true for project paths', () => {
      expect(pathGuard.isSafe(path.join(PROJECT_ROOT, 'src/main.m'))).toBe(true);
    });

    test('isSafe should return false for external paths', () => {
      expect(pathGuard.isSafe('/tmp/evil.txt')).toBe(false);
    });

    test('isProjectWriteSafe should return true for allowed scopes', () => {
      expect(pathGuard.isProjectWriteSafe(path.join(PROJECT_ROOT, '.autosnippet/db'))).toBe(true);
    });

    test('isProjectWriteSafe should return false for disallowed scopes', () => {
      expect(pathGuard.isProjectWriteSafe(path.join(PROJECT_ROOT, 'data/file'))).toBe(false);
    });
  });

  describe('resolveProjectPath', () => {
    beforeEach(() => {
      pathGuard.configure({ projectRoot: PROJECT_ROOT });
    });

    test('should resolve relative paths within projectRoot', () => {
      const resolved = pathGuard.resolveProjectPath('.autosnippet/autosnippet.db');
      expect(resolved).toBe(path.join(PROJECT_ROOT, '.autosnippet/autosnippet.db'));
    });

    test('should reject relative paths that escape projectRoot', () => {
      expect(() => pathGuard.resolveProjectPath('../../etc/passwd')).toThrow(PathGuardError);
    });
  });

  describe('extraAllowPaths', () => {
    test('should allow custom whitelist directories', () => {
      pathGuard.configure({
        projectRoot: PROJECT_ROOT,
        extraAllowPaths: ['/custom/allowed/dir'],
      });
      expect(() => pathGuard.assertSafe('/custom/allowed/dir/file.txt')).not.toThrow();
    });

    test('should reject non-absolute extraAllowPaths', () => {
      pathGuard.configure({
        projectRoot: PROJECT_ROOT,
        extraAllowPaths: ['relative/path'],
      });
      expect(() => pathGuard.assertSafe('/somewhere/else/file.txt')).toThrow(PathGuardError);
    });
  });

  describe('PathGuardError', () => {
    test('should include target path and project root in message', () => {
      const error = new PathGuardError('/bad/path', '/good/root');
      expect(error.message).toContain('/bad/path');
      expect(error.message).toContain('/good/root');
      expect(error.name).toBe('PathGuardError');
      expect(error.targetPath).toBe('/bad/path');
      expect(error.projectRoot).toBe('/good/root');
    });

    test('should include custom reason when provided', () => {
      const error = new PathGuardError('/bad/path', '/good/root', '自定义原因');
      expect(error.message).toContain('自定义原因');
    });
  });
});
