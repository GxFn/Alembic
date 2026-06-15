/**
 * alembic_panorama MCP Handler — retired route contract
 */
import { describe, expect, it, vi } from 'vitest';
import { panoramaHandler } from '../../lib/resident/tool-handlers/panorama.js';

function makeCtx() {
  return {
    container: {
      get: vi.fn(() => {
        throw new Error('legacy panorama service must not be reached');
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

describe('alembic_panorama', () => {
  it('keeps the MCP surface but retires panorama as a project-information provider', async () => {
    const ctx = makeCtx();
    const result = (await panoramaHandler(ctx as never, { operation: 'overview' })) as Record<
      string,
      unknown
    >;

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('RETIRED_PROJECT_INFO_ROUTE');
    expect(result.message).toContain('ProjectContext-backed');
    expect(result.data).toMatchObject({
      operation: 'overview',
      projectInformationSource: 'project-context',
      retired: true,
    });
    expect(result.meta).toMatchObject({ tool: 'alembic_panorama' });
    expect(ctx.container.get).not.toHaveBeenCalled();
  });

  it('routes non-project panorama operations away from the project-information surface', async () => {
    const result = (await panoramaHandler(makeCtx() as never, {
      operation: 'staging_check',
    })) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('RETIRED_PROJECT_INFO_ROUTE');
    expect((result.problem as Record<string, unknown>).nextAction).toContain(
      'governance, decay, staging, and enhancement'
    );
    expect(result.data).toMatchObject({
      operation: 'staging_check',
      retired: true,
    });
    expect(result.meta).toMatchObject({ tool: 'alembic_panorama' });
  });
});
