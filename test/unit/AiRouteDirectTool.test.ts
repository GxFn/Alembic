import type { Request, Response } from 'express';
import { describe, expect, test, vi } from 'vitest';
import { ensureAiConfigUpdateAllowed, ensureDirectToolAllowed } from '../../lib/http/routes/ai.js';

function mockResponse() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

function mockRequest(overrides: Partial<Request> = {}) {
  return {
    resolvedRole: 'developer',
    resolvedUser: 'local',
    headers: {},
    ip: '127.0.0.1',
    ...overrides,
  } as Request;
}

describe('AI route direct tool governance', () => {
  test('allows unregistered tools to fall through to existing not-found handling', async () => {
    const res = mockResponse();
    const allowed = await ensureDirectToolAllowed(
      { has: () => false, isDirectCallable: () => false, getToolMetadata: () => null },
      'missing_tool',
      mockRequest(),
      res
    );

    expect(allowed).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('rejects registered side-effect tools before execution', async () => {
    const res = mockResponse();
    const allowed = await ensureDirectToolAllowed(
      {
        has: () => true,
        isDirectCallable: () => false,
        getToolMetadata: () => ({ sideEffect: true }),
      },
      'submit_knowledge',
      mockRequest(),
      res
    );

    expect(allowed).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'TOOL_NOT_DIRECTLY_CALLABLE' }),
      })
    );
  });

  test('runs Gateway checkOnly for direct tools with gatewayAction metadata', async () => {
    const res = mockResponse();
    const checkOnly = vi.fn().mockResolvedValue({ success: true, requestId: 'gw-1' });
    const allowed = await ensureDirectToolAllowed(
      {
        has: () => true,
        isDirectCallable: () => true,
        getToolMetadata: () => ({
          directCallable: true,
          sideEffect: false,
          gatewayAction: 'read:recipes',
          gatewayResource: 'recipes',
        }),
      },
      'search_recipes',
      mockRequest({ resolvedRole: 'external_agent', headers: { 'x-session-id': 's1' } }),
      res,
      { checkOnly },
      { keyword: 'runtime' }
    );

    expect(allowed).toBe(true);
    expect(checkOnly).toHaveBeenCalledWith({
      actor: 'external_agent',
      action: 'read:recipes',
      resource: 'recipes',
      data: expect.objectContaining({
        tool: 'search_recipes',
        params: { keyword: 'runtime' },
        _resolvedUser: 'local',
      }),
      session: 's1',
    });
    expect(res.status).not.toHaveBeenCalled();
  });

  test('fails closed when a mapped direct tool has no Gateway available', async () => {
    const res = mockResponse();
    const allowed = await ensureDirectToolAllowed(
      {
        has: () => true,
        isDirectCallable: () => true,
        getToolMetadata: () => ({
          directCallable: true,
          sideEffect: false,
          gatewayAction: 'read:project',
          gatewayResource: 'project',
        }),
      },
      'read_project_file',
      mockRequest({ resolvedRole: 'external_agent' }),
      res,
      null,
      { filePath: 'README.md' }
    );

    expect(allowed).toBe(false);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'GATEWAY_UNAVAILABLE' }),
      })
    );
  });

  test('maps agent meta tools through Gateway checkOnly', async () => {
    const res = mockResponse();
    const checkOnly = vi.fn().mockResolvedValue({ success: true, requestId: 'gw-tools' });
    const allowed = await ensureDirectToolAllowed(
      {
        has: () => true,
        isDirectCallable: () => true,
        getToolMetadata: () => ({
          directCallable: true,
          sideEffect: false,
          gatewayAction: 'read:agent_tools',
          gatewayResource: 'agent_tools',
        }),
      },
      'get_tool_details',
      mockRequest({ resolvedRole: 'external_agent' }),
      res,
      { checkOnly },
      { toolName: 'search_recipes' }
    );

    expect(allowed).toBe(true);
    expect(checkOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'read:agent_tools',
        resource: 'agent_tools',
      })
    );
  });

  test('blocks direct tools when Gateway checkOnly denies access', async () => {
    const res = mockResponse();
    const allowed = await ensureDirectToolAllowed(
      {
        has: () => true,
        isDirectCallable: () => true,
        getToolMetadata: () => ({
          directCallable: true,
          sideEffect: false,
          gatewayAction: 'read:audit_logs',
          gatewayResource: '/audit_logs/self',
        }),
      },
      'query_audit_log',
      mockRequest({ resolvedRole: 'visitor' }),
      res,
      {
        checkOnly: vi.fn().mockResolvedValue({
          success: false,
          requestId: 'gw-denied',
          error: { code: 'PERMISSION_DENIED', statusCode: 403, message: 'Permission denied' },
        }),
      }
    );

    expect(allowed).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'PERMISSION_DENIED',
          requestId: 'gw-denied',
        }),
      })
    );
  });

  test('runs Gateway checkOnly before AI env config writes', async () => {
    const res = mockResponse();
    const checkOnly = vi.fn().mockResolvedValue({ success: true, requestId: 'gw-config' });
    const allowed = await ensureAiConfigUpdateAllowed(
      mockRequest({ resolvedRole: 'developer', headers: { 'x-session-id': 's-config' } }),
      res,
      { checkOnly },
      { ALEMBIC_AI_PROVIDER: 'openai', ALEMBIC_OPENAI_API_KEY: 'secret' }
    );

    expect(allowed).toBe(true);
    expect(checkOnly).toHaveBeenCalledWith({
      actor: 'developer',
      action: 'update:config',
      resource: 'ai_config',
      data: expect.objectContaining({
        keys: ['ALEMBIC_AI_PROVIDER', 'ALEMBIC_OPENAI_API_KEY'],
        _resolvedUser: 'local',
      }),
      session: 's-config',
    });
    expect(res.status).not.toHaveBeenCalled();
  });

  test('fails closed when AI env config Gateway check is unavailable', async () => {
    const res = mockResponse();
    const allowed = await ensureAiConfigUpdateAllowed(
      mockRequest({ resolvedRole: 'developer' }),
      res,
      null,
      { ALEMBIC_AI_PROVIDER: 'openai' }
    );

    expect(allowed).toBe(false);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'GATEWAY_UNAVAILABLE' }),
      })
    );
  });
});
