import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { MacSystemAdapter } from '../../lib/tools/adapters/MacSystemAdapter.js';
import {
  MAC_PERMISSION_STATUS_CAPABILITY,
  MAC_SCREENSHOT_CAPABILITY,
  MAC_SYSTEM_INFO_CAPABILITY,
  MAC_WINDOW_LIST_CAPABILITY,
} from '../../lib/tools/adapters/MacSystemCapabilities.js';
import type { ToolCapabilityManifest } from '../../lib/tools/catalog/CapabilityManifest.js';
import type { ToolExecutionRequest } from '../../lib/tools/core/ToolContracts.js';

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

function fakeHelperPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macos-helper-'));
  const helper = path.join(dir, 'screenshot');
  fs.writeFileSync(helper, '#!/bin/sh\n', 'utf8');
  return helper;
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
      screenshotBinaryPath: fakeHelperPath(),
    });

    const result = await adapter.execute(
      request(MAC_PERMISSION_STATUS_CAPABILITY, { permission: 'screen-recording' })
    );

    expect(result).toMatchObject({
      ok: true,
      structuredContent: {
        data: {
          permissions: [
            {
              permission: 'screen-recording',
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

  test('blocks ScreenCaptureKit capabilities when not running on macOS', async () => {
    const adapter = new MacSystemAdapter({
      platform: 'linux',
      screenshotBinaryPath: fakeHelperPath(),
    });

    const result = await adapter.execute(request(MAC_WINDOW_LIST_CAPABILITY));

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      structuredContent: {
        error: {
          code: 'MACOS_UNAVAILABLE',
        },
      },
      diagnostics: {
        blockedTools: [{ tool: 'mac_window_list', reason: expect.any(String) }],
      },
    });
  });

  test('materializes window titles as a JSON artifact reference', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'macos-window-list-'));
    const execFile = vi.fn(async () => ({
      stdout: JSON.stringify([
        {
          windowID: 42,
          title: 'Secret Project Notes',
          app: 'Code',
          bundleID: 'com.microsoft.VSCode',
          width: 1200,
          height: 800,
          onScreen: true,
        },
      ]),
      stderr: '',
    }));
    const adapter = new MacSystemAdapter({
      platform: 'darwin',
      screenshotBinaryPath: fakeHelperPath(),
      execFile,
    });

    const result = await adapter.execute(request(MAC_WINDOW_LIST_CAPABILITY, {}, projectRoot));
    const artifactPath = fileURLToPath(result.artifacts?.[0]?.uri || '');

    expect(execFile).toHaveBeenCalledWith(
      expect.any(String),
      ['--list-windows'],
      expect.any(Object)
    );
    expect(result).toMatchObject({
      ok: true,
      artifacts: [
        {
          kind: 'resource',
          mimeType: 'application/json',
        },
      ],
      trust: {
        source: 'macos',
        containsUntrustedText: true,
        containsSecrets: true,
      },
      structuredContent: {
        data: {
          total: 1,
          privacy: {
            titlesIncludedOnlyInArtifact: true,
            containsWindowTitles: true,
          },
        },
      },
    });
    expect(fs.readFileSync(artifactPath, 'utf8')).toContain('Secret Project Notes');
  });

  test('captures screenshots through the helper and returns only an image artifact ref', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'macos-screenshot-'));
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      const outputPath = args[args.indexOf('--output') + 1];
      fs.writeFileSync(outputPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      return {
        stdout: JSON.stringify({
          success: true,
          path: outputPath,
          width: 640,
          height: 480,
          format: 'jpeg',
          bytes: 4,
        }),
        stderr: '',
      };
    });
    const adapter = new MacSystemAdapter({
      platform: 'darwin',
      screenshotBinaryPath: fakeHelperPath(),
      execFile,
    });

    const result = await adapter.execute(
      request(MAC_SCREENSHOT_CAPABILITY, { windowTitle: 'Code', scale: 0.5 }, projectRoot)
    );
    const artifactPath = fileURLToPath(result.artifacts?.[0]?.uri || '');

    expect(result).toMatchObject({
      ok: true,
      artifacts: [
        {
          kind: 'image',
          mimeType: 'image/jpeg',
          sizeBytes: 4,
        },
      ],
      trust: {
        source: 'macos',
        containsUntrustedText: false,
        containsSecrets: true,
      },
      structuredContent: {
        data: {
          width: 640,
          height: 480,
          scale: 0.5,
          windowTitleMatched: true,
        },
      },
    });
    expect(fs.readFileSync(artifactPath)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });
});
