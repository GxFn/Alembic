import type { Request, Response } from 'express';
import { describe, expect, test, vi } from 'vitest';
import {
  createHttpChatAgentRunInput,
  ensureAiConfigUpdateAllowed,
  ensureDirectToolAllowed,
  sendToolEnvelopeResponse,
} from '../../lib/http/routes/ai.js';
import type { ToolCapabilityManifest } from '../../lib/tools/catalog/CapabilityManifest.js';
import type { ToolResultEnvelope } from '../../lib/tools/core/ToolResultEnvelope.js';

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

function toolEnvelope(overrides: Partial<ToolResultEnvelope> = {}): ToolResultEnvelope {
  return {
    ok: true,
    toolId: 'search_knowledge',
    callId: 'call-1',
    startedAt: new Date().toISOString(),
    durationMs: 2,
    status: 'success',
    text: 'ok',
    structuredContent: { result: 'ok' },
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [],
      timedOutStages: [],
      blockedTools: [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [],
    },
    trust: {
      source: 'internal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
    ...overrides,
  };
}

function manifest(overrides: Partial<ToolCapabilityManifest> = {}): ToolCapabilityManifest {
  return {
    id: 'search_recipes',
    title: 'Search Recipes',
    kind: 'internal-tool',
    description: 'Search recipes',
    owner: 'test',
    lifecycle: 'active',
    surfaces: ['runtime', 'http'],
    inputSchema: {},
    risk: {
      sideEffect: false,
      dataAccess: 'workspace',
      writeScope: 'none',
      network: 'none',
      credentialAccess: 'none',
      requiresHumanConfirmation: 'never',
      owaspTags: [],
    },
    execution: {
      adapter: 'internal',
      timeoutMs: 0,
      maxOutputBytes: 10_000,
      abortMode: 'none',
      cachePolicy: 'none',
      concurrency: 'parallel-safe',
      artifactMode: 'inline',
    },
    governance: {
      auditLevel: 'none',
      policyProfile: 'read',
      approvalPolicy: 'auto',
      allowedRoles: ['developer'],
      allowInComposer: true,
      allowInRemoteMcp: false,
      allowInNonInteractive: true,
    },
    evals: { required: false, cases: [] },
    ...overrides,
  };
}

function catalog(entry: ToolCapabilityManifest | null) {
  return {
    getManifest: vi.fn(() => entry),
  };
}

describe('AI route direct tool governance', () => {
  test('builds chat AgentRunInput without route-level runtime construction fields', () => {
    const input = createHttpChatAgentRunInput(
      mockRequest({
        body: { mode: 'remote-exec' },
        resolvedRole: 'developer',
        resolvedUser: 'local-user',
      }),
      {
        prompt: 'hello',
        history: [{ role: 'user', content: 'previous' }],
        lang: 'zh-CN',
        conversationId: 'conv-1',
      }
    );

    expect(input.profile).toEqual({ preset: 'chat' });
    expect(input.message).toMatchObject({
      content: 'hello',
      sessionId: 'conv-1',
      history: [{ role: 'user', content: 'previous' }],
    });
    expect(input.context).toMatchObject({
      source: 'http-chat',
      actor: { role: 'developer', user: 'local-user', sessionId: 'conv-1' },
    });
    expect(input.message.metadata).not.toHaveProperty('mode');
  });

  test('allows unregistered tools to fall through to existing not-found handling', async () => {
    const res = mockResponse();
    const allowed = await ensureDirectToolAllowed(
      catalog(null),
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
      catalog(
        manifest({
          id: 'submit_knowledge',
          surfaces: ['runtime'],
          risk: {
            ...manifest().risk,
            sideEffect: true,
            writeScope: 'workspace',
            requiresHumanConfirmation: 'on-risk',
          },
        })
      ),
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

  test('leaves Gateway checks to ToolRouter governance for direct tools', async () => {
    const res = mockResponse();
    const checkOnly = vi.fn().mockResolvedValue({ success: true, requestId: 'gw-1' });
    const allowed = await ensureDirectToolAllowed(
      catalog(manifest({ id: 'search_recipes' })),
      'search_recipes',
      mockRequest({ resolvedRole: 'external_agent', headers: { 'x-session-id': 's1' } }),
      res,
      { checkOnly }
    );

    expect(allowed).toBe(true);
    expect(checkOnly).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('allows direct tools when Gateway is unavailable because Governance owns the check', async () => {
    const res = mockResponse();
    const allowed = await ensureDirectToolAllowed(
      catalog(manifest({ id: 'read_project_file' })),
      'read_project_file',
      mockRequest({ resolvedRole: 'external_agent' }),
      res,
      null
    );

    expect(allowed).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('allows agent meta direct tools without route-level Gateway checks', async () => {
    const res = mockResponse();
    const checkOnly = vi.fn().mockResolvedValue({ success: true, requestId: 'gw-tools' });
    const allowed = await ensureDirectToolAllowed(
      catalog(manifest({ id: 'get_tool_details' })),
      'get_tool_details',
      mockRequest({ resolvedRole: 'external_agent' }),
      res,
      { checkOnly }
    );

    expect(allowed).toBe(true);
    expect(checkOnly).not.toHaveBeenCalled();
  });

  test('does not block direct tools at route layer when Gateway would deny later', async () => {
    const res = mockResponse();
    const checkOnly = vi.fn().mockResolvedValue({
      success: false,
      requestId: 'gw-denied',
      error: { code: 'PERMISSION_DENIED', statusCode: 403, message: 'Permission denied' },
    });
    const allowed = await ensureDirectToolAllowed(
      catalog(manifest({ id: 'query_audit_log' })),
      'query_audit_log',
      mockRequest({ resolvedRole: 'visitor' }),
      res,
      { checkOnly }
    );

    expect(allowed).toBe(true);
    expect(checkOnly).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('returns successful direct tool envelopes as data', () => {
    const res = mockResponse();
    const envelope = toolEnvelope({ text: 'project summary' });

    sendToolEnvelopeResponse(res, envelope);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, data: envelope });
  });

  test('maps blocked direct tool envelopes to HTTP errors', () => {
    const res = mockResponse();
    const envelope = toolEnvelope({
      ok: false,
      status: 'blocked',
      text: 'Tool not exposed on http surface',
      structuredContent: undefined,
    });

    sendToolEnvelopeResponse(res, envelope);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: expect.objectContaining({
        code: 'TOOL_BLOCKED',
        message: 'Tool not exposed on http surface',
        status: 'blocked',
        toolId: 'search_knowledge',
      }),
      data: envelope,
    });
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
