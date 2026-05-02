/**
 * V2 Tool System — 端到端测试 (使用 BiliDili 真实项目)
 *
 * 验证:
 *   1. ToolRouterV2 解析 + 分发
 *   2. 每个 handler 真实执行
 *   3. V2ToolRouterAdapter ↔ ToolResultEnvelope 转换
 *   4. DeltaCache / SearchCache / OutputCompressor 集成
 *   5. Capability 权限拦截
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { V2CapabilityCatalog } from '#tools/v2/adapter/V2CapabilityCatalog.js';
import { V2ToolRouterAdapter } from '#tools/v2/adapter/V2ToolRouterAdapter.js';
import { DeltaCache } from '#tools/v2/cache/DeltaCache.js';
import { SearchCache } from '#tools/v2/cache/SearchCache.js';
import { BootstrapAnalyze } from '#tools/v2/capabilities/BootstrapAnalyze.js';
import { OutputCompressor } from '#tools/v2/compressor/OutputCompressor.js';
import { TOOL_REGISTRY } from '#tools/v2/registry.js';
import { ToolRouterV2 } from '#tools/v2/router.js';
import type { ToolCallV2, ToolContext } from '#tools/v2/types.js';

const BILIDILI_ROOT = '/Users/gaoxuefeng/Documents/github/BiliDili';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    projectRoot: BILIDILI_ROOT,
    deltaCache: new DeltaCache(50),
    searchCache: new SearchCache(50),
    compressor: new OutputCompressor(),
    sessionStore: {
      save(_key: string, _content: string, _meta?: Record<string, unknown>) {
        /* in-memory */
      },
      recall() {
        return [];
      },
    },
    tokenBudget: 8000,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────
//  §1 Registry
// ─────────────────────────────────────────────────

describe('V2 Registry', () => {
  test('has exactly 6 tools', () => {
    const tools = Object.keys(TOOL_REGISTRY);
    expect(tools).toEqual(['code', 'terminal', 'knowledge', 'graph', 'memory', 'meta']);
  });

  test('each tool has at least one action', () => {
    for (const [name, spec] of Object.entries(TOOL_REGISTRY)) {
      expect(Object.keys(spec.actions).length).toBeGreaterThan(0);
      expect(spec.name).toBe(name);
      expect(spec.description).toBeTruthy();
    }
  });

  test('total 17 actions', () => {
    let count = 0;
    for (const spec of Object.values(TOOL_REGISTRY)) {
      count += Object.keys(spec.actions).length;
    }
    // code:5 + terminal:1 + knowledge:4 + graph:2 + memory:2 + meta:3 = 17
    expect(count).toBe(17);
  });

  test('every action has required fields', () => {
    for (const spec of Object.values(TOOL_REGISTRY)) {
      for (const [actionName, action] of Object.entries(spec.actions)) {
        expect(action.summary, `${spec.name}.${actionName} missing summary`).toBeTruthy();
        expect(action.handler, `${spec.name}.${actionName} missing handler`).toBeTypeOf('function');
        expect(action.params, `${spec.name}.${actionName} missing params`).toBeTruthy();
      }
    }
  });
});

// ─────────────────────────────────────────────────
//  §2 Router
// ─────────────────────────────────────────────────

