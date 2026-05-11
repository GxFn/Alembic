import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { materializeScriptArtifact } from '../../lib/tools/adapters/terminal-adapter/TerminalArtifacts.js';
import type { ToolCapabilityManifest } from '../../lib/tools/catalog/CapabilityManifest.js';
import type { ToolExecutionRequest } from '../../lib/tools/core/ToolContracts.js';

function request(projectRoot: string, dataRoot: string): ToolExecutionRequest {
  return {
    manifest: {
      id: 'terminal_script',
      kind: 'terminal-profile',
      execution: { maxOutputBytes: 1024 },
    } as unknown as ToolCapabilityManifest,
    args: {},
    decision: { allowed: true, stage: 'execute' },
    context: {
      callId: 'terminal-call',
      toolId: 'terminal_script',
      surface: 'runtime',
      actor: { role: 'runtime' },
      source: { kind: 'runtime', name: 'terminal-test' },
      projectRoot,
      dataRoot,
      services: {
        get(name: string) {
          throw new Error(`Unexpected service lookup: ${name}`);
        },
      },
    },
  };
}

describe('TerminalArtifacts', () => {
  test('writes fallback artifacts under dataRoot in ghost mode', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-project-'));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-ghost-'));

    try {
      const artifact = materializeScriptArtifact(
        request(projectRoot, dataRoot),
        'echo ghost',
        'abcdef123456'
      );
      const artifactPath = artifact.uri.replace('file://', '');

      expect(artifactPath.startsWith(path.join(dataRoot, '.asd'))).toBe(true);
      expect(artifactPath.startsWith(path.join(projectRoot, '.asd'))).toBe(false);
      expect(fs.readFileSync(artifactPath, 'utf8')).toBe('echo ghost\n');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
