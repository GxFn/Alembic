/**
 * LanguageService.detectProjectLanguages 单元测试
 * 验证 discovererIds 路径的 JS/TS 启发式剔除逻辑
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import LanguageService from '../../lib/shared/LanguageService.js';

const TMP = join(tmpdir(), 'asd-langdetect-test');

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('detectProjectLanguages — discovererIds path', () => {
  it('node-only → returns javascript + typescript', () => {
    const langs = LanguageService.detectProjectLanguages(TMP, {
      discovererIds: ['node'],
    });
    expect(langs).toContain('javascript');
    expect(langs).toContain('typescript');
  });

  it('go + node → removes JS/TS, keeps go', () => {
    const langs = LanguageService.detectProjectLanguages(TMP, {
      discovererIds: ['go', 'node'],
    });
    expect(langs).toContain('go');
    expect(langs).not.toContain('javascript');
    expect(langs).not.toContain('typescript');
  });

  it('spm + node → removes JS/TS, keeps swift', () => {
    const langs = LanguageService.detectProjectLanguages(TMP, {
      discovererIds: ['spm', 'node'],
    });
    expect(langs).toContain('swift');
    expect(langs).not.toContain('javascript');
    expect(langs).not.toContain('typescript');
  });

  it('go-only → returns go', () => {
    const langs = LanguageService.detectProjectLanguages(TMP, {
      discovererIds: ['go'],
    });
    expect(langs).toEqual(['go']);
  });

  it('generic-only → falls through to file scan', () => {
    const langs = LanguageService.detectProjectLanguages(TMP, {
      discovererIds: ['generic'],
    });
    // generic 被过滤，走 Path 2（空目录无标记文件 → 空数组）
    expect(langs).toEqual([]);
  });
});

describe('detectProjectLanguages — file scan path', () => {
  it('go.mod + package.json → go only (JS/TS heuristic removes them)', () => {
    const dir = join(TMP, 'go-node-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'go.mod'), 'module example.com/cli\n');
    writeFileSync(join(dir, 'package.json'), '{"name":"scripts"}\n');
    const langs = LanguageService.detectProjectLanguages(dir, { maxDepth: 0 });
    expect(langs).toContain('go');
    expect(langs).not.toContain('javascript');
    expect(langs).not.toContain('typescript');
  });

  it('package.json only → returns javascript + typescript', () => {
    const dir = join(TMP, 'node-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"name":"app"}\n');
    const langs = LanguageService.detectProjectLanguages(dir, { maxDepth: 0 });
    expect(langs).toContain('javascript');
    expect(langs).toContain('typescript');
  });
});

// ── isTestFile ──────────────────────────────────────────

describe('LanguageService.isTestFile', () => {
  it('Go _test.go files are test files', () => {
    expect(LanguageService.isTestFile('/project/cmd/root_test.go')).toBe(true);
    expect(LanguageService.isTestFile('/project/cmd/root.go')).toBe(false);
  });

  it('Swift test files', () => {
    expect(LanguageService.isTestFile('/project/Tests/AppTests.swift')).toBe(true);
    expect(LanguageService.isTestFile('/project/Tests/AppTest.swift')).toBe(true);
    expect(LanguageService.isTestFile('/project/Sources/App.swift')).toBe(false);
  });

  it('JS/TS test files', () => {
    expect(LanguageService.isTestFile('/project/src/utils.test.ts')).toBe(true);
    expect(LanguageService.isTestFile('/project/src/utils.spec.js')).toBe(true);
    expect(LanguageService.isTestFile('/project/__tests__/foo.ts')).toBe(true);
    expect(LanguageService.isTestFile('/project/src/utils.ts')).toBe(false);
  });

  it('Python test files', () => {
    expect(LanguageService.isTestFile('/project/tests/test_api.py')).toBe(true);
    expect(LanguageService.isTestFile('/project/tests/api_test.py')).toBe(true);
    expect(LanguageService.isTestFile('/project/src/api.py')).toBe(false);
  });

  it('Rust test files', () => {
    expect(LanguageService.isTestFile('/project/tests/integration_test.rs')).toBe(true);
    expect(LanguageService.isTestFile('/project/src/lib.rs')).toBe(false);
  });

  it('Java/Kotlin test files', () => {
    expect(LanguageService.isTestFile('/project/src/test/java/AppTest.java')).toBe(true);
    expect(LanguageService.isTestFile('/project/src/main/java/App.java')).toBe(false);
  });

  it('test directory pattern catches without language-specific name', () => {
    expect(LanguageService.isTestFile('/project/test/helpers/fixture.go')).toBe(true);
    expect(LanguageService.isTestFile('/project/__tests__/helpers.ts')).toBe(true);
    expect(LanguageService.isTestFile('/project/testdata/sample.json')).toBe(true);
  });

  it('non-test files in normal directories', () => {
    expect(LanguageService.isTestFile('/project/cmd/main.go')).toBe(false);
    expect(LanguageService.isTestFile('/project/src/index.ts')).toBe(false);
    expect(LanguageService.isTestFile('/project/lib/app.rb')).toBe(false);
  });
});
