import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const thisFile = fileURLToPath(import.meta.url);

describe('agent module boundaries', () => {
  test('does not restore retired compatibility entry files', () => {
    const retiredFiles = [
      'lib/agent/AgentRuntime.ts',
      'lib/agent/AgentRuntimeTypes.ts',
      'lib/agent/AgentMessage.ts',
      'lib/agent/AgentState.ts',
      'lib/agent/AgentEventBus.ts',
      'lib/agent/AgentRouter.ts',
      'lib/agent/ConversationStore.ts',
      'lib/agent/IntentClassifier.ts',
      'lib/agent/PipelineStrategy.ts',
      'lib/agent/forced-summary.ts',
      'lib/agent/presets.ts',
      'lib/agent/policies.ts',
      'lib/agent/strategies.ts',
      'lib/agent/capabilities.ts',
      'lib/agent/domain/ChatAgentTasks.ts',
      'lib/agent/runs/chat/ChatAgentTasks.ts',
      'lib/agent/prompts/ChatAgentPrompts.ts',
      'lib/external/mcp/handlers/bootstrap/MissionBriefingBuilder.ts',
      'lib/external/mcp/handlers/bootstrap/BootstrapSession.ts',
      'lib/external/mcp/handlers/bootstrap/ExternalSubmissionTracker.ts',
      'lib/external/mcp/handlers/bootstrap/base-dimensions.ts',
      'lib/external/mcp/handlers/bootstrap/shared/bootstrap-phases.ts',
      'lib/external/mcp/handlers/bootstrap/shared/dimension-text.ts',
      'lib/external/mcp/handlers/bootstrap/pipeline/orchestrator.ts',
      'lib/workflows/deprecated-cold-start/checkpoint.ts',
      'lib/workflows/deprecated-cold-start/BootstrapSnapshot.ts',
      'lib/workflows/deprecated-cold-start/IncrementalBootstrap.ts',
      'lib/workflows/deprecated-cold-start/dimension-configs.ts',
      'lib/workflows/deprecated-cold-start/dimension-context.ts',
      'lib/workflows/deprecated-cold-start/tier-scheduler.ts',
      'lib/workflows/deprecated-cold-start/mock-pipeline.ts',
    ];

    expect(retiredFiles.filter((file) => existsSync(join(repoRoot, file)))).toEqual([]);
  });

  test('keeps retired compatibility directories free of TypeScript modules', () => {
    const retiredDirs = [
      'lib/agent/core',
      'lib/agent/tools',
      'lib/agent/adapters',
      'lib/agent/workflow',
      'lib/agent/dashboard',
      'lib/external/mcp/handlers/bootstrap/pipeline',
    ];

    const leftoverModules = retiredDirs.flatMap((dir) =>
      collectTypeScriptFiles(join(repoRoot, dir)).map((file) => relative(repoRoot, file))
    );

    expect(leftoverModules).toEqual([]);
  });

  test('uses new agent, tools, and workflow import paths', () => {
    const offenders: Array<{ file: string; specifier: string }> = [];
    for (const file of [
      ...collectTypeScriptFiles(join(repoRoot, 'lib')),
      ...collectTypeScriptFiles(join(repoRoot, 'test')),
    ]) {
      if (file === thisFile) {
        continue;
      }
      const relFile = relative(repoRoot, file);
      for (const specifier of extractImportSpecifiers(readFileSync(file, 'utf8'))) {
        if (isRetiredImportSpecifier(specifier, relFile)) {
          offenders.push({ file: relFile, specifier });
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('keeps protocol adapters at protocol boundaries', () => {
    const mcpAdapterPath = join(repoRoot, 'lib/external/mcp/McpToolAdapter.ts');
    const httpPresenterPath = join(repoRoot, 'lib/http/utils/tool-envelope-response.ts');

    expect(existsSync(mcpAdapterPath)).toBe(true);
    expect(existsSync(httpPresenterPath)).toBe(true);
    expect(existsSync(join(repoRoot, 'lib/tools/adapters/McpToolAdapter.ts'))).toBe(false);
    expect(existsSync(join(repoRoot, 'lib/tools/core/tool-envelope-response.ts'))).toBe(false);
    expect(readFileSync(mcpAdapterPath, 'utf8')).not.toContain('#agent/');
    expect(readFileSync(httpPresenterPath, 'utf8')).not.toContain('#agent/');
  });
});

function collectTypeScriptFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importPattern = /(?:from\s+|import\(\s*)['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(importPattern)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function isRetiredImportSpecifier(specifier: string, relFile: string) {
  const retiredSegments = [
    'lib/agent/core/',
    'lib/agent/tools/',
    'lib/agent/adapters/',
    'lib/agent/workflow/',
    'lib/agent/dashboard/',
    'lib/agent/domain/ChatAgentTasks',
    'lib/agent/runs/chat/ChatAgentTasks',
    'lib/agent/prompts/ChatAgentPrompts',
    'lib/external/mcp/handlers/bootstrap/MissionBriefingBuilder',
    'lib/external/mcp/handlers/bootstrap/BootstrapSession',
    'lib/external/mcp/handlers/bootstrap/ExternalSubmissionTracker',
    'lib/external/mcp/handlers/bootstrap/base-dimensions',
    'lib/external/mcp/handlers/bootstrap/shared/bootstrap-phases',
    'lib/external/mcp/handlers/bootstrap/shared/dimension-text',
    '#agent/core/',
    '#agent/tools/',
    '#agent/adapters/',
    '#agent/workflow/',
    '#agent/dashboard/',
  ];
  if (retiredSegments.some((segment) => specifier.includes(segment))) {
    return true;
  }
  return (
    relFile.startsWith('lib/external/mcp/handlers/bootstrap/') &&
    (specifier.startsWith('./pipeline/') ||
      specifier.startsWith('../pipeline/') ||
      specifier.includes('bootstrap/pipeline/'))
  );
}
