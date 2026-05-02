/**
 * V2 Tool System — Token 效率审计
 *
 * 对 BiliDili 项目执行每个工具的真实调用，
 * 捕获输出大小、token 估算、信噪比，输出审计报告。
 */

import { describe, expect, test } from 'vitest';
import { DeltaCache } from '#tools/v2/cache/DeltaCache.js';
import { SearchCache } from '#tools/v2/cache/SearchCache.js';
import { OutputCompressor } from '#tools/v2/compressor/OutputCompressor.js';
import { ToolRouterV2 } from '#tools/v2/router.js';
import type { ToolContext, ToolResult } from '#tools/v2/types.js';

const BILIDILI_ROOT = '/Users/gaoxuefeng/Documents/github/BiliDili';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    projectRoot: BILIDILI_ROOT,
    deltaCache: new DeltaCache(50),
    searchCache: new SearchCache(50),
    compressor: new OutputCompressor(),
    sessionStore: {
      save() {},
      recall() {
        return [];
      },
    },
    tokenBudget: 8000,
    ...overrides,
  };
}

interface AuditEntry {
  tool: string;
  action: string;
  scenario: string;
  dataType: string;
  rawChars: number;
  tokensEstimate: number;
  durationMs: number;
  charsPerToken: number;
  ok: boolean;
}

const audit: AuditEntry[] = [];

function recordAudit(tool: string, action: string, scenario: string, result: ToolResult) {
  const raw = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
  const rawChars = raw.length;
  const tokens = result._meta?.tokensEstimate ?? Math.ceil(rawChars / 4);
  const duration = result._meta?.durationMs ?? 0;

  audit.push({
    tool,
    action,
    scenario,
    dataType: typeof result.data === 'string' ? 'string' : 'object',
    rawChars,
    tokensEstimate: tokens,
    durationMs: duration,
    charsPerToken: tokens > 0 ? Math.round((rawChars / tokens) * 10) / 10 : 0,
    ok: result.ok,
  });
}