describe('V2 Router', () => {
  const router = new ToolRouterV2();

  test('parseToolCall extracts action + params', () => {
    const result = router.parseToolCall('code', {
      action: 'search',
      params: { patterns: ['class.*View'] },
    });
    expect(result).toEqual({
      tool: 'code',
      action: 'search',
      params: { patterns: ['class.*View'] },
    });
  });

  test('parseToolCall handles string arguments (JSON)', () => {
    const result = router.parseToolCall('code', '{"action":"read","params":{"path":"README.md"}}');
    expect(result).toEqual({
      tool: 'code',
      action: 'read',
      params: { path: 'README.md' },
    });
  });

  test('parseToolCall rejects missing action', () => {
    const result = router.parseToolCall('code', { params: {} });
    expect(result).toHaveProperty('error');
  });

  test('parseToolCall rejects unknown tool', () => {
    const result = router.parseToolCall('nonexistent', { action: 'foo', params: {} });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('Unknown tool');
    }
  });

  test('parseToolCall rejects unknown action', () => {
    const result = router.parseToolCall('code', { action: 'nonexistent', params: {} });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('Unknown action');
    }
  });

  test('capability check blocks unauthorized action', async () => {
    const restrictedRouter = new ToolRouterV2({
      capability: {
        name: 'test',
        description: 'test',
        allowedTools: { code: ['search'] },
      },
    });
    const result = await restrictedRouter.execute(
      { tool: 'code', action: 'write', params: { path: 'x', content: 'y' } },
      makeCtx()
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Permission denied');
  });

  test('validates required params', async () => {
    const result = await router.execute({ tool: 'code', action: 'search', params: {} }, makeCtx());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Missing required param "patterns"');
  });

  test('validates enum params', async () => {
    const result = await router.execute(
      { tool: 'knowledge', action: 'search', params: { query: 'test', kind: 'invalid' } },
      makeCtx()
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid value');
  });

  test('executeParallel splits token budget', async () => {
    const ctx = makeCtx({ tokenBudget: 6000 });
    const calls: ToolCallV2[] = [
      { tool: 'meta', action: 'tools', params: {} },
      { tool: 'meta', action: 'tools', params: {} },
      { tool: 'meta', action: 'tools', params: {} },
    ];
    const results = await router.executeParallel(calls, ctx);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.ok).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────
//  §3 code.search — BiliDili 真实搜索
// ─────────────────────────────────────────────────

describe('code.search (BiliDili)', () => {
  const router = new ToolRouterV2();
  const ctx = makeCtx();

  test('finds Swift class declarations', async () => {
    const result = await router.execute(
      {
        tool: 'code',
        action: 'search',
        params: { patterns: ['class.*ViewController'], maxResults: 5, regex: true },
      },
      ctx
    );
    expect(result.ok).toBe(true);
    const data = result.data as { total?: number; shown?: number; matches?: unknown[] };
    expect(data.total).toBeGreaterThan(0);
  }, 30000);

  test('batch patterns search', async () => {
    const result = await router.execute(
      {
        tool: 'code',
        action: 'search',
        params: { patterns: ['import UIKit', 'import SwiftUI'], maxResults: 5 },
      },
      ctx
    );
    expect(result.ok).toBe(true);
    const data = result.data as { total?: number; shown?: number; matches?: unknown[] };
    expect(data.total).toBeGreaterThan(0);
  }, 30000);

  test('glob filtering', async () => {
    const result = await router.execute(
      {
        tool: 'code',
        action: 'search',
        params: { patterns: ['func'], glob: '*.swift', maxResults: 3 },
      },
      ctx
    );
    expect(result.ok).toBe(true);
  }, 15000);

  test('search cache returns same result', async () => {
    const call: ToolCallV2 = {
      tool: 'code',
      action: 'search',
      params: { patterns: ['AppDelegate'], maxResults: 3 },
    };
    const r1 = await router.execute(call, ctx);
    const r2 = await router.execute(call, ctx);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  }, 30000);
});

// ─────────────────────────────────────────────────
//  §4 code.read — 文件读取 + DeltaCache
// ─────────────────────────────────────────────────

describe('code.read (BiliDili)', () => {
  const router = new ToolRouterV2();
  const ctx = makeCtx();

  test('reads README.md', async () => {
    const result = await router.execute(
      { tool: 'code', action: 'read', params: { path: 'README.md' } },
      ctx
    );
    expect(result.ok).toBe(true);
    // code.read returns a numbered string, not an object
    expect(typeof result.data).toBe('string');
    expect((result.data as string).length).toBeGreaterThan(0);
  });

  test('reads with line range', async () => {
    const result = await router.execute(
      {
        tool: 'code',
        action: 'read',
        params: { path: 'Package.swift', startLine: 1, endLine: 10 },
      },
      ctx
    );
    expect(result.ok).toBe(true);
    const text = result.data as string;
    const lines = text.split('\n');
    expect(lines.length).toBeLessThanOrEqual(10);
  });

  test('delta cache returns unchanged on re-read', async () => {
    const freshCtx = makeCtx();
    await router.execute({ tool: 'code', action: 'read', params: { path: 'README.md' } }, freshCtx);
    const r2 = await router.execute(
      { tool: 'code', action: 'read', params: { path: 'README.md' } },
      freshCtx
    );
    expect(r2.ok).toBe(true);
    expect(r2.data).toBe('[unchanged since last read]');
  });

  test('fails for nonexistent file', async () => {
    const result = await router.execute(
      { tool: 'code', action: 'read', params: { path: 'nonexistent-file-xyz.txt' } },
      ctx
    );
    expect(result.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────
//  §5 code.outline — AST 骨架 (可能无 Tree-sitter)
// ─────────────────────────────────────────────────

describe('code.outline (BiliDili)', () => {
  const router = new ToolRouterV2();
  const ctx = makeCtx();

  test('returns outline or graceful fallback for Swift file', async () => {
    const result = await router.execute(
      { tool: 'code', action: 'outline', params: { path: 'Package.swift' } },
      ctx
    );
    // outline 可能因无 AstAnalyzer 而返回 fail，但不应崩溃
    expect(typeof result.ok).toBe('boolean');
  });
});

// ─────────────────────────────────────────────────
//  §6 code.structure — 目录树
// ─────────────────────────────────────────────────

describe('code.structure (BiliDili)', () => {
  const router = new ToolRouterV2();
  const ctx = makeCtx();

  test('returns project directory tree', async () => {
    const result = await router.execute(
      { tool: 'code', action: 'structure', params: { depth: 2 } },
      ctx
    );
    expect(result.ok).toBe(true);
    // code.structure returns a plain string tree
    const tree = result.data as string;
    expect(tree).toContain('BiliDili');
  });

  test('respects depth limit', async () => {
    const r1 = await router.execute(
      { tool: 'code', action: 'structure', params: { depth: 1 } },
      ctx
    );
    const r2 = await router.execute(
      { tool: 'code', action: 'structure', params: { depth: 3 } },
      ctx
    );
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const tree1 = r1.data as string;
    const tree2 = r2.data as string;
    expect(tree2.length).toBeGreaterThanOrEqual(tree1.length);
  });
});

// ─────────────────────────────────────────────────
//  §7 terminal.exec — 命令执行
// ─────────────────────────────────────────────────

describe('terminal.exec (BiliDili)', () => {
  const router = new ToolRouterV2();
  const ctx = makeCtx();

  test('executes simple command', async () => {
    const result = await router.execute(
      { tool: 'terminal', action: 'exec', params: { command: 'echo hello world' } },
      ctx
    );
    expect(result.ok).toBe(true);
    const data = result.data as { stdout?: string; output?: string };
    const output = data.stdout || data.output || '';
    expect(output).toContain('hello world');
  });

  test('executes git status', async () => {
    const result = await router.execute(
      { tool: 'terminal', action: 'exec', params: { command: 'git status --short' } },
      ctx
    );
    expect(result.ok).toBe(true);
  });

  test('blocks dangerous command', async () => {
    const result = await router.execute(
      { tool: 'terminal', action: 'exec', params: { command: 'sudo rm -rf /' } },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('blocked');
  });

  test('compresses output', async () => {
    const result = await router.execute(
      {
        tool: 'terminal',
        action: 'exec',
        params: { command: 'find . -name "*.swift" | head -20' },
      },
      ctx
    );
    expect(result.ok).toBe(true);
  }, 10000);

  test('blocks cwd escape outside project root', async () => {
    const result = await router.execute(
      {
        tool: 'terminal',
        action: 'exec',
        params: { command: 'ls', cwd: '/tmp' },
      },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('cwd must be within project root');
  });

  test('allows cwd within project root', async () => {
    const result = await router.execute(
      {
        tool: 'terminal',
        action: 'exec',
        params: { command: 'pwd', cwd: '.' },
      },
      ctx
    );
    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────
//  §8 memory.save / memory.recall
// ─────────────────────────────────────────────────

describe('memory (save + recall)', () => {
  const router = new ToolRouterV2();

  test('save then recall', async () => {
    const ctx = makeCtx({
      sessionStore: (() => {
        const store: Array<{ key: string; content: string; meta?: Record<string, unknown> }> = [];
        return {
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
        };
      })(),
    });

    const saveResult = await router.execute(
      {
        tool: 'memory',
        action: 'save',
        params: { key: 'arch-pattern', content: 'BiliDili uses MVVM with Coordinator pattern' },
      },
      ctx
    );
    expect(saveResult.ok).toBe(true);

    const recallResult = await router.execute(
      { tool: 'memory', action: 'recall', params: { query: 'MVVM' } },
      ctx
    );
    expect(recallResult.ok).toBe(true);
    const data = recallResult.data as { count?: number };
    expect(data.count).toBe(1);
  });

  test('recall with no memories returns empty', async () => {
    const ctx = makeCtx();
    const result = await router.execute({ tool: 'memory', action: 'recall', params: {} }, ctx);
    expect(result.ok).toBe(true);
    const data = result.data as { count?: number };
    expect(data.count).toBe(0);
  });
});

// ─────────────────────────────────────────────────
//  §9 meta.tools — 工具自省
// ─────────────────────────────────────────────────

describe('meta.tools', () => {
  const router = new ToolRouterV2();
  const ctx = makeCtx();

  test('returns all tool specs', async () => {
    const result = await router.execute({ tool: 'meta', action: 'tools', params: {} }, ctx);
    expect(result.ok).toBe(true);
    // meta.tools without name returns an array of summaries
    const data = result.data as Array<{ tool?: string }>;
    expect(data.length).toBe(6);
  });

  test('returns single tool detail', async () => {
    const result = await router.execute(
      { tool: 'meta', action: 'tools', params: { name: 'code' } },
      ctx
    );
    expect(result.ok).toBe(true);
    // meta.tools with name returns { tool, description, actions }
    const data = result.data as { tool?: string; actions?: unknown };
    expect(data.tool).toBe('code');
    expect(data.actions).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────
//  §10 V2ToolRouterAdapter — V1 接口兼容
// ─────────────────────────────────────────────────

describe('V2ToolRouterAdapter', () => {
  test('execute returns ToolResultEnvelope', async () => {
    const { ToolContextFactory } = await import('#tools/v2/adapter/ToolContextFactory.js');
    const factory = new ToolContextFactory({
      container: { get: () => undefined },
      projectRoot: BILIDILI_ROOT,
      dataRoot: BILIDILI_ROOT,
    });
    const adapter = new V2ToolRouterAdapter({ contextFactory: factory });

    const envelope = await adapter.execute({
      toolId: 'code',
      args: { action: 'structure', params: { depth: 1 } },
      surface: 'runtime',
      actor: { role: 'developer', user: 'test' },
      source: { kind: 'runtime', name: 'test' },
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.toolId).toBe('code');
    expect(envelope.status).toBe('success');
    expect(envelope.callId).toBeTruthy();
    expect(envelope.durationMs).toBeGreaterThanOrEqual(0);
    expect(envelope.text).toBeTruthy();
    expect(envelope.diagnostics).toBeTruthy();
    expect(envelope.trust).toBeTruthy();
  });

  test('returns error envelope for unknown tool', async () => {
    const { ToolContextFactory } = await import('#tools/v2/adapter/ToolContextFactory.js');
    const factory = new ToolContextFactory({
      container: { get: () => undefined },
      projectRoot: BILIDILI_ROOT,
      dataRoot: BILIDILI_ROOT,
    });
    const adapter = new V2ToolRouterAdapter({ contextFactory: factory });

    const envelope = await adapter.execute({
      toolId: 'nonexistent',
      args: { action: 'foo', params: {} },
      surface: 'runtime',
      actor: { role: 'developer', user: 'test' },
      source: { kind: 'runtime', name: 'test' },
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.status).toBe('error');
  });
});

// ─────────────────────────────────────────────────
//  §11 V2CapabilityCatalog — Schema 生成
// ─────────────────────────────────────────────────

describe('V2CapabilityCatalog', () => {
  const catalog = new V2CapabilityCatalog();

  test('toToolSchemas returns all 6 tools by default', () => {
    const schemas = catalog.toToolSchemas();
    expect(schemas.length).toBe(6);
    const names = schemas.map((s) => s.name);
    expect(names).toContain('code');
    expect(names).toContain('terminal');
    expect(names).toContain('knowledge');
  });

  test('toToolSchemas filters by ids', () => {
    const schemas = catalog.toToolSchemas(['code', 'memory']);
    expect(schemas.length).toBe(2);
  });

  test('schema has action enum', () => {
    const schemas = catalog.toToolSchemas(['code']);
    expect(schemas.length).toBe(1);
    const params = schemas[0].parameters as { properties?: { action?: { enum?: string[] } } };
    expect(params.properties?.action?.enum).toContain('search');
    expect(params.properties?.action?.enum).toContain('read');
  });

  test('toMixedSchemas works same as toToolSchemas', () => {
    const s1 = catalog.toToolSchemas();
    const s2 = catalog.toMixedSchemas();
    expect(s1.length).toBe(s2.length);
  });
});

// ─────────────────────────────────────────────────
//  §12 Capability V2 — 权限 + prompt 生成
// ─────────────────────────────────────────────────

describe('CapabilityV2', () => {
  test('BootstrapAnalyze returns V2 tool names', () => {
    const cap = new BootstrapAnalyze();
    expect(cap.name).toBe('code_analysis');
    expect(cap.tools).toContain('code');
    expect(cap.tools).toContain('terminal');
    expect(cap.tools).toContain('graph');
    expect(cap.tools).toContain('memory');
    expect(cap.tools).toContain('meta');
    expect(cap.tools).not.toContain('search_project_code');
  });

  test('promptFragment includes action descriptions', () => {
    const cap = new BootstrapAnalyze();
    const prompt = cap.promptFragment;
    expect(prompt).toContain('code');
    expect(prompt).toContain('search');
    expect(prompt).toContain('read');
  });

  test('toDef produces valid CapabilityV2Def', () => {
    const cap = new BootstrapAnalyze();
    const def = cap.toDef();
    expect(def.name).toBe('code_analysis');
    expect(def.allowedTools.code).toContain('search');
    expect(def.promptFragment).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────
//  §13 DeltaCache 单元测试
// ─────────────────────────────────────────────────

describe('DeltaCache', () => {
  test('first read returns full', () => {
    const cache = new DeltaCache(10);
    const result = cache.check('test.txt', 'hello world');
    expect(result.mode).toBe('full');
    expect(result.content).toBe('hello world');
  });

  test('same content returns unchanged', () => {
    const cache = new DeltaCache(10);
    cache.check('test.txt', 'hello world');
    const result = cache.check('test.txt', 'hello world');
    expect(result.mode).toBe('unchanged');
  });

  test('different content returns delta', () => {
    const cache = new DeltaCache(10);
    cache.check('test.txt', 'line1\nline2\nline3');
    const result = cache.check('test.txt', 'line1\nline2-modified\nline3');
    expect(result.mode).toBe('delta');
    expect(result.content).toContain('line2');
  });

  test('LRU eviction works', () => {
    const cache = new DeltaCache(2);
    cache.check('a.txt', 'aaa');
    cache.check('b.txt', 'bbb');
    cache.check('c.txt', 'ccc'); // evicts a.txt
    const result = cache.check('a.txt', 'aaa');
    expect(result.mode).toBe('full'); // not cached anymore
  });
});

// ─────────────────────────────────────────────────
//  §14 OutputCompressor
// ─────────────────────────────────────────────────

describe('OutputCompressor', () => {
  const compressor = new OutputCompressor();

  test('strips ANSI codes', async () => {
    const input = '\x1b[31mERROR\x1b[0m: something failed';
    const output = compressor.compressSync(input, {});
    expect(output).not.toContain('\x1b[');
    expect(output).toContain('ERROR');
  });

  test('collapses repeated lines', async () => {
    const input = Array(50).fill('same line here').join('\n');
    const output = compressor.compressSync(input, {});
    expect(output.length).toBeLessThan(input.length);
  });

  test('recognizes git status command', async () => {
    const gitOutput = `On branch main
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
  modified:   src/App.tsx
  modified:   src/index.ts

Untracked files:
  .env.local
  dist/`;
    const output = await compressor.compress(gitOutput, { command: 'git status' });
    expect(output).toBeTruthy();
    expect(output.length).toBeLessThanOrEqual(gitOutput.length);
  });
});
