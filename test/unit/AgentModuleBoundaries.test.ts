import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const thisFile = fileURLToPath(import.meta.url);
const localAgentRoot = join('lib', 'agent');
const agentAlias = '#agent';
const agentAliasPrefix = `${agentAlias}/`;

describe('agent module boundaries', () => {
  test('removes the local duplicate agent implementation tree', () => {
    expect(existsSync(join(repoRoot, localAgentRoot))).toBe(false);
    expect(collectTypeScriptFiles(join(repoRoot, localAgentRoot))).toEqual([]);
  });

  test('does not restore retired compatibility entry files', () => {
    const retiredFiles = [
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
      'lib/external/mcp/handlers/bootstrap/pipeline',
      join('lib', 'workflows', 'bootstrap'),
      join('lib', 'workflows', 'common-capabilities'),
      join('lib', 'workflows', 'incremental-scan'),
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
    expect(readFileSync(mcpAdapterPath, 'utf8')).not.toContain(agentAliasPrefix);
    expect(readFileSync(httpPresenterPath, 'utf8')).not.toContain(agentAliasPrefix);
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

  test('does not restore incremental-scan lifecycle names', () => {
    const offenders: Array<{ file: string; token: string }> = [];

    for (const file of collectTypeScriptFiles(join(repoRoot, 'lib', 'workflows'))) {
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

    const retiredPersistenceSpecifiers = [
      'checkpoint/BootstrapCheckpointStore.js',
      'checkpoint/BootstrapRestoreState.js',
      'reports/BootstrapCheckpointCleanup.js',
      'reports/BootstrapReportHistoryStore.js',
      'reports/BootstrapReportSnapshotConsumer.js',
      'reports/BootstrapReportSnapshotWorkflow.js',
      'reports/BootstrapReportTypes.js',
      'reports/BootstrapReportWriter.js',
      'reports/BootstrapSnapshotStore.js',
    ].map((suffix) => ['#workflows', 'capabilities', 'persistence', suffix].join('/'));

    const retiredSpecifiers = new Set([
      ...retiredPersistenceSpecifiers,
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

  test('keeps file diff implementation owned by Core workflow naming', () => {
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
    ).toBe(false);
    expect(
      existsSync(
        join(repoRoot, 'lib/workflows/capabilities/project-intelligence/FileDiffSnapshotStore.ts')
      )
    ).toBe(false);
    expect(
      existsSync(
        join(
          repoRoot,
          'vendor/AlembicCore/src/workflows/capabilities/project-intelligence/FileDiffPlanner.ts'
        )
      )
    ).toBe(true);
    expect(
      existsSync(
        join(
          repoRoot,
          'vendor/AlembicCore/src/workflows/capabilities/project-intelligence/FileDiffSnapshotStore.ts'
        )
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
    'lib/external/mcp/handlers/bootstrap/MissionBriefingBuilder',
    'lib/external/mcp/handlers/bootstrap/BootstrapSession',
    'lib/external/mcp/handlers/bootstrap/ExternalSubmissionTracker',
    'lib/external/mcp/handlers/bootstrap/base-dimensions',
    'lib/external/mcp/handlers/bootstrap/shared/bootstrap-phases',
    'lib/external/mcp/handlers/bootstrap/shared/dimension-text',
  ];
  const retiredAgentSegments = [
    agentPath('core'),
    agentPath('tools'),
    agentPath('adapters'),
    agentPath('workflow'),
    agentPath('dashboard'),
    agentPath('domain', 'ChatAgentTasks'),
    agentPath('runs', 'chat', 'ChatAgentTasks'),
    agentPath('prompts', 'ChatAgentPrompts'),
    `${agentAliasPrefix}core/`,
    `${agentAliasPrefix}tools/`,
    `${agentAliasPrefix}adapters/`,
    `${agentAliasPrefix}workflow/`,
    `${agentAliasPrefix}dashboard/`,
  ];
  if (
    retiredSegments.some((segment) => specifier.includes(segment)) ||
    retiredAgentSegments.some((segment) => specifier.includes(segment))
  ) {
    return true;
  }
  return (
    relFile.startsWith('lib/external/mcp/handlers/bootstrap/') &&
    (specifier.startsWith('./pipeline/') ||
      specifier.startsWith('../pipeline/') ||
      specifier.includes('bootstrap/pipeline/'))
  );
}

function agentPath(...segments: string[]) {
  return `${join(localAgentRoot, ...segments).split('\\').join('/')}/`;
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
