import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  ProjectContextPresenterInput,
  ProjectContextRef,
  ProjectMap,
} from '@alembic/core/project-context';
import type { BootstrapFileEntry } from '../ai-execution/AgentRunInputBuilders.js';
import type { ProjectContextModule } from './ProjectContextWorkflowFacts.js';

export function buildProjectMapModules(map: ProjectMap | undefined): ProjectContextModule[] {
  return (map?.modules ?? [])
    .map((module) => {
      const modulePath = normalizeModulePath(module.ref?.scope.filePath);
      const moduleEntry: ProjectContextModule = {
        kind: module.kind,
        moduleId: module.id,
        moduleName: module.name,
        ownedFileCount: module.ownedFileCount,
        ref: module.ref,
        role: module.role,
      };
      if (modulePath) {
        moduleEntry.modulePath = modulePath;
        moduleEntry.ownedFiles = [modulePath];
      }
      return moduleEntry;
    })
    .filter((module) => module.moduleId.length > 0 && module.moduleName.length > 0);
}

export async function buildProjectMapModulesFromTargets(input: {
  allFiles: readonly BootstrapFileEntry[];
  input: ProjectContextPresenterInput;
  projectRoot: string;
}): Promise<ProjectContextModule[]> {
  const modules: ProjectContextModule[] = [];
  const swiftTargetPaths = await readSwiftPackageTargetPathMap(input.projectRoot);
  for (const target of input.input.repo?.targets ?? []) {
    const moduleName = target.name.trim();
    if (!moduleName) {
      continue;
    }

    const targetPath = inferTargetModulePath(input.input, target, input.allFiles, swiftTargetPaths);
    const ownedFiles = await inferTargetOwnedFiles({
      allFiles: input.allFiles,
      input: input.input,
      modulePath: targetPath,
      projectRoot: input.projectRoot,
      swiftTargetPaths,
      targetName: moduleName,
    });
    const modulePath = targetPath ?? inferCommonModulePath(ownedFiles);
    if (!modulePath || ownedFiles.length === 0) {
      continue;
    }

    modules.push({
      kind: target.kind,
      moduleId: `target:${moduleName}:${modulePath}`,
      moduleName,
      modulePath,
      ownedFileCount: ownedFiles.length,
      ownedFiles,
      ref: target.refs[0],
      role: target.kind ?? 'target',
    });
  }
  return dedupeProjectContextModules(modules);
}

function inferTargetModulePath(
  input: ProjectContextPresenterInput,
  target: NonNullable<ProjectContextPresenterInput['repo']>['targets'][number],
  allFiles: readonly BootstrapFileEntry[],
  swiftTargetPaths: ReadonlyMap<string, string>
): string | undefined {
  const fromRef = target.refs
    .map((ref) => normalizeRefModulePath(ref))
    .find((pathValue): pathValue is string => Boolean(pathValue));
  const fromSwiftPackage = swiftTargetPaths.get(target.name);
  if (fromRef && fromSwiftPackage && isPathWithinPrefix(fromSwiftPackage, fromRef)) {
    return fromSwiftPackage;
  }
  if (fromRef) {
    return fromRef;
  }

  if (fromSwiftPackage) {
    return fromSwiftPackage;
  }

  const fromPackage = input.repo?.localPackages
    .filter((pkg) => pkg.name === target.name)
    .map((pkg) => normalizeModulePath(pkg.path))
    .find((pathValue): pathValue is string => Boolean(pathValue));
  if (fromPackage) {
    return fromPackage;
  }

  return inferCommonModulePath(
    inferSampledTargetOwnedFiles(input, target.name, undefined, allFiles, swiftTargetPaths)
  );
}

function normalizeRefModulePath(ref: ProjectContextRef): string | undefined {
  const normalized = normalizeModulePath(ref.scope.filePath);
  if (!normalized) {
    return undefined;
  }
  if (normalized === 'Package.swift') {
    return undefined;
  }
  if (normalized.endsWith('/Package.swift')) {
    return normalizeModulePath(dirname(normalized));
  }
  return normalized;
}

