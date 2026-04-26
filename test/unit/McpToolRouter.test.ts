import { describe, expect, test, vi } from 'vitest';
import { envelope } from '../../lib/external/mcp/envelope.js';
import { buildMcpToolCapabilities } from '../../lib/external/mcp/McpCapabilityProjection.js';
import { McpServer } from '../../lib/external/mcp/McpServer.js';
import { McpToolAdapter } from '../../lib/external/mcp/McpToolAdapter.js';
import { TOOLS } from '../../lib/external/mcp/tools.js';
import { CapabilityCatalog } from '../../lib/tools/catalog/CapabilityCatalog.js';
import { ToolRouter } from '../../lib/tools/core/ToolRouter.js';

function createServer(gateway: unknown = null) {
  const server = new McpServer({
    container: {
      get: vi.fn((name: string) => {
        if (name === 'gateway') {
          return gateway;
        }
        return null;
      }),
    },
  });
  server.logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as typeof server.logger;
  return server;
}

function mockProbeRole(server: McpServer, role = 'developer') {
  vi.spyOn(server, '_getCapabilityProbe').mockReturnValue({
    probeRole: () => role,
  } as never);
}

describe('MCP ToolRouter integration', () => {
  test('projects MCP tool declarations into mcp capabilities', () => {
    const { manifests } = buildMcpToolCapabilities(TOOLS);

    expect(manifests.length).toBe(TOOLS.length);
    expect(manifests.find((manifest) => manifest.id === 'alembic_health')).toMatchObject({
      kind: 'mcp-tool',
      surfaces: ['mcp'],
      risk: { sideEffect: false },
      execution: { adapter: 'mcp' },
      externalTrust: {
        source: 'mcp-server',
        serverId: 'alembic-local',
        trusted: true,
        allowlisted: true,
        registration: {
          source: 'bundled',
        },
        outputContainsUntrustedText: true,
      },
    });
    expect(manifests.find((manifest) => manifest.id === 'alembic_submit_knowledge')).toMatchObject({
      governance: {
        gatewayAction: 'knowledge:create',
        gatewayResource: 'knowledge',
        policyProfile: 'write',
      },
      risk: { sideEffect: true },
    });
  });

  test('routes MCP tools/call through ToolRouter and returns ToolResultEnvelope', async () => {
    const server = createServer();
    const resolveHandler = vi.spyOn(server, '_resolveHandler').mockReturnValue(async () =>
      envelope({
        success: true,
        data: { total: 1 },
        message: 'healthy',
        meta: { tool: 'alembic_health' },
      })
    );

    const result = await server._handleToolCall('alembic_health', {});

    expect(resolveHandler).toHaveBeenCalledWith('alembic_health');
    expect(result).toMatchObject({
      ok: true,
      toolId: 'alembic_health',
      status: 'success',
      text: 'healthy',
      structuredContent: {
        success: true,
        data: { total: 1 },
      },
      trust: { source: 'mcp' },
    });
  });

  test('blocks untrusted MCP capabilities before handler execution', async () => {
    const { manifests } = buildMcpToolCapabilities([
      {
        name: 'third_party_tool',
        description: 'Untrusted third-party MCP tool',
        serverId: 'third-party',
        trust: { trusted: false, reason: 'server is not allowlisted' },
      },
    ]);
    const executeTool = vi.fn();
    const router = new ToolRouter({
      catalog: new CapabilityCatalog(manifests),
      adapters: [new McpToolAdapter(executeTool)],
      projectRoot: process.cwd(),
    });

    const result = await router.execute({
      toolId: 'third_party_tool',
      args: {},
      surface: 'mcp',
      actor: { role: 'developer' },
      source: { kind: 'mcp', name: 'tools/call' },
    });

    expect(executeTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      toolId: 'third_party_tool',
      structuredContent: {
        errorCode: 'MCP_UNTRUSTED_SERVER',
        trust: {
          source: 'mcp-server',
          serverId: 'third-party',
          trusted: false,
        },
      },
      diagnostics: {
        gateFailures: [{ stage: 'execute', action: 'mcp-trust' }],
      },
      trust: {
        source: 'mcp',
        containsUntrustedText: false,
      },
    });
    expect(result.text).toContain('not trusted');
  });

  test('marks external MCP tools as untrusted when server provenance is unknown', async () => {
    const { manifests } = buildMcpToolCapabilities([
      {
        name: 'external_lookup',
        description: 'External lookup tool',
        serverId: 'external-search',
      },
    ]);
    const executeTool = vi.fn();
    const router = new ToolRouter({
      catalog: new CapabilityCatalog(manifests),
      adapters: [new McpToolAdapter(executeTool)],
      projectRoot: process.cwd(),
    });

    expect(manifests[0].externalTrust).toMatchObject({
      source: 'mcp-server',
      serverId: 'external-search',
      trusted: false,
      allowlisted: false,
      registration: {
        source: 'unknown',
      },
      reason: 'MCP server "external-search" is not allowlisted',
    });

    const result = await router.execute({
      toolId: 'external_lookup',
      args: {},
      surface: 'mcp',
      actor: { role: 'developer' },
      source: { kind: 'mcp', name: 'tools/call' },
    });

    expect(executeTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      structuredContent: {
        errorCode: 'MCP_UNTRUSTED_SERVER',
        trust: {
          serverId: 'external-search',
          allowlisted: false,
          registration: { source: 'unknown' },
        },
      },
    });
  });

  test('trusts external MCP tools only when registration is allowlisted', async () => {
    const { manifests } = buildMcpToolCapabilities(
      [
        {
          name: 'external_lookup',
          description: 'External lookup tool',
          serverId: 'external-search',
        },
      ],
      {
        servers: [
          {
            serverId: 'external-search',
            source: 'workspace-config',
            configPath: '.cursor/mcp.json',
            declaredBy: 'project',
          },
        ],
        trustedServerIds: ['external-search'],
      }
    );
    const executeTool = vi.fn().mockResolvedValue(
      envelope({
        success: true,
        data: { answer: 'ok' },
        message: 'external lookup completed',
      })
    );
    const router = new ToolRouter({
      catalog: new CapabilityCatalog(manifests),
      adapters: [new McpToolAdapter(executeTool)],
      projectRoot: process.cwd(),
    });

    expect(manifests[0].externalTrust).toMatchObject({
      serverId: 'external-search',
      trusted: true,
      allowlisted: true,
      registration: {
        source: 'workspace-config',
        configPath: '.cursor/mcp.json',
        declaredBy: 'project',
      },
    });

    const result = await router.execute({
      toolId: 'external_lookup',
      args: { q: 'test' },
      surface: 'mcp',
      actor: { role: 'developer' },
      source: { kind: 'mcp', name: 'tools/call' },
    });

    expect(executeTool).toHaveBeenCalledWith(
      'external_lookup',
      { q: 'test' },
      expect.objectContaining({
        manifest: expect.objectContaining({
          externalTrust: expect.objectContaining({ allowlisted: true }),
        }),
      })
    );
    expect(result).toMatchObject({
      ok: true,
      status: 'success',
      text: 'external lookup completed',
      trust: { source: 'mcp', containsUntrustedText: true },
    });
  });

  test('blocks unknown MCP tools before handler execution', async () => {
    const server = createServer();
    const resolveHandler = vi.spyOn(server, '_resolveHandler');

    const result = await server._handleToolCall('missing_tool', {});

    expect(resolveHandler).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      toolId: 'missing_tool',
      status: 'blocked',
    });
    expect(result.text).toContain("Capability 'missing_tool' not found");
  });

  test('resolves dynamic MCP Gateway mapping through Governance approve', async () => {
    const checkOnly = vi.fn().mockResolvedValue({ success: true, requestId: 'gw-wiki' });
    const server = createServer({ checkOnly });
    mockProbeRole(server, 'developer');
    const resolveHandler = vi.spyOn(server, '_resolveHandler').mockReturnValue(async () =>
      envelope({
        success: true,
        data: { finalized: true },
        message: 'wiki finalized',
        meta: { tool: 'alembic_wiki' },
      })
    );

    const result = await server._handleToolCall('alembic_wiki', { operation: 'finalize' });

    expect(result).toMatchObject({ ok: true, status: 'success', text: 'wiki finalized' });
    expect(resolveHandler).toHaveBeenCalledWith('alembic_wiki');
    expect(checkOnly).toHaveBeenCalledWith({
      actor: 'developer',
      action: 'knowledge:create',
      resource: 'knowledge',
      data: { operation: 'finalize' },
      session: expect.any(String),
    });
  });

  test('skips Gateway when dynamic MCP resolver returns read-only operation', async () => {
    const checkOnly = vi.fn();
    const server = createServer({ checkOnly });
    mockProbeRole(server, 'developer');
    const resolveHandler = vi.spyOn(server, '_resolveHandler').mockReturnValue(async () =>
      envelope({
        success: true,
        data: { planned: true },
        message: 'wiki plan',
        meta: { tool: 'alembic_wiki' },
      })
    );

    const result = await server._handleToolCall('alembic_wiki', { operation: 'plan' });

    expect(result).toMatchObject({ ok: true, status: 'success', text: 'wiki plan' });
    expect(resolveHandler).toHaveBeenCalledWith('alembic_wiki');
    expect(checkOnly).not.toHaveBeenCalled();
  });

  test('blocks MCP handler execution when Gateway denies dynamic mapping', async () => {
    const checkOnly = vi.fn().mockResolvedValue({
      success: false,
      requestId: 'gw-denied',
      error: { message: 'Permission denied', code: 'PERMISSION_DENIED', statusCode: 403 },
    });
    const server = createServer({ checkOnly });
    mockProbeRole(server, 'contributor');
    const resolveHandler = vi.spyOn(server, '_resolveHandler');

    const result = await server._handleToolCall('alembic_wiki', { operation: 'finalize' });

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      text: 'Permission denied',
    });
    expect(resolveHandler).not.toHaveBeenCalled();
    expect(result.diagnostics.gateFailures[0]).toMatchObject({ stage: 'approve' });
  });
});
