import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SystemInteraction } from '../../lib/agent/capabilities/index.js';
import { MAC_SYSTEM_CAPABILITY_MANIFESTS } from '../../lib/tools/adapters/MacSystemCapabilities.js';
import { SKILL_CAPABILITY_MANIFESTS } from '../../lib/tools/adapters/SkillCapabilities.js';
import { TERMINAL_CAPABILITY_MANIFESTS } from '../../lib/tools/adapters/TerminalCapabilities.js';
import { CapabilityCatalog } from '../../lib/tools/catalog/CapabilityCatalog.js';
import { createInternalToolManifest } from '../../lib/tools/catalog/CapabilityProjection.js';
import type { ToolDefinition } from '../../lib/tools/catalog/ToolDefinition.js';
import {
  ALL_TOOLS,
  TOOL_CAPABILITY_CATALOG,
  TOOL_CAPABILITY_MANIFESTS,
} from '../../lib/tools/handlers/index.js';

describe('CapabilityCatalog', () => {
  test('registers one manifest per internal tool', () => {
    expect(TOOL_CAPABILITY_CATALOG.size).toBe(ALL_TOOLS.length);
    expect(TOOL_CAPABILITY_MANIFESTS).toHaveLength(ALL_TOOLS.length);
  });

  test('projects HTTP-visible schemas from the manifest source', () => {
    const httpTools = TOOL_CAPABILITY_CATALOG.list({ surface: 'http' }).map((tool) => tool.id);

    expect(httpTools).toContain('search_project_code');
    expect(httpTools).toContain('read_project_file');
    expect(httpTools).toContain('get_environment_info');
    expect(httpTools).not.toContain('run_safe_command');

    const schemas = TOOL_CAPABILITY_CATALOG.toToolSchemas(['read_project_file']);
    expect(schemas).toEqual([
      expect.objectContaining({
        name: 'read_project_file',
        description: expect.any(String),
        parameters: expect.objectContaining({ type: 'object' }),
      }),
    ]);
  });

  test('preserves governance metadata in manifests without relying on ToolRegistry metadata APIs', () => {
    const readFileManifest = TOOL_CAPABILITY_CATALOG.getManifest('read_project_file');

    expect(readFileManifest).toMatchObject({
      id: 'read_project_file',
      kind: 'internal-tool',
      lifecycle: 'active',
      owner: 'core',
      surfaces: ['runtime', 'http'],
      risk: { sideEffect: false, dataAccess: 'project', writeScope: 'none' },
      governance: {
        gatewayAction: 'read:project',
        gatewayResource: 'project',
        auditLevel: 'checkOnly',
        policyProfile: 'read',
        allowInComposer: true,
      },
    });
  });

  test('describes side-effect tools with stronger risk and governance profiles', () => {
    const terminalManifest = TERMINAL_CAPABILITY_MANIFESTS[0];

    expect(terminalManifest).toMatchObject({
      id: 'terminal_run',
      kind: 'terminal-profile',
      inputSchema: {
        properties: {
          env: {
            additionalProperties: { type: 'string' },
          },
          interactive: {
            enum: ['never', 'allowed'],
          },
          session: {
            properties: {
              envPersistence: {
                enum: ['none', 'explicit'],
              },
            },
          },
        },
      },
      execution: {
        abortMode: 'hardTimeout',
        artifactMode: 'file-ref',
        adapter: 'terminal',
      },
      governance: {
        auditLevel: 'full',
        policyProfile: 'system',
        approvalPolicy: 'explain-then-run',
        allowInComposer: false,
      },
      risk: {
        sideEffect: true,
        writeScope: 'system',
        requiresHumanConfirmation: 'on-risk',
      },
    });
    expect(TOOL_CAPABILITY_CATALOG.getManifest('run_safe_command')).toBeNull();
  });

  test('exposes terminal_run as the SystemInteraction terminal entrypoint', () => {
    const capability = new SystemInteraction({ projectRoot: '/repo' });
    const catalog = new CapabilityCatalog([
      ...TOOL_CAPABILITY_MANIFESTS,
      ...TERMINAL_CAPABILITY_MANIFESTS,
      ...MAC_SYSTEM_CAPABILITY_MANIFESTS,
    ]);
    const schemas = catalog.toToolSchemas(capability.tools);

    expect(capability.tools).toContain('terminal_run');
    expect(capability.tools).toContain('terminal_session_close');
    expect(capability.tools).toContain('terminal_session_cleanup');
    expect(capability.tools).toContain('mac_system_info');
    expect(capability.tools).toContain('mac_permission_status');
    expect(capability.tools).toContain('mac_window_list');
    expect(capability.tools).toContain('mac_screenshot');
    expect(capability.tools).not.toContain('run_safe_command');
    expect(schemas.map((schema) => schema.name)).toContain('terminal_run');
    expect(schemas.map((schema) => schema.name)).toContain('terminal_session_close');
    expect(schemas.map((schema) => schema.name)).toContain('terminal_session_cleanup');
    expect(schemas.map((schema) => schema.name)).toContain('mac_screenshot');
    expect(catalog.getManifest('terminal_run')).toMatchObject({
      kind: 'terminal-profile',
      execution: { adapter: 'terminal', artifactMode: 'file-ref' },
      governance: { policyProfile: 'system', approvalPolicy: 'explain-then-run' },
    });
    expect(catalog.getManifest('terminal_session_close')).toMatchObject({
      kind: 'terminal-profile',
      execution: { adapter: 'terminal', artifactMode: 'inline' },
      governance: { policyProfile: 'system', approvalPolicy: 'auto' },
    });
  });

  test('describes P8 skill capabilities with skill adapter and external trust metadata', () => {
    const catalog = new CapabilityCatalog(SKILL_CAPABILITY_MANIFESTS);

    expect(catalog.getManifest('skill_search')).toMatchObject({
      kind: 'skill',
      surfaces: ['runtime', 'mcp'],
      execution: { adapter: 'skill', artifactMode: 'inline' },
      governance: { policyProfile: 'read', approvalPolicy: 'auto' },
      externalTrust: {
        source: 'skill',
        trusted: true,
        outputContainsUntrustedText: true,
      },
    });
    expect(catalog.getManifest('skill_validate')).toMatchObject({
      kind: 'skill',
      inputSchema: {
        properties: {
          name: { type: 'string' },
          source: { enum: ['all', 'builtin', 'project'] },
        },
      },
    });
  });

  test('describes P8 macOS capabilities with sensitive artifact boundaries', () => {
    const catalog = new CapabilityCatalog(MAC_SYSTEM_CAPABILITY_MANIFESTS);

    expect(catalog.getManifest('mac_system_info')).toMatchObject({
      kind: 'macos-adapter',
      surfaces: ['runtime'],
      execution: { adapter: 'macos', artifactMode: 'inline' },
      governance: { policyProfile: 'system', approvalPolicy: 'auto' },
      externalTrust: {
        source: 'macos',
        trusted: true,
        outputContainsUntrustedText: false,
      },
    });
    expect(catalog.getManifest('mac_window_list')).toMatchObject({
      kind: 'macos-adapter',
      execution: { adapter: 'macos', artifactMode: 'file-ref' },
      governance: { approvalPolicy: 'explain-then-run', allowInRemoteMcp: false },
      externalTrust: {
        source: 'macos',
        outputContainsUntrustedText: true,
      },
    });
    expect(catalog.getManifest('mac_screenshot')).toMatchObject({
      inputSchema: {
        properties: {
          windowTitle: { type: 'string' },
          format: { enum: ['png', 'jpeg'] },
        },
      },
      risk: {
        owaspTags: ['sensitive-info'],
        requiresHumanConfirmation: 'on-risk',
      },
    });
  });

  test('projects manifest owner and lifecycle from explicit tool metadata', () => {
    const manifest = createInternalToolManifest(
      testTool({
        name: 'experimental_lookup',
        metadata: {
          owner: 'agent-platform',
          lifecycle: 'experimental',
          surface: ['runtime'],
          policyProfile: 'analysis',
          auditLevel: 'none',
          abortMode: 'cooperative',
        },
      })
    );

    expect(manifest).toMatchObject({
      id: 'experimental_lookup',
      owner: 'agent-platform',
      lifecycle: 'experimental',
      risk: {
        sideEffect: false,
        writeScope: 'none',
        requiresHumanConfirmation: 'never',
      },
      governance: {
        policyProfile: 'analysis',
        auditLevel: 'none',
      },
      execution: {
        abortMode: 'cooperative',
      },
    });
  });

  test('keeps side-effect authority while allowing risk detail overrides', () => {
    const manifest = createInternalToolManifest(
      testTool({
        name: 'custom_secret_writer',
        metadata: {
          sideEffect: true,
          policyProfile: 'write',
          risk: {
            dataAccess: 'secrets',
            writeScope: 'data-root',
            network: 'open',
            credentialAccess: 'scoped-token',
            requiresHumanConfirmation: 'always',
            owaspTags: ['sensitive-info'],
          },
        },
      })
    );

    expect(manifest).toMatchObject({
      risk: {
        sideEffect: true,
        dataAccess: 'secrets',
        writeScope: 'data-root',
        network: 'open',
        credentialAccess: 'scoped-token',
        requiresHumanConfirmation: 'always',
        owaspTags: ['sensitive-info'],
      },
      governance: {
        approvalPolicy: 'explain-then-run',
        allowInComposer: false,
        allowInNonInteractive: false,
      },
      execution: {
        cachePolicy: 'none',
        concurrency: 'single',
      },
    });
  });

  test('does not let explicit metadata downgrade side-effect governance', () => {
    const manifest = createInternalToolManifest(
      testTool({
        name: 'unsafe_declared_tool',
        metadata: {
          sideEffect: true,
          policyProfile: 'read',
          auditLevel: 'none',
          abortMode: 'none',
          risk: {
            writeScope: 'none',
            requiresHumanConfirmation: 'never',
          },
        },
      })
    );

    expect(manifest).toMatchObject({
      risk: {
        sideEffect: true,
        writeScope: 'project',
        requiresHumanConfirmation: 'on-risk',
      },
      governance: {
        policyProfile: 'write',
        auditLevel: 'full',
        approvalPolicy: 'explain-then-run',
        allowInNonInteractive: false,
      },
      execution: {
        abortMode: 'preStart',
        cachePolicy: 'none',
        concurrency: 'single',
      },
    });
  });

  test('preserves stronger side-effect policy declarations', () => {
    const manifest = createInternalToolManifest(
      testTool({
        name: 'admin_side_effect_tool',
        metadata: {
          sideEffect: true,
          policyProfile: 'admin',
          abortMode: 'cooperative',
        },
      })
    );

    expect(manifest).toMatchObject({
      governance: {
        policyProfile: 'admin',
        auditLevel: 'full',
      },
      execution: {
        abortMode: 'cooperative',
      },
      risk: {
        sideEffect: true,
        writeScope: 'project',
      },
    });
  });

  test('filters disabled capabilities out of list projections', () => {
    const catalog = new CapabilityCatalog([
      {
        ...TOOL_CAPABILITY_MANIFESTS[0],
        id: 'disabled_tool',
        lifecycle: 'disabled',
      },
    ]);

    expect(catalog.getManifest('disabled_tool')).not.toBeNull();
    expect(catalog.list()).toEqual([]);
  });

  test('keeps governance tables out of tools/index.ts', () => {
    const indexSource = readFileSync(join(process.cwd(), 'lib/tools/handlers/index.ts'), 'utf-8');

    expect(indexSource).not.toContain('HTTP_DIRECT_TOOL_NAMES');
    expect(indexSource).not.toContain('SIDE_EFFECT_TOOL_NAMES');
    expect(indexSource).not.toContain('TOOL_GATEWAY_METADATA');
  });

  test('keeps ToolRegistry out of tool definition and manifest projection type boundaries', () => {
    const indexSource = readFileSync(join(process.cwd(), 'lib/tools/handlers/index.ts'), 'utf-8');
    const projectionSource = readFileSync(
      join(process.cwd(), 'lib/tools/catalog/CapabilityProjection.ts'),
      'utf-8'
    );

    expect(indexSource).not.toContain('./ToolRegistry.js');
    expect(projectionSource).not.toContain('./ToolRegistry.js');
  });
});

function testTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'test_tool',
    description: 'Test tool',
    parameters: { type: 'object', properties: {} },
    handler: () => ({}),
    ...overrides,
  };
}