async function inferTargetOwnedFiles(input: {
  allFiles: readonly BootstrapFileEntry[];
  input: ProjectContextPresenterInput;
  modulePath: string | undefined;
  projectRoot: string;
  swiftTargetPaths: ReadonlyMap<string, string>;
  targetName: string;
}): Promise<string[]> {
  const sampledFiles = inferSampledTargetOwnedFiles(
    input.input,
    input.targetName,
    input.modulePath,
    input.allFiles,
    input.swiftTargetPaths
  );
  if (sampledFiles.length > 0) {
    return sampledFiles;
  }

  const prefixes = buildTargetPathPrefixes(
    input.input,
    input.targetName,
    input.modulePath,
    input.swiftTargetPaths
  );
  return collectOwnedFilesFromProjectRoot(input.projectRoot, prefixes);
}

function inferSampledTargetOwnedFiles(
  input: ProjectContextPresenterInput,
  targetName: string,
  modulePath: string | undefined,
  allFiles: readonly BootstrapFileEntry[],
  swiftTargetPaths: ReadonlyMap<string, string>
): string[] {
  const prefixes = buildTargetPathPrefixes(input, targetName, modulePath, swiftTargetPaths);
  return dedupeStrings(
    allFiles
      .map((file) => file.relativePath)
      .filter((filePath): filePath is string => Boolean(filePath))
      .filter((filePath) => prefixes.some((prefix) => isPathWithinPrefix(filePath, prefix)))
  );
}

function buildTargetPathPrefixes(
  input: ProjectContextPresenterInput,
  targetName: string,
  modulePath: string | undefined,
  swiftTargetPaths: ReadonlyMap<string, string>
): string[] {
  const normalizedTargetName = normalizeModulePath(targetName);
  const swiftTargetPath = swiftTargetPaths.get(targetName);
  const explicitPrefixes = dedupeStrings([modulePath ?? '', swiftTargetPath ?? '']);
  if (explicitPrefixes.length > 0) {
    return explicitPrefixes;
  }

  return dedupeStrings([
    ...(normalizedTargetName
      ? [
          normalizedTargetName,
          `Sources/${normalizedTargetName}`,
          `Source/${normalizedTargetName}`,
          `Tests/${normalizedTargetName}`,
          `Packages/${normalizedTargetName}`,
          `src/${normalizedTargetName}`,
        ]
      : []),
    ...(input.repo?.localPackages ?? [])
      .filter((pkg) => pkg.name === targetName)
      .map((pkg) => normalizeModulePath(pkg.path))
      .filter((pathValue): pathValue is string => Boolean(pathValue)),
  ]);
}

async function readSwiftPackageTargetPathMap(projectRoot: string): Promise<Map<string, string>> {
  try {
    const packageText = await readFile(join(projectRoot, 'Package.swift'), 'utf8');
    const targetPaths = extractSwiftTargetPathMap(packageText);
    for (const packagePath of extractSwiftLocalPackagePaths(packageText)) {
      try {
        const nestedPackageText = await readFile(
          join(projectRoot, packagePath, 'Package.swift'),
          'utf8'
        );
        for (const [targetName, targetPath] of extractSwiftTargetPathMap(nestedPackageText)) {
          const prefixedTargetPath = normalizeModulePath(join(packagePath, targetPath));
          if (prefixedTargetPath && !targetPaths.has(targetName)) {
            targetPaths.set(targetName, prefixedTargetPath);
          }
        }
      } catch {
        // Missing local package manifests simply leave target refs as the fallback path source.
      }
    }
    return targetPaths;
  } catch {
    return new Map();
  }
}

