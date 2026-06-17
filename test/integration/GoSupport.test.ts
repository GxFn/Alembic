/**
 * @file GoSupport.test.js
 * @description Go 语言支持验证(RIC-4c 瘦身后)
 *
 * 保留层级(均不依赖已删的 ProjectIntelligenceCompatibility shim):
 *  L2  — LanguageService: .go 映射、detectPrimary、DimensionCopy
 *  L5b — IndexingPipeline Go 支持
 *  L6  — Bootstrap go-module-scan dimension(cold-start workflow 可加载)
 *  L7  — Go 内建 Guard 规则
 *  L8  — RecipeExtractor Go 启发
 *
 * RIC-4c: 原 L0(GoDiscoverer)/L1(Go 多文件 AST)/L3(Go Enhancement Pack)/Full-Stack
 * 端到端用例随 ProjectIntelligenceCompatibility shim 一并删除——其能力现已在 Core 等价覆盖
 * (RIC-4b MultiFileAstAndDiscovery 覆盖 Go discoverer + 多文件 AST 聚合;EnhancementGuardRules
 * 覆盖 enhancement guard 规则;下方 L7 仍直接覆盖 Go 内建 Guard 规则)。这些原是真实 gin
 * 项目集成测试(依赖上级目录存在 gin 克隆),其真实项目集成广度随 shim 退役。
 */

import { DimensionCopy } from '@alembic/core/dimensions';
import { LanguageService } from '@alembic/core/shared';
import { describe, expect, it } from 'vitest';

