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
      join('lib', 'workflows', 'bootstrap'),
      join('lib', 'workflows', 'common-capabilities'),
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

  test('keeps workflow layer independent from handler internals', () => {
    const offenders: Array<{ file: string; specifier: string }> = [];
    for (const file of collectTypeScriptFiles(join(repoRoot, 'lib', 'workflows'))) {
      const relFile = relative(repoRoot, file);
      for (const specifier of extractImportSpecifiers(readFileSync(file, 'utf8'))) {
        if (isHandlerInternalImport(specifier)) {
          offenders.push({ file: relFile, specifier });
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('keeps internal dimension execution off retired fill entrypoints', () => {
    const offenders: Array<{ file: string; token: string }> = [];

    for (const file of collectTypeScriptFiles(join(repoRoot, 'lib', 'workflows'))) {
      const relFile = relative(repoRoot, file);
      const source = readFileSync(file, 'utf8');
      for (const token of [
        'fillDimensionsV3',
        'InternalDimensionFillWorkflow.js',
        'InternalDimensionFillPipeline.js',
      ]) {
        if (source.includes(token)) {
          offenders.push({ file: relFile, token });
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('keeps knowledge rescan implementation off incremental-scan lifecycle names', () => {
    const compatibilityRoot = join(repoRoot, 'lib', 'workflows', 'incremental-scan');
    const offenders: Array<{ file: string; token: string }> = [];

    for (const file of collectTypeScriptFiles(join(repoRoot, 'lib', 'workflows'))) {
      if (file.startsWith(compatibilityRoot)) {
        continue;
      }
      const relFile = relative(repoRoot, file);
      const source = readFileSync(file, 'utf8');
      for (const token of ['#workflows/incremental-scan/', 'IncrementalScan']) {
        if (source.includes(token)) {
          offenders.push({ file: relFile, token });
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('does not restore D6 retired Bootstrap compatibility modules', () => {
    const retiredFiles = [
      join(
        'lib',
        'workflows',
        'common-capabilities',
        'progress',
        'checkpoint',
        'BootstrapCheckpointStore.ts'
      ),
      join(
        'lib',
        'workflows',
        'common-capabilities',
        'progress',
        'checkpoint',
        'BootstrapRestoreState.ts'
      ),
      join(
        'lib',
        'workflows',
        'common-capabilities',
        'progress',
        'reports',
        'BootstrapCheckpointCleanup.ts'
      ),
      join(
        'lib',
        'workflows',
        'common-capabilities',
        'progress',
        'reports',
        'BootstrapReportHistoryStore.ts'
      ),
      join(
        'lib',
        'workflows',
        'common-capabilities',
        'progress',
        'reports',
        'BootstrapReportSnapshotConsumer.ts'
      ),
      join(
        'lib',
        'workflows',
        'common-capabilities',
        'progress',
        'reports',
        'BootstrapReportSnapshotWorkflow.ts'
      ),
      join(
        'lib',
        'workflows',
        'common-capabilities',
        'progress',
        'reports',
        'BootstrapReportTypes.ts'
      ),
      join(
        'lib',
        'workflows',
        'common-capabilities',
        'progress',
        'reports',
        'BootstrapReportWriter.ts'
      ),
      join(
        'lib',
        'workflows',
        'common-capabilities',
        'progress',
        'reports',
        'BootstrapSnapshotStore.ts'
      ),
      join('lib', 'workflows', 'common-capabilities', 'delivery', 'BootstrapDeliveryConsumer.ts'),
      join(
        'lib',
        'workflows',
        'common-capabilities',
        'agent-execution',
        'internal',
        'consumers',
        'BootstrapSemanticMemoryConsumer.ts'
      ),
      join('lib', 'external', 'mcp', 'handlers', 'bootstrap', 'shared', 'async-fill-helpers.ts'),
      join('lib', 'external', 'mcp', 'handlers', 'bootstrap', 'shared', 'audit-helpers.ts'),
      join('lib', 'external', 'mcp', 'handlers', 'bootstrap', 'shared', 'handler-types.ts'),
      join('lib', 'external', 'mcp', 'handlers', 'bootstrap', 'shared', 'panorama-utils.ts'),
      join('lib', 'external', 'mcp', 'handlers', 'bootstrap', 'shared', 'session-helpers.ts'),
      join('lib', 'external', 'mcp', 'handlers', 'bootstrap', 'shared', 'skill-generator.ts'),
      join('lib', 'external', 'mcp', 'handlers', 'bootstrap', 'shared', 'target-file-map.ts'),
    ];
    expect(retiredFiles.filter((file) => existsSync(join(repoRoot, file)))).toEqual([]);

    const retiredSpecifiers = new Set([
      '#workflows/capabilities/persistence/checkpoint/BootstrapCheckpointStore.js',
      '#workflows/capabilities/persistence/checkpoint/BootstrapRestoreState.js',
      '#workflows/capabilities/persistence/reports/BootstrapCheckpointCleanup.js',
      '#workflows/capabilities/persistence/reports/BootstrapReportHistoryStore.js',
      '#workflows/capabilities/persistence/reports/BootstrapReportSnapshotConsumer.js',
      '#workflows/capabilities/persistence/reports/BootstrapReportSnapshotWorkflow.js',
      '#workflows/capabilities/persistence/reports/BootstrapReportTypes.js',
      '#workflows/capabilities/persistence/reports/BootstrapReportWriter.js',
      '#workflows/capabilities/persistence/reports/BootstrapSnapshotStore.js',
      '#workflows/common-capabilities/delivery/BootstrapDeliveryConsumer.js',
      '#workflows/capabilities/execution/internal-agent/consumers/BootstrapSemanticMemoryConsumer.js',
      '#external/mcp/handlers/bootstrap/shared/async-fill-helpers.js',
      '#external/mcp/handlers/bootstrap/shared/audit-helpers.js',
      '#external/mcp/handlers/bootstrap/shared/handler-types.js',
      '#external/mcp/handlers/bootstrap/shared/panorama-utils.js',
      '#external/mcp/handlers/bootstrap/shared/session-helpers.js',
      '#external/mcp/handlers/bootstrap/shared/skill-generator.js',
      '#external/mcp/handlers/bootstrap/shared/target-file-map.js',
    ]);
    const offenders: Array<{ file: string; specifier: string }> = [];

    for (const file of [
      ...collectTypeScriptFiles(join(repoRoot, 'lib')),
      ...collectTypeScriptFiles(join(repoRoot, 'test')),
    ]) {
      const relFile = relative(repoRoot, file);
      if (file === thisFile) {
        continue;
      }
      for (const specifier of extractImportSpecifiers(readFileSync(file, 'utf8'))) {
        if (
          retiredSpecifiers.has(specifier) ||
          isRetiredBootstrapSharedRelativeImport(specifier, relFile)
        ) {
          offenders.push({ file: relFile, specifier });
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('keeps file diff implementation on workflow naming', () => {
    const retiredSpecifiers = new Set([
      '#workflows/common-capabilities/file-diff/BootstrapSnapshot.js',
      '#workflows/common-capabilities/file-diff/IncrementalBootstrap.js',
    ]);
    const offenders: Array<{ file: string; specifier: string }> = [];

    for (const file of collectTypeScriptFiles(join(repoRoot, 'lib', 'workflows'))) {
      const relFile = relative(repoRoot, file);
      for (const specifier of extractImportSpecifiers(readFileSync(file, 'utf8'))) {
        if (retiredSpecifiers.has(specifier)) {
          offenders.push({ file: relFile, specifier });
        }
      }
    }

    expect(offenders).toEqual([]);
    expect(
      existsSync(
        join(repoRoot, 'lib/workflows/capabilities/project-intelligence/FileDiffPlanner.ts')
      )
    ).toBe(true);
    expect(
      existsSync(
        join(repoRoot, 'lib/workflows/capabilities/project-intelligence/FileDiffSnapshotStore.ts')
      )
    ).toBe(true);
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

function isHandlerInternalImport(specifier: string) {
  return (
    specifier === '#external/mcp/handlers/types.js' ||
    specifier === '#external/mcp/handlers/evolution-prescreen.js' ||
    specifier === '#external/mcp/handlers/LanguageExtensions.js' ||
    specifier === '#external/mcp/handlers/TargetClassifier.js' ||
    specifier.startsWith('#external/mcp/handlers/bootstrap/shared/')
  );
}

function isRetiredBootstrapSharedRelativeImport(specifier: string, relFile: string) {
  return (
    specifier.includes('/bootstrap/shared/') ||
    specifier.startsWith('./bootstrap/shared/') ||
    specifier.startsWith('../bootstrap/shared/') ||
    ((specifier.startsWith('./shared/') || specifier.startsWith('../shared/')) &&
      relFile.startsWith('lib/external/mcp/handlers/bootstrap/'))
  );
}