function extractSwiftTargetPathMap(packageText: string): Map<string, string> {
  const targetPaths = new Map<string, string>();
  for (const targetName of extractSwiftTargetNames(packageText)) {
    targetPaths.set(targetName, `Sources/${targetName}`);
  }
  for (const match of packageText.matchAll(
    /\.target\s*\(\s*name:\s*"([^"]+)"(?:(?!\.target\s*\().)*?path:\s*"([^"]+)"/gs
  )) {
    const targetName = match[1]?.trim();
    const targetPath = normalizeModulePath(match[2]);
    if (targetName && targetPath) {
      targetPaths.set(targetName, targetPath);
    }
  }
  return targetPaths;
}

function extractSwiftTargetNames(packageText: string): string[] {
  return dedupeStrings(
    [...packageText.matchAll(/\.target\s*\(\s*name:\s*"([^"]+)"/g)]
      .map((match) => match[1]?.trim())
      .filter((targetName): targetName is string => Boolean(targetName))
  );
}

function extractSwiftLocalPackagePaths(packageText: string): string[] {
  return dedupeStrings(
    [...packageText.matchAll(/\.package\s*\(\s*path:\s*"([^"]+)"/g)]
      .map((match) => normalizeModulePath(match[1]))
      .filter((pathValue): pathValue is string => Boolean(pathValue))
  );
}

function isPathWithinPrefix(pathValue: string, prefix: string): boolean {
  return pathValue === prefix || pathValue.startsWith(`${prefix}/`);
}

async function collectOwnedFilesFromProjectRoot(
  projectRoot: string,
  prefixes: readonly string[]
): Promise<string[]> {
  const files: string[] = [];
  for (const prefix of prefixes) {
    const normalizedPrefix = normalizeModulePath(prefix);
    if (!normalizedPrefix) {
      continue;
    }
    files.push(...(await collectFilesUnderProjectPath(projectRoot, normalizedPrefix, 80)));
  }
  return dedupeStrings(files);
}

async function collectFilesUnderProjectPath(
  projectRoot: string,
  relativePath: string,
  limit: number
): Promise<string[]> {
  const root = resolve(projectRoot);
  const absolutePath = resolve(join(root, relativePath));
  const normalizedRelativePath = projectRelativePath(root, absolutePath);
  if (!normalizedRelativePath) {
    return [];
  }
  try {
    const fileStat = await stat(absolutePath);
    if (fileStat.isFile()) {
      return [normalizedRelativePath];
    }
    if (!fileStat.isDirectory()) {
      return [];
    }
    return collectFilesFromDirectory(root, absolutePath, limit);
  } catch {
    return [];
  }
}

async function collectFilesFromDirectory(
  projectRoot: string,
  directoryPath: string,
  limit: number
): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (files.length >= limit) {
      break;
    }
    if (shouldSkipOwnedFileEntry(entry.name)) {
      continue;
    }
    const absoluteEntryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(
        ...(await collectFilesFromDirectory(projectRoot, absoluteEntryPath, limit - files.length))
      );
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const relativeEntryPath = projectRelativePath(projectRoot, absoluteEntryPath);
    if (relativeEntryPath) {
      files.push(relativeEntryPath);
    }
  }
  return files.slice(0, limit);
}

function projectRelativePath(projectRoot: string, absolutePath: string): string | undefined {
  const relativePath = relative(projectRoot, absolutePath);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return undefined;
  }
  return normalizeModulePath(relativePath);
}

function shouldSkipOwnedFileEntry(name: string): boolean {
  return [
    '.asd',
    '.build',
    '.git',
    'DerivedData',
    'build',
    'coverage',
    'dist',
    'node_modules',
  ].includes(name);
}

function inferCommonModulePath(ownedFiles: readonly string[]): string | undefined {
  const directories = ownedFiles
    .map((filePath) => normalizeModulePath(dirname(filePath)))
    .filter((pathValue): pathValue is string => Boolean(pathValue));
  if (directories.length === 0) {
    return undefined;
  }
  const commonSegments = directories[0].split('/');
  for (const directory of directories.slice(1)) {
    const segments = directory.split('/');
    while (
      commonSegments.length > 0 &&
      commonSegments.join('/') !== segments.slice(0, commonSegments.length).join('/')
    ) {
      commonSegments.pop();
    }
  }
  return normalizeModulePath(commonSegments.join('/'));
}

function dedupeProjectContextModules(
  modules: readonly ProjectContextModule[]
): ProjectContextModule[] {
  const byKey = new Map<string, ProjectContextModule>();
  for (const module of modules) {
    const key = `${module.moduleId}:${module.modulePath ?? ''}`;
    if (!byKey.has(key)) {
      byKey.set(key, module);
    }
  }
  return [...byKey.values()];
}

function normalizeModulePath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '.') {
    return undefined;
  }
  return trimmed.replace(/\\/g, '/').replace(/\/$/, '');
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}