describe('Token 效率审计 — BiliDili 真实数据', () => {
  const router = new ToolRouterV2();

  /* ────────── code.search ────────── */

  test('code.search: ViewController 类定义', async () => {
    const ctx = makeCtx();
    const result = await router.execute(
      {
        tool: 'code',
        action: 'search',
        params: { patterns: ['class.*ViewController'], regex: true, maxResults: 10 },
      },
      ctx
    );
    recordAudit('code', 'search', 'ViewController regex (max 10)', result);
    expect(result.ok).toBe(true);
  });

  test('code.search: import UIKit (固定字符串)', async () => {
    const ctx = makeCtx();
    const result = await router.execute(
      { tool: 'code', action: 'search', params: { patterns: ['import UIKit'], maxResults: 5 } },
      ctx
    );
    recordAudit('code', 'search', 'import UIKit literal (max 5)', result);
    expect(result.ok).toBe(true);
  });

  test('code.search: 无匹配', async () => {
    const ctx = makeCtx();
    const result = await router.execute(
      { tool: 'code', action: 'search', params: { patterns: ['ZZZZZ_NONEXISTENT_12345'] } },
      ctx
    );
    recordAudit('code', 'search', 'no match', result);
    expect(result.ok).toBe(true);
  });

  /* ────────── code.read ────────── */

  test('code.read: 小文件 README.md (132行)', async () => {
    const ctx = makeCtx();
    const result = await router.execute(
      { tool: 'code', action: 'read', params: { path: 'README.md' } },
      ctx
    );
    recordAudit('code', 'read', 'README.md full (132 lines)', result);
    expect(result.ok).toBe(true);
  });

  test('code.read: 中等文件 Package.swift (161行)', async () => {
    const ctx = makeCtx();
    const result = await router.execute(
      { tool: 'code', action: 'read', params: { path: 'Package.swift' } },
      ctx
    );
    recordAudit('code', 'read', 'Package.swift full (161 lines)', result);
    expect(result.ok).toBe(true);
  });

  test('code.read: 中等文件 行范围 1-20', async () => {
    const ctx = makeCtx();
    const result = await router.execute(
      {
        tool: 'code',
        action: 'read',
        params: { path: 'Package.swift', startLine: 1, endLine: 20 },
      },
      ctx
    );
    recordAudit('code', 'read', 'Package.swift lines 1-20', result);
    expect(result.ok).toBe(true);
  });

  test('code.read: 大文件 LiveRoomViewController (934行)', async () => {
    const ctx = makeCtx();
    const result = await router.execute(
      {
        tool: 'code',
        action: 'read',
        params: { path: 'Sources/Features/LiveChat/LiveRoomViewController.swift' },
      },
      ctx
    );
    recordAudit('code', 'read', 'LiveRoomVC.swift (934 lines, >500 threshold)', result);
    expect(result.ok).toBe(true);
  });

  test('code.read: DeltaCache 二次读取', async () => {
    const ctx = makeCtx();
    await router.execute({ tool: 'code', action: 'read', params: { path: 'README.md' } }, ctx);
    const result = await router.execute(
      { tool: 'code', action: 'read', params: { path: 'README.md' } },
      ctx
    );
    recordAudit('code', 'read', 'README.md deltaCache hit', result);
    expect(result.ok).toBe(true);
  });

  /* ────────── code.structure ────────── */

  test('code.structure: depth=1', async () => {
    const ctx = makeCtx();
    const result = await router.execute(
      { tool: 'code', action: 'structure', params: { depth: 1 } },
      ctx
    );
    recordAudit('code', 'structure', 'root depth=1', result);
    expect(result.ok).toBe(true);
  });

  test('code.structure: depth=3', async () => {
    const ctx = makeCtx();
    const result = await router.execute(
      { tool: 'code', action: 'structure', params: { depth: 3 } },
      ctx
    );
    recordAudit('code', 'structure', 'root depth=3', result);
    expect(result.ok).toBe(true);
  });

  test('code.structure: 子目录 Sources/Features depth=2', async () => {
    const ctx = makeCtx();
    const result = await router.execute(
      { tool: 'code', action: 'structure', params: { directory: 'Sources/Features', depth: 2 } },
      ctx
    );
    recordAudit('code', 'structure', 'Sources/Features depth=2', result);
    expect(result.ok).toBe(true);
  });

  /* ────────── terminal.exec ────────── */

  test('terminal.exec: echo', async () => {
    const ctx = makeCtx();
    const result = await router.execute(
      { tool: 'terminal', action: 'exec', params: { command: 'echo hello' } },
      ctx
    );
    recordAudit('terminal', 'exec', 'echo hello', result);
    expect(result.ok).toBe(true);
  });

  test('terminal.exec: git log', async () => {
    const ctx = makeCtx();
    const result = await router.execute(
      { tool: 'terminal', action: 'exec', params: { command: 'git log --oneline -10' } },
      ctx
    );
    recordAudit('terminal', 'exec', 'git log --oneline -10', result);
    expect(result.ok).toBe(true);
  });

  test('terminal.exec: wc -l *.swift', async () => {
    const ctx = makeCtx();
    const result = await router.execute(
      {
        tool: 'terminal',
        action: 'exec',
        params: { command: 'find Sources -name "*.swift" | wc -l' },
      },
      ctx
    );
    recordAudit('terminal', 'exec', 'find swift | wc -l', result);
    expect(result.ok).toBe(true);
  });

  test('terminal.exec: git status', async () => {
    const ctx = makeCtx();
    const result = await router.execute(
      { tool: 'terminal', action: 'exec', params: { command: 'git status' } },
      ctx
    );
    recordAudit('terminal', 'exec', 'git status', result);
    expect(result.ok).toBe(true);
  });

  /* ────────── meta.tools ────────── */

  test('meta.tools: 所有工具摘要', async () => {
    const ctx = makeCtx();
    const result = await router.execute({ tool: 'meta', action: 'tools', params: {} }, ctx);
    recordAudit('meta', 'tools', 'all tools summary', result);
    expect(result.ok).toBe(true);
  });

  test('meta.tools: code 工具详情', async () => {
    const ctx = makeCtx();
    const result = await router.execute(
      { tool: 'meta', action: 'tools', params: { name: 'code' } },
      ctx
    );
    recordAudit('meta', 'tools', 'code tool detail', result);
    expect(result.ok).toBe(true);
  });

  /* ────────── memory ────────── */

  test('memory: save + recall 流程', async () => {
    const store: Array<{ key: string; content: string; meta?: Record<string, unknown> }> = [];
    const ctx = makeCtx({
      sessionStore: {
        save(key: string, content: string, meta?: Record<string, unknown>) {
          store.push({ key, content, meta });
        },
        recall(query?: string, opts?: { tags?: string[]; limit?: number }) {
          let results = [...store];
          if (query) {
            const q = query.toLowerCase();
            results = results.filter(
              (e) => e.key.toLowerCase().includes(q) || e.content.toLowerCase().includes(q)
            );
          }
          return results.slice(0, opts?.limit ?? 20);
        },
      },
    });

    const saveResult = await router.execute(
      { tool: 'memory', action: 'save', params: { key: 'arch', content: 'MVVM with Coordinator' } },
      ctx
    );
    recordAudit('memory', 'save', 'save one item', saveResult);

    const recallResult = await router.execute(
      { tool: 'memory', action: 'recall', params: { query: 'MVVM' } },
      ctx
    );
    recordAudit('memory', 'recall', 'recall by query', recallResult);
    expect(recallResult.ok).toBe(true);
  });

  /* ────────── 审计报告 ────────── */

  test('输出审计报告', () => {
    console.log(`\n${'='.repeat(120)}`);
    console.log('V2 工具系统 — Token 效率审计报告 (BiliDili 真实数据)');
    console.log('='.repeat(120));

    const header = [
      'Tool'.padEnd(10),
      'Action'.padEnd(10),
      'Scenario'.padEnd(45),
      'Type'.padEnd(8),
      'Chars'.padStart(8),
      'Tokens'.padStart(8),
      'C/T'.padStart(6),
      'Ms'.padStart(6),
      'OK'.padStart(4),
    ].join(' | ');
    console.log(header);
    console.log('-'.repeat(120));

    let totalChars = 0;
    let totalTokens = 0;

    for (const e of audit) {
      totalChars += e.rawChars;
      totalTokens += e.tokensEstimate;

      const row = [
        e.tool.padEnd(10),
        e.action.padEnd(10),
        e.scenario.padEnd(45),
        e.dataType.padEnd(8),
        String(e.rawChars).padStart(8),
        String(e.tokensEstimate).padStart(8),
        String(e.charsPerToken).padStart(6),
        String(e.durationMs).padStart(6),
        (e.ok ? '✓' : '✗').padStart(4),
      ].join(' | ');
      console.log(row);
    }

    console.log('-'.repeat(120));
    console.log(
      `总计: ${audit.length} 个调用, ${totalChars} 字符, ${totalTokens} tokens (平均 ${(totalChars / totalTokens).toFixed(1)} chars/token)`
    );

    // 找出 token 消耗最大的 top 5
    const sorted = [...audit].sort((a, b) => b.tokensEstimate - a.tokensEstimate);
    console.log('\nToken 消耗 Top 5:');
    for (const e of sorted.slice(0, 5)) {
      console.log(`  ${e.tokensEstimate} tokens — ${e.tool}.${e.action}: ${e.scenario}`);
    }

    // 信噪比分析
    console.log('\n信噪比分析 (低 chars/token = 高密度, 4.0 为理论值):');
    for (const e of audit) {
      if (e.charsPerToken < 3.5 && e.tokensEstimate > 50) {
        console.log(
          `  ⚠️ ${e.tool}.${e.action} "${e.scenario}": ${e.charsPerToken} c/t — 可能含冗余结构`
        );
      }
    }

    console.log('='.repeat(120));

    expect(audit.length).toBeGreaterThan(0);
  });
});