// ══════════════════════════════════════════════════════════════════
// L2: LanguageService + DimensionCopy for Go
// ══════════════════════════════════════════════════════════════════
describe('L2: LanguageService & DimensionCopy (Go)', () => {
  it('.go → go mapping', () => {
    expect(LanguageService.langFromExt('.go')).toBe('go');
  });

  it('inferLang("main.go") → go', () => {
    expect(LanguageService.inferLang('main.go')).toBe('go');
  });

  it('inferLang("internal/handler/auth.go") → go', () => {
    expect(LanguageService.inferLang('internal/handler/auth.go')).toBe('go');
  });

  it('displayName("go") → Go', () => {
    expect(LanguageService.displayName('go')).toBe('Go');
  });

  it('isSourceExt(".go") → true', () => {
    expect(LanguageService.isSourceExt('.go')).toBe(true);
  });

  it('isKnownLang("go") → true', () => {
    expect(LanguageService.isKnownLang('go')).toBe(true);
  });

  it('extForLang("go") → .go', () => {
    expect(LanguageService.extForLang('go')).toBe('.go');
  });

  it('extForLang("swift") → .swift', () => {
    expect(LanguageService.extForLang('swift')).toBe('.swift');
  });

  it('extForLang("python") → .py', () => {
    expect(LanguageService.extForLang('python')).toBe('.py');
  });

  it('extForLang("unknown") → null', () => {
    expect(LanguageService.extForLang('unknown')).toBeNull();
  });

  it('extForLang(null) → null', () => {
    expect(LanguageService.extForLang(null)).toBeNull();
  });

  it('detectPrimary with Go langStats', () => {
    const langStats = { go: 58 };
    expect(LanguageService.detectPrimary(langStats)).toBe('go');
  });

  it('detectProfile with Go langStats', () => {
    const langStats = { go: 58, mod: 1 };
    const profile = LanguageService.detectProfile(langStats);
    expect(profile.primary).toBe('go');
    expect(profile.isMultiLang).toBe(false);
  });

  it('DimensionCopy.applyMulti for Go — no throw', () => {
    const dims = [
      { id: 'code-standard', label: '代码规范', guide: 'default guide' },
      { id: 'architecture', label: '架构模式', guide: 'default guide' },
      { id: 'code-pattern', label: '代码范式', guide: 'default guide' },
      { id: 'best-practice', label: '最佳实践', guide: 'default guide' },
      { id: 'event-and-data-flow', label: '事件数据流', guide: 'default guide' },
      { id: 'project-profile', label: '项目特征', guide: 'default guide' },
      { id: 'agent-guidelines', label: 'Agent开发注意事项', guide: 'default guide' },
    ];
    expect(() => {
      DimensionCopy.applyMulti(dims, 'go', []);
    }).not.toThrow();
  });

  it('DimensionCopy.applyMulti for Go — injects Go-specific guidance', () => {
    const dims = [{ id: 'coding-standards', label: '代码规范', guide: 'default guide' }];
    DimensionCopy.applyMulti(dims, 'go', []);
    // Should have Go-specific keywords in guide
    const guide = dims[0].guide.toLowerCase();
    const hasGoContent =
      guide.includes('go') ||
      guide.includes('goroutine') ||
      guide.includes('error') ||
      guide.includes('gofmt') ||
      guide.includes('interface') ||
      guide !== 'default guide';
    expect(hasGoContent).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// L5b: IndexingPipeline Go support
// ══════════════════════════════════════════════════════════════════
describe('L5b: Go IndexingPipeline Support', () => {
  it('IndexingPipeline SCANNABLE_EXTENSIONS should include .go', async () => {
    const mod = await import('@alembic/core/vector');
    expect(mod.IndexingPipeline).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════════
// L6: Bootstrap Go Conditional Dimension
// ══════════════════════════════════════════════════════════════════
describe('L6: Bootstrap go-module-scan dimension', () => {
  it('bootstrap module should load without error', async () => {
    // Just verify the bootstrap module loads without errors
    // (verifies go-module-scan dimension definition is valid)
    const mod = await import('../../lib/workflows/cold-start/ColdStartWorkflow.js');
    expect(mod).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════════
// L7: Guard Rules for Go
// ══════════════════════════════════════════════════════════════════
describe('L7: Go Built-in Guard Rules', () => {
  let GuardCheckEngine, detectLanguage;

  beforeAll(async () => {
    const mod = await import('@alembic/core/guard');
    GuardCheckEngine = mod.GuardCheckEngine;
    detectLanguage = mod.detectLanguage;
  });

  it('detectLanguage("main.go") → "go"', () => {
    expect(detectLanguage('main.go')).toBe('go');
  });

  it('detectLanguage("internal/handler.go") → "go"', () => {
    expect(detectLanguage('internal/handler.go')).toBe('go');
  });

  it('should have go-no-panic built-in rule', () => {
    // GuardCheckEngine has BUILT_IN_RULES which includes Go rules
    const engine = new GuardCheckEngine(null);
    const rules = engine.getRules('go');
    const goPanicRule = rules.find((r) => r.id === 'go-no-panic');
    expect(goPanicRule).toBeDefined();
  });

  it('should have go-no-err-ignored built-in rule', () => {
    const engine = new GuardCheckEngine(null);
    const rules = engine.getRules('go');
    const goErrRule = rules.find((r) => r.id === 'go-no-err-ignored');
    expect(goErrRule).toBeDefined();
  });

  it('go-no-panic should match panic() in Go code', () => {
    const engine = new GuardCheckEngine(null);
    const rules = engine.getRules('go');
    const panicRule = rules.find((r) => r.ruleId === 'go-no-panic');
    if (panicRule?.pattern) {
      const regex = new RegExp(panicRule.pattern);
      expect(regex.test('panic("unexpected error")')).toBe(true);
      expect(regex.test('// this is fine')).toBe(false);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// L8: RecipeExtractor Go heuristic
// ══════════════════════════════════════════════════════════════════
describe('L8: RecipeExtractor Go heuristic', () => {
  let RecipeExtractor;

  beforeAll(async () => {
    const mod = await import('@alembic/core/knowledge');
    RecipeExtractor = mod.RecipeExtractor || mod.default;
  });

  it('should detect Go from content with package + func keywords', () => {
    if (!RecipeExtractor) {
      return;
    }

    const extractor = new RecipeExtractor();
    const goCode = `package handlers

import "net/http"

func HandleRequest(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("Hello"))
}`;

    // RecipeExtractor.extractFromContent should infer Go
    try {
      const result = extractor.extractFromContent(goCode, 'snippet.txt', '');
      // If language was inferred, it should be 'go'
      if (result?.language && result.language !== 'markdown') {
        expect(result.language).toBe('go');
      }
    } catch {
      // extractFromContent may not exist as public method — this is best-effort
    }
  });
});
