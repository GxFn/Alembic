/**
 * evolution-agent-prompt.test.ts
 *
 * buildEvolverPrompt 的 Prompt 构建测试:
 *   - 正确注入现有 Recipe 清单（含编号）
 *   - 可选 audit hint 格式
 *   - 提案驱动的决策指令
 *   - 验证工作流步骤
 *   - 边界: 空 existingRecipes
 */

import { describe, expect, it } from 'vitest';
import {
  buildEvolverPrompt,
  EVOLVER_BUDGET,
  EVOLVER_SYSTEM_PROMPT,
  EVOLVER_TOOLS,
  type EvolutionContext,
} from '../../lib/agent/prompts/insight-evolver.js';

// ── Fixtures ─────────────────────────────────────────────

function makeContext(overrides: Partial<EvolutionContext> = {}): EvolutionContext {
  return {
    existingRecipes: [
      {
        id: 'recipe-abc',
        title: 'WBISigner 请求签名',
        trigger: '@wbi-signer-pattern',
        sourceRefs: ['Sources/NetworkKit/WBISigner.swift'],
        content: {
          markdown: 'WBI 签名实现...',
          rationale: '安全认证需要 WBI 签名以防 API 滥用',
          coreCode: 'func sign(params: [String: Any]) -> String { ... }',
        },
        auditHint: {
          relevanceScore: 35,
          verdict: 'decay',
          evidence: {
            triggerStillMatches: true,
            symbolsAlive: 0.2,
            depsIntact: false,
            codeFilesExist: 0.3,
          },
          decayReasons: ['符号存活率低于阈值'],
        },
      },
      {
        id: 'recipe-def',
        title: 'SessionPool 隔离策略',
        trigger: '@session-pool-isolation',
        content: {
          coreCode: 'class SessionPool { ... }',
        },
        // 无 auditHint — healthy Recipe
        auditHint: null,
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

  it('should render recipe details with numbered format', () => {
    const prompt = buildEvolverPrompt(null, null, makeContext());
    // Recipe 1 with numbering
    expect(prompt).toContain('[1/2]');
    expect(prompt).toContain('WBISigner 请求签名');
    expect(prompt).toContain('recipe-abc');
    expect(prompt).toContain('@wbi-signer-pattern');
    // Recipe 2 with numbering
    expect(prompt).toContain('[2/2]');
    expect(prompt).toContain('SessionPool 隔离策略');
  });

  it('should render source refs with read instruction', () => {
    const prompt = buildEvolverPrompt(null, null, makeContext());
    expect(prompt).toContain('WBISigner.swift');
    expect(prompt).toContain('read_project_file');
  });

  it('should render recipe core code with verification framing', () => {
    const prompt = buildEvolverPrompt(null, null, makeContext());
    expect(prompt).toContain('Recipe 声称的核心代码');
    expect(prompt).toContain('func sign');
  });

  it('should render rationale when present', () => {
    const prompt = buildEvolverPrompt(null, null, makeContext());
    expect(prompt).toContain('设计原理');
    expect(prompt).toContain('WBI 签名');
  });

  it('should render audit hint in compact format', () => {
    const prompt = buildEvolverPrompt(null, null, makeContext());
    expect(prompt).toContain('系统预检提示');
    expect(prompt).toContain('35/100');
    expect(prompt).toContain('decay');
    expect(prompt).toContain('Trigger: ✅');
    expect(prompt).toContain('20%'); // symbolsAlive 0.2
    expect(prompt).toContain('符号存活率低于阈值');
  });

  it('should render recipe without audit hint (healthy)', () => {
    const prompt = buildEvolverPrompt(null, null, makeContext());
    expect(prompt).toContain('SessionPool 隔离策略');
    expect(prompt).toContain('recipe-def');
  });

  it('should include proposal-based decision instructions', () => {
    const prompt = buildEvolverPrompt(null, null, makeContext());
    expect(prompt).toContain('决策指令');
    // Proposal-based: propose_evolution instead of submit_knowledge
    expect(prompt).toContain('propose_evolution');
    expect(prompt).toContain('confirm_deprecation');
    expect(prompt).toContain('skip_evolution');
    // Should NOT reference submit_knowledge (proposal approach)
    expect(prompt).not.toContain('submit_knowledge');
    expect(prompt).not.toContain('supersedes');
  });

  it('should include structured verification workflow', () => {
    const prompt = buildEvolverPrompt(null, null, makeContext());
    expect(prompt).toContain('验证工作流');
    expect(prompt).toContain('步骤 1');
    expect(prompt).toContain('步骤 2');
    expect(prompt).toContain('步骤 3');
    expect(prompt).toContain('read_project_file');
    expect(prompt).toContain('search_project_code');
  });

  it('should show propose_evolution JSON example with evidence fields', () => {
    const prompt = buildEvolverPrompt(null, null, makeContext());
    expect(prompt).toContain('sourceStatus');
    expect(prompt).toContain('currentCode');
    expect(prompt).toContain('suggestedChanges');
    expect(prompt).toContain('confidence');
  });

  it('should truncate long coreCode at 400 chars', () => {
    const longCode = 'x'.repeat(500);
    const ctx = makeContext({
      existingRecipes: [
        {
          id: 'r1',
          title: 'Long code recipe',
          trigger: '@long-code',
          content: { coreCode: longCode },
        },
      ],
    });
    const prompt = buildEvolverPrompt(null, null, ctx);
    expect(prompt).toContain('...');
    expect(prompt).not.toContain(longCode);
  });

  it('should handle empty existingRecipes gracefully', () => {
    const ctx = makeContext({ existingRecipes: [] });
    const prompt = buildEvolverPrompt(null, null, ctx);
    expect(prompt).toContain('**0**');
    expect(prompt).toContain('决策指令');
  });

  it('should handle recipe without sourceRefs', () => {
    const ctx = makeContext({
      existingRecipes: [
        {
          id: 'r1',
          title: 'No source recipe',
          trigger: '@no-source',
        },
      ],
    });
    const prompt = buildEvolverPrompt(null, null, ctx);
    expect(prompt).toContain('search_project_code');
    expect(prompt).toContain('无');
  });

  it('should include module list in overview', () => {
    const prompt = buildEvolverPrompt(null, null, makeContext());
    expect(prompt).toContain('NetworkKit');
    expect(prompt).toContain('AuthService');
    expect(prompt).toContain('BiliCore');
  });

  it('should use neutral framing (not assume decay)', () => {
    const prompt = buildEvolverPrompt(null, null, makeContext());
    expect(prompt).toContain('现有 Recipe');
    expect(prompt).toContain('真实性');
    expect(prompt).not.toContain('衰退 Recipe 清单');
  });

  it('should distinguish skip reasons in examples', () => {
    const prompt = buildEvolverPrompt(null, null, makeContext());
    expect(prompt).toContain('验证有效');
    expect(prompt).toContain('信息不足');
  });
});

describe('EVOLVER_SYSTEM_PROMPT', () => {
  it('should be a non-empty string', () => {
    expect(typeof EVOLVER_SYSTEM_PROMPT).toBe('string');
    expect(EVOLVER_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it('should mention proposal-based decision tools', () => {
    expect(EVOLVER_SYSTEM_PROMPT).toContain('propose_evolution');
    expect(EVOLVER_SYSTEM_PROMPT).toContain('confirm_deprecation');
    expect(EVOLVER_SYSTEM_PROMPT).toContain('skip_evolution');
    // Should NOT reference submit_knowledge
    expect(EVOLVER_SYSTEM_PROMPT).not.toContain('submit_knowledge');
  });

  it('should frame as proposal-driven verification', () => {
    expect(EVOLVER_SYSTEM_PROMPT).toContain('真实性');
    expect(EVOLVER_SYSTEM_PROMPT).toContain('提案');
    expect(EVOLVER_SYSTEM_PROMPT).toContain('不创建新 Recipe');
    expect(EVOLVER_SYSTEM_PROMPT).toContain('read_project_file');
    expect(EVOLVER_SYSTEM_PROMPT).toContain('search_project_code');
  });

  it('should include decision table with verification results', () => {
    expect(EVOLVER_SYSTEM_PROMPT).toContain('验证结果');
    expect(EVOLVER_SYSTEM_PROMPT).toContain('代码匹配');
    expect(EVOLVER_SYSTEM_PROMPT).toContain('观察窗口');
  });
});

describe('EVOLVER_TOOLS', () => {
  it('should contain the full verification and decision toolset', () => {
    expect(EVOLVER_TOOLS).toEqual([
      'read_project_file',
      'search_project_code',
      'semantic_search_code',
      'query_code_graph',
      'query_call_graph',
      'search_recipes',
      'get_recipe_detail',
      'quality_score',
      'propose_evolution',
      'confirm_deprecation',
      'skip_evolution',
    ]);
  });

  it('should include proposal-based tools (no submit_knowledge)', () => {
    expect(EVOLVER_TOOLS).toContain('read_project_file');
    expect(EVOLVER_TOOLS).toContain('search_project_code');
    expect(EVOLVER_TOOLS).toContain('propose_evolution');
    expect(EVOLVER_TOOLS).toContain('confirm_deprecation');
    expect(EVOLVER_TOOLS).toContain('skip_evolution');
    expect(EVOLVER_TOOLS).not.toContain('submit_knowledge');
  });
});

describe('EVOLVER_BUDGET', () => {
  it('should have expected budget values', () => {
    expect(EVOLVER_BUDGET.maxIterations).toBe(20);
    expect(EVOLVER_BUDGET.searchBudget).toBe(10);
    expect(EVOLVER_BUDGET.maxSubmits).toBe(8);
    expect(EVOLVER_BUDGET.idleRoundsToExit).toBe(2);
  });
});
