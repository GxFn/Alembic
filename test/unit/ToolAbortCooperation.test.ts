import { describe, expect, test, vi } from 'vitest';
import { guardCheckCode } from '../../lib/agent/tools/guard.js';
import { searchProjectCode } from '../../lib/agent/tools/project-access.js';

describe('tool abort cooperation', () => {
  test('search_project_code returns early when handler sees an aborted signal', async () => {
    const abortController = new AbortController();
    abortController.abort();

    const result = await searchProjectCode.handler(
      { pattern: 'needle' },
      {
        abortSignal: abortController.signal,
        fileCache: [{ relativePath: 'src/example.ts', content: 'needle' }],
      }
    );

    expect(result).toMatchObject({ aborted: true, error: expect.stringContaining('aborted') });
  });

  test('guard_check_code returns early without invoking engines when aborted', async () => {
    const abortController = new AbortController();
    abortController.abort();
    const get = vi.fn();

    const result = await guardCheckCode.handler({ code: 'let value = 1', language: 'typescript' }, {
      abortSignal: abortController.signal,
      container: { get },
    } as never);

    expect(result).toMatchObject({ aborted: true, error: expect.stringContaining('aborted') });
    expect(get).not.toHaveBeenCalled();
  });
});
