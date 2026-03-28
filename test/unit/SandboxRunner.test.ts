import { describe, expect, it } from 'vitest';

import { SandboxRunner } from '../../lib/agent/forge/SandboxRunner.js';

describe('SandboxRunner', () => {
  const sandbox = new SandboxRunner();

  describe('checkSafety', () => {
    it('should pass for safe code', () => {
      const code = `function toolHandler(params) { return { sum: params.a + params.b }; }`;
      const result = sandbox.checkSafety(code);
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should reject require()', () => {
      const code = `const fs = require('fs'); function toolHandler(p) { return fs.readFileSync(p.path); }`;
      const result = sandbox.checkSafety(code);
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes('require'))).toBe(true);
    });

    it('should reject dynamic import()', () => {
      const code = `async function toolHandler(p) { const m = await import('os'); return m; }`;
      const result = sandbox.checkSafety(code);
      expect(result.passed).toBe(false);
    });

    it('should reject process access', () => {
      const code = `function toolHandler(p) { return process.env; }`;
      const result = sandbox.checkSafety(code);
      expect(result.passed).toBe(false);
    });

    it('should reject eval', () => {
      const code = `function toolHandler(p) { return eval(p.code); }`;
      const result = sandbox.checkSafety(code);
      expect(result.passed).toBe(false);
    });

    it('should reject fetch', () => {
      const code = `async function toolHandler(p) { return await fetch(p.url); }`;
      const result = sandbox.checkSafety(code);
      expect(result.passed).toBe(false);
    });

    it('should report multiple violations', () => {
      const code = `function toolHandler(p) { const fs = require('fs'); return eval(p.code); }`;
      const result = sandbox.checkSafety(code);
      expect(result.passed).toBe(false);
      expect(result.violations.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('run', () => {
    it('should execute safe code and pass tests', () => {
      const code = `function toolHandler(params) { return { sum: params.a + params.b }; }`;
      const result = sandbox.run(code, [
        { description: 'add 1+2', input: { a: 1, b: 2 }, expectedOutput: { sum: 3 } },
        { description: 'add 0+0', input: { a: 0, b: 0 }, expectedOutput: { sum: 0 } },
      ]);
      expect(result.success).toBe(true);
      expect(result.testResults).toHaveLength(2);
      expect(result.testResults.every((t) => t.passed)).toBe(true);
      expect(result.safetyCheck.passed).toBe(true);
    });

    it('should report test failures', () => {
      const code = `function toolHandler(params) { return { sum: params.a - params.b }; }`;
      const result = sandbox.run(code, [
        { description: 'should fail', input: { a: 5, b: 3 }, expectedOutput: { sum: 8 } },
      ]);
      expect(result.success).toBe(false);
      expect(result.testResults[0].passed).toBe(false);
      expect(result.testResults[0].actualOutput).toEqual({ sum: 2 });
    });

    it('should reject unsafe code before running tests', () => {
      const code = `const os = require('os'); function toolHandler(p) { return {}; }`;
      const result = sandbox.run(code, [
        { description: 'any test', input: {}, expectedOutput: {} },
      ]);
      expect(result.success).toBe(false);
      expect(result.safetyCheck.passed).toBe(false);
      expect(result.testResults).toHaveLength(0);
    });

    it('should fail if toolHandler is not defined', () => {
      const code = `const x = 42;`;
      const result = sandbox.run(code, [{ description: 'check', input: {}, expectedOutput: 42 }]);
      expect(result.success).toBe(false);
      expect(result.testResults[0].error).toContain('toolHandler');
    });

    it('should handle runtime errors in tool code', () => {
      const code = `function toolHandler(params) { throw new Error('boom'); }`;
      const result = sandbox.run(code, [
        { description: 'boom test', input: {}, expectedOutput: null },
      ]);
      expect(result.success).toBe(false);
      expect(result.testResults[0].passed).toBe(false);
      expect(result.testResults[0].error).toContain('boom');
    });

    it('should handle empty test cases', () => {
      const code = `function toolHandler(params) { return params; }`;
      const result = sandbox.run(code, []);
      expect(result.success).toBe(true);
      expect(result.testResults).toHaveLength(0);
    });

    it('should record execution time', () => {
      const code = `function toolHandler(params) { return params; }`;
      const result = sandbox.run(code, [
        { description: 'pass', input: { x: 1 }, expectedOutput: { x: 1 } },
      ]);
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('createHandler', () => {
    it('should create a callable async handler', async () => {
      const code = `function toolHandler(params) { return { doubled: params.n * 2 }; }`;
      const handler = sandbox.createHandler(code);
      const result = await handler({ n: 5 }, {});
      expect(result).toEqual({ doubled: 10 });
    });

    it('should throw if toolHandler not defined', async () => {
      const code = `const y = 1;`;
      const handler = sandbox.createHandler(code);
      await expect(handler({}, {})).rejects.toThrow('toolHandler');
    });

    it('should isolate between calls', async () => {
      const code = `
        var counter = 0;
        function toolHandler(params) { counter++; return { count: counter }; }
      `;
      const handler = sandbox.createHandler(code);
      const r1 = await handler({}, {});
      const r2 = await handler({}, {});
      // 每次调用创建新沙箱，counter 重新初始化
      expect(r1).toEqual({ count: 1 });
      expect(r2).toEqual({ count: 1 });
    });
  });
});
