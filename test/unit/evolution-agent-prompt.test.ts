/**
 * evolution-agent-prompt.test.ts
 *
 * buildEvolverPrompt 的 Prompt 构建测试:
 *   - 正确注入衰退 Recipe 清单
 *   - 证据明细格式
 *   - 决策指令存在
 *   - 边界: 空 decayedRecipes
 */

import { describe, expect, it } from 'vitest';
import {
  buildEvolverPrompt,
  EVOLVER_BUDGET,
  EVOLVER_SYSTEM_PROMPT,
  EVOLVER_TOOLS,
  type EvolutionContext,
} from '../../lib/agent/domain/insight-evolver.js';

// ── Fixtures ─────────────────────────────────────────────

function makeContext(overrides: Partial<EvolutionContext> = {}): EvolutionContext {
  return {
    decayedRecipes: [
      {
        id: 'recipe-abc',
        title: 'WBISigner 请求签名',
        trigger: '@wbi-signer-pattern',
        sourceRefs: ['Sources/NetworkKit/WBISigner.swift'],
        content: {
          markdown: 'WBI 签名实现...',
          rationale: '安全认证',
          coreCode: 'func sign(params: [String: Any]) -> String { ... }',
        },
        audit: {
          relevanceScore: 35,
          verdict: 'decay',
          evidence: {
            sourceFileExists: false,
            triggerStillMatches: true,
            symbolsAlive: 0.2,
            depsIntact: false,
            codeFilesExist: 0.3,
          },
          decayReasons: ['源文件不存在', '符号存活率低于阈值'],
        },
      },
      {
        id: 'recipe-def',
        title: 'SessionPool 隔离策略',
        trigger: '@session-pool-isolation',
        audit: {
          relevanceScore: 18,
          verdict: 'severe',
          evidence: {
            sourceFileExists: true,
            triggerStillMatches: false,
            symbolsAlive: 0.1,
            depsIntact: true,
            codeFilesExist: 0.5,
          },
          decayReasons: ['Trigger 不再匹配', '符号几乎全部消失'],
        },
        existingProposal: {
          id: 'prop-001',
          type: 'deprecate',
          status: 'pending',
          expiresAt: Date.now() + 86400000,
        },
      },
    ],
    dimensionId: 'network',
    dimensionLabel: 'Network',
    projectOverview: {
      primaryLang: 'swift',
      fileCount: 120,
      modules: ['NetworkKit', 'AuthService', 'BiliCore'],
    },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────

describe('buildEvolverPrompt', () => {
  it('should include recipe count and dimension info', () => {
    const prompt = buildEvolverPrompt(null, null, makeContext());
    expect(prompt).toContain('**2**');
    expect(prompt).toContain('Network');
    expect(prompt).toContain('network');
  });

  it('should include project overview', () => {
    const prompt = buildEvolverPrompt(null, null, makeContext());
    expect(prompt).toContain('swift');
    expect(prompt).toContain('120');
    expect(prompt).toContain('NetworkKit');
  });

  it('should render recipe details with audit evidence', () => {
    const prompt = buildEvolverPrompt(null, null, makeContext());
    // Recipe 1
    expect(prompt).toContain('WBISigner 请求签名');
    expect(prompt).toContain('recipe-abc');
    expect(prompt).toContain('@wbi-signer-pattern');
    expect(prompt).toContain('35/100');
    expect(prompt).toContain('DECAY');
    // Evidence checkmarks
    expect(prompt).toContain('源文件存在: ❌');
    expect(prompt).toContain('Trigger 仍匹配: ✅');
    expect(prompt).toContain('20%'); // symbolsAlive 0.2
    // Decay reasons
    expect(prompt).toContain('源文件不存在');
    // Source refs
    expect(prompt).toContain('WBISigner.swift');
  });

  it('should render severe recipe correctly', () => {
    const prompt = buildEvolverPrompt(null, null, makeContext());
    expect(prompt).toContain('SEVERE');
    expect(prompt).toContain('SessionPool 隔离策略');
    expect(prompt).toContain('recipe-def');
    expect(prompt).toContain('18/100');
  });

  it('should include existing proposal info', () => {
    const prompt = buildEvolverPrompt(null, null, makeContext());
    expect(prompt).toContain('已有 Proposal');
    expect(prompt).toContain('deprecate');
    expect(prompt).toContain('pending');
  });

  it('should include decision instructions', () => {
    const prompt = buildEvolverPrompt(null, null, makeContext());
    expect(prompt).toContain('决策指令');
    expect(prompt).toContain('submit_knowledge');
    expect(prompt).toContain('confirm_deprecation');
    expect(prompt).toContain('skip_evolution');
    expect(prompt).toContain('supersedes');
  });

  it('should truncate long coreCode', () => {
    const longCode = 'x'.repeat(500);
    const ctx = makeContext({
      decayedRecipes: [
        {
          id: 'r1',
          title: 'Long code recipe',
          trigger: '@long-code',
          content: { coreCode: longCode },
          audit: {
            relevanceScore: 40,
            verdict: 'decay',
            evidence: {
              sourceFileExists: true,
              triggerStillMatches: true,
              symbolsAlive: 0.5,
              depsIntact: true,
              codeFilesExist: 0.8,
            },
            decayReasons: ['test'],
          },
        },
      ],
    });
    const prompt = buildEvolverPrompt(null, null, ctx);
    // Should contain truncated code (300 chars + ...)
    expect(prompt).toContain('...');
    expect(prompt).not.toContain(longCode);
  });

  it('should handle empty decayedRecipes gracefully', () => {
    const ctx = makeContext({ decayedRecipes: [] });
    const prompt = buildEvolverPrompt(null, null, ctx);
    expect(prompt).toContain('**0**');
    expect(prompt).toContain('决策指令');
  });

  it('should include module list in overview', () => {
    const prompt = buildEvolverPrompt(null, null, makeContext());
    expect(prompt).toContain('NetworkKit');
    expect(prompt).toContain('AuthService');
    expect(prompt).toContain('BiliCore');
  });
});

describe('EVOLVER_SYSTEM_PROMPT', () => {
  it('should be a non-empty string', () => {
    expect(typeof EVOLVER_SYSTEM_PROMPT).toBe('string');
    expect(EVOLVER_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it('should mention three decision types', () => {
    expect(EVOLVER_SYSTEM_PROMPT).toContain('confirm_deprecation');
    expect(EVOLVER_SYSTEM_PROMPT).toContain('skip_evolution');
    expect(EVOLVER_SYSTEM_PROMPT).toContain('submit_knowledge');
  });
});

describe('EVOLVER_TOOLS', () => {
  it('should contain exactly 5 tools', () => {
    expect(EVOLVER_TOOLS).toHaveLength(5);
  });

  it('should include all required tools', () => {
    expect(EVOLVER_TOOLS).toContain('read_project_file');
    expect(EVOLVER_TOOLS).toContain('search_project_code');
    expect(EVOLVER_TOOLS).toContain('submit_knowledge');
    expect(EVOLVER_TOOLS).toContain('confirm_deprecation');
    expect(EVOLVER_TOOLS).toContain('skip_evolution');
  });
});

describe('EVOLVER_BUDGET', () => {
  it('should have expected budget values', () => {
    expect(EVOLVER_BUDGET.maxIterations).toBe(16);
    expect(EVOLVER_BUDGET.searchBudget).toBe(8);
    expect(EVOLVER_BUDGET.maxSubmits).toBe(5);
    expect(EVOLVER_BUDGET.idleRoundsToExit).toBe(2);
  });
});
