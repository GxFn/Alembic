import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = process.cwd();

describe('workflow naming boundary', () => {
  test('keeps Alembic workflows on API AI terminology', () => {
    const workflowFiles = collectTypeScriptFiles(join(repoRoot, 'lib/workflows'));
    const workflowPaths = workflowFiles.map((file) => relative(repoRoot, file));
    const workflowSource = workflowFiles.map((file) => readFileSync(file, 'utf8')).join('\n');

    expect(workflowPaths.some((file) => file.includes('/internal-agent/'))).toBe(false);
    expect(workflowPaths.some((file) => file.includes('/cold-start/internal/'))).toBe(false);
    expect(workflowPaths.some((file) => file.includes('/knowledge-rescan/internal/'))).toBe(false);

    expect(workflowSource).not.toMatch(/\bexport\s+async\s+function\s+runInternal[A-Z]/);
    expect(workflowSource).not.toMatch(/\bexport\s+function\s+dispatchInternal[A-Z]/);
    expect(workflowSource).not.toMatch(/\bexport\s+function\s+startInternal[A-Z]/);
    expect(workflowSource).not.toContain('internal AI');
    expect(workflowSource).not.toContain('InternalDimension');
  });

  test('keeps retired workflow nesting absent from the working tree', () => {
    expect(existsSync(join(repoRoot, 'lib/workflows/capabilities'))).toBe(false);
    expect(existsSync(join(repoRoot, 'lib/workflows/cold-start/internal'))).toBe(false);
    expect(existsSync(join(repoRoot, 'lib/workflows/knowledge-rescan/internal'))).toBe(false);
  });

  test('keeps active API AI runtime contract free of retired producer names', () => {
    expect(existsSync(join(repoRoot, 'lib/daemon/ApiAiCompatibility.ts'))).toBe(false);

    const libFiles = collectTypeScriptFiles(join(repoRoot, 'lib'));
    const libSource = libFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
    const retiredApiAiContractTokens = [
      ['internal', 'Ai'].join(''),
      ['internal', 'ai'].join('-'),
      ['internal', ' AI'].join(''),
      ['Internal', 'Ai'].join(''),
      ['Internal', ' AI'].join(''),
      ['jobs', ['internal', 'ai'].join('-')].join('.'),
      ['Alembic', 'Internal', 'Ai'].join(''),
      ['ProjectRuntime', 'Internal', 'Ai'].join(''),
    ];

    for (const token of retiredApiAiContractTokens) {
      expect(libSource).not.toContain(token);
    }
  });

  test('keeps host-owned single-file modules out of redundant nesting', () => {
    expect(existsSync(join(repoRoot, 'lib/tools/v2/adapter'))).toBe(false);
    expect(existsSync(join(repoRoot, 'lib/repository/audit'))).toBe(false);
    expect(
      collectTypeScriptFiles(join(repoRoot, 'lib/repository')).map((file) =>
        relative(repoRoot, file)
      )
    ).toEqual(['lib/repository/AuditRepository.ts']);

    const sourceFiles = [
      ...collectTypeScriptFiles(join(repoRoot, 'lib')),
      ...collectTypeScriptFiles(join(repoRoot, 'test')),
      ...collectJavaScriptFiles(join(repoRoot, 'scripts')),
    ];
    const source = sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
    const retiredToolContextImport = ['#tools', 'v2', 'adapter', 'ToolContextFactory'].join('/');
    const retiredAuditRepositoryPath = ['repository', 'audit', 'AuditRepository'].join('/');

    expect(source).not.toContain(retiredToolContextImport);
    expect(source).not.toContain(retiredAuditRepositoryPath);
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

function collectJavaScriptFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJavaScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      files.push(fullPath);
    }
  }
  return files;
}
