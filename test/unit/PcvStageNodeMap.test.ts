import { afterEach, describe, expect, test } from 'vitest';
import type { AgentResultLike } from '../../lib/recipe-pipeline/generate/execution/AgentRunProjections.js';
import {
  buildPcvAnalyzeGroundingLedgerSummary,
  buildPcvN8StageFactoryEvidence,
} from '../../lib/recipe-pipeline/generate/execution/PcvStageNodeMap.js';

const envBackup = { ...process.env };

afterEach(() => {
  process.env = { ...envBackup };
});

// AP-6：主体消费方据上游 AP-4 标记 groundingEnforcement 把 analyze grounding ledger summary 改判审计语义。
// 两模式 + 标记缺失三态，固定 ledger（1 evidence-produced + 1 invalid-no-evidence）只改 enforcement，
// 验证 observe-only 不误判 linkage 回归（R6）、guard 保持原判定、缺失向后兼容。
function runResultWith(enforcement?: 'off' | 'guard'): AgentResultLike {
  return {
    phases: {},
    pcvNodeEvidence: {
      groundingEnforcement: enforcement,
      groundingLedger: [
        { ref: 'burn-1', classification: 'evidence-produced' },
        { ref: 'burn-2', classification: 'invalid-no-evidence' },
      ],
    },
  };
}

describe('buildPcvAnalyzeGroundingLedgerSummary grounding enforcement audit semantics (AP-6)', () => {
  test("observe-only ('off') records invalid-no-evidence as audit material without a linkage regression", () => {
    const summary = buildPcvAnalyzeGroundingLedgerSummary({
      dimId: 'api',
      runResult: runResultWith('off'),
    });
    expect(summary).not.toBeNull();
    // 审计材料始终保留：计数不变。
    expect(summary?.invalidNoEvidenceCount).toBe(1);
    expect(summary?.evidenceProducedCount).toBe(1);
    // R6：observe-only 下不推 missingLink、不降级 status。
    expect(summary?.missingLinkReasons).not.toContain('analyze_grounding_invalid_no_evidence');
    expect(summary?.status).toBe('linked');
    // 模式落入输出供审计追溯，summary 文案标注审计判读。
    expect(summary?.groundingEnforcement).toBe('off');
    expect(summary?.summary).toContain('audit material');
  });

  test("guard ('guard') keeps the original quality judgment (invalid-no-evidence is a real signal)", () => {
    const summary = buildPcvAnalyzeGroundingLedgerSummary({
      dimId: 'api',
      runResult: runResultWith('guard'),
    });
    expect(summary).not.toBeNull();
    expect(summary?.invalidNoEvidenceCount).toBe(1);
    expect(summary?.missingLinkReasons).toContain('analyze_grounding_invalid_no_evidence');
    expect(summary?.status).toBe('partial-evidence');
    expect(summary?.groundingEnforcement).toBe('guard');
    expect(summary?.summary).not.toContain('audit material');
  });

  test('absent marker is backward-compatible: original judgment, no fabricated mode field', () => {
    const summary = buildPcvAnalyzeGroundingLedgerSummary({
      dimId: 'api',
      runResult: runResultWith(),
    });
    expect(summary).not.toBeNull();
    expect(summary?.missingLinkReasons).toContain('analyze_grounding_invalid_no_evidence');
    expect(summary?.status).toBe('partial-evidence');
    expect(summary?.groundingEnforcement).toBeUndefined();
  });
});

describe('buildPcvN8StageFactoryEvidence terminal policy projection', () => {
  test('projects legacy terminal toolset config as the live exec-only terminal surface', () => {
    process.env.ALEMBIC_TERMINAL_TOOLSET = 'terminal-pty';

    const evidence = buildPcvN8StageFactoryEvidence({
      dimId: 'api',
      plan: {
        hasExistingRecipes: false,
        needsCandidates: true,
        prescreenDone: false,
      } as never,
      runInput: {
        context: {},
        params: {},
        profile: { id: 'missing-profile' },
      } as never,
    });

    const analyzePolicy = evidence.stageToolPolicies.find((stage) => stage.stage === 'analyze');
    expect(analyzePolicy).toMatchObject({
      terminalAllowed: true,
      terminalTools: ['terminal'],
    });
    expect(evidence.stageToolPolicies.flatMap((stage) => stage.terminalTools)).toEqual(
      expect.arrayContaining(['terminal'])
    );
  });
});
