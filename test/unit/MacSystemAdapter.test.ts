import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolCapabilityManifest, ToolExecutionRequest } from '@alembic/agent';
import { describe, expect, test } from 'vitest';
import { MacSystemAdapter } from '../../lib/tools/adapters/MacSystemAdapter.js';
import {
  MAC_PERMISSION_STATUS_CAPABILITY,
  MAC_SYSTEM_INFO_CAPABILITY,
} from '../../lib/tools/adapters/MacSystemCapabilities.js';

function request(
  manifest: ToolCapabilityManifest,
  args: Record<string, unknown> = {},
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'macos-adapter-project-'))
): ToolExecutionRequest {
  return {
    manifest,
    args,
    decision: { allowed: true, stage: 'execute' },
    context: {
      callId: `call-${manifest.id}`,
      toolId: manifest.id,
      surface: 'runtime',
      actor: { role: 'developer' },
      source: { kind: 'runtime', name: 'macos-adapter-test' },
      projectRoot,
      services: {
        get(name: string) {
          throw new Error(`Unexpected service lookup: ${name}`);
        },
      },
    },
  };
}

describe('MacSystemAdapter', () => {
  test('reports system info without requiring macOS permissions', async () => {
    const adapter = new MacSystemAdapter({ platform: 'linux' });

    const result = await adapter.execute(request(MAC_SYSTEM_INFO_CAPABILITY));

    expect(result).toMatchObject({
      ok: true,
      status: 'success',
      trust: { source: 'macos', containsUntrustedText: false },
      structuredContent: {
        success: true,
        data: {
          platform: 'linux',
          isMacOS: false,
          arch: expect.any(String),
        },
      },
    });
  });

  test('reports permission status without prompting or bypassing TCC', async () => {
    const adapter = new MacSystemAdapter({
      platform: 'darwin',
    });

    const result = await adapter.execute(
      request(MAC_PERMISSION_STATUS_CAPABILITY, { permission: 'accessibility' })
    );

    expect(result).toMatchObject({
      ok: true,
      structuredContent: {
        data: {
          permissions: [
            {
              permission: 'accessibility',
              status: 'unknown',
            },
          ],
          policy: {
            checkedWithoutPrompt: true,
            promptsUser: false,
            bypassesTcc: false,
          },
        },
      },
    });
  });

  test('blocks unknown macOS capabilities without artifacts', async () => {
    const adapter = new MacSystemAdapter({ platform: 'linux' });
    const result = await adapter.execute(
      request({
        ...MAC_SYSTEM_INFO_CAPABILITY,
        id: 'mac_unknown',
      })
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      structuredContent: {
        error: {
          code: 'UNKNOWN_MACOS_CAPABILITY',
        },
      },
      diagnostics: {
        blockedTools: [{ tool: 'mac_unknown', reason: expect.any(String) }],
      },
    });
    expect(result.artifacts).toBeUndefined();
  });
});
