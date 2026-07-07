import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { buildCanonicalCoverageLedgerModuleId } from '@alembic/core/host-agent-workflows';
import type { ProjectScopeAnalysisContext } from '../project-scope/ProjectScopeAnalysis.js';
import type {
  ProjectContextModule,
  ProjectContextWorkflowFacts,
} from './ProjectContextWorkflowFacts.js';

export type PanoramaEndpointFacts = Pick<
  ProjectContextWorkflowFacts,
  'fileCount' | 'moduleCount' | 'presenterInput' | 'projectMapModules' | 'projectRoot'
>;

export interface BuildPanoramaEndpointFactsInput {
  analysisScope: ProjectScopeAnalysisContext;
  maxFiles?: number;
}

interface PanoramaFactSourceRoot {
  displayName: string;
  path: string;
  relativeRoot: string;
  role: string;
}

interface ScannedSourceRoot {
  files: string[];
  root: PanoramaFactSourceRoot;
}

const DEFAULT_MAX_FILES = 800;

const EXCLUDED_SCAN_DIRS = new Set([
  '.asd',
  '.git',
  '.next',
  '.turbo',
  '.wakeflow-active',
  '.wakeflow-local',
  'coverage',
  'dist',
  'node_modules',
  'wakeflow-ledger',
]);

const SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.cxx',
  '.go',
  '.h',
  '.hpp',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.m',
  '.mm',
  '.mjs',
  '.py',
  '.rs',
  '.swift',
  '.ts',
  '.tsx',
]);

export async function buildPanoramaEndpointFacts(
  input: BuildPanoramaEndpointFactsInput
): Promise<PanoramaEndpointFacts> {
  const projectRoot = resolvePanoramaFactsProjectRoot(input.analysisScope);
  const sourceRoots = resolvePanoramaFactSourceRoots(input.analysisScope, projectRoot);
  const maxFiles = positiveInteger(input.maxFiles) ?? DEFAULT_MAX_FILES;
  const scannedRoots = await scanSourceRoots(sourceRoots, maxFiles);
  const projectMapModules = scannedRoots.flatMap((scanned) => buildModule(scanned, projectRoot));
  const fileCount = scannedRoots.reduce((sum, scanned) => sum + scanned.files.length, 0);

  return {
    fileCount,
    moduleCount: projectMapModules.length,
    presenterInput: {
      map: {
        cycles: [],
        dependencySummary: { edgeCount: 0 },
      },
    } as unknown as ProjectContextWorkflowFacts['presenterInput'],
    projectMapModules,
    projectRoot,
  };
}

function resolvePanoramaFactsProjectRoot(analysisScope: ProjectScopeAnalysisContext): string {
  return resolve(analysisScope.controlRoot ?? analysisScope.projectRoot);
}

function resolvePanoramaFactSourceRoots(
  analysisScope: ProjectScopeAnalysisContext,
  projectRoot: string
): PanoramaFactSourceRoot[] {
  const folders = analysisScope.projectScope?.folders ?? [];
  const controlRoot = analysisScope.controlRoot ?? analysisScope.projectScope?.controlRoot.path;
  if (controlRoot && folders.length > 0) {
    return folders.flatMap((folder) => {
      const relativeRoot = normalizeSourcePath(relative(controlRoot, folder.path));
      if (!relativeRoot) {
        return [];
      }
      return [
        {
          displayName: folder.displayName || basename(folder.path),
          path: resolve(folder.path),
          relativeRoot,
          role: folder.role || 'source',
        },
      ];
    });
  }

  return [
    {
      displayName: basename(projectRoot),
      path: projectRoot,
      relativeRoot: '',
      role: 'source',
    },
  ];
}

async function scanSourceRoots(
  sourceRoots: readonly PanoramaFactSourceRoot[],
  maxFiles: number
): Promise<ScannedSourceRoot[]> {
  if (sourceRoots.length === 0 || maxFiles <= 0) {
    return [];
  }

  const baseLimit = Math.max(1, Math.floor(maxFiles / sourceRoots.length));
  const remainder = maxFiles % sourceRoots.length;
  const scannedRoots: ScannedSourceRoot[] = [];
  for (const [index, root] of sourceRoots.entries()) {
    const rootLimit = baseLimit + (index < remainder ? 1 : 0);
    scannedRoots.push({
      files: await scanSourceRoot(root, rootLimit),
      root,
    });
  }
  return scannedRoots;
}

async function scanSourceRoot(
  sourceRoot: PanoramaFactSourceRoot,
  limit: number
): Promise<string[]> {
  const files: string[] = [];
  const pendingDirs = [''];
  while (pendingDirs.length > 0 && files.length < limit) {
    const relativeDir = pendingDirs.shift() ?? '';
    let entries: Dirent[];
    try {
      entries = await readdir(join(sourceRoot.path, relativeDir), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries.sort(compareScanEntries)) {
      const relativePath = normalizeSourcePath(join(relativeDir, entry.name));
      if (!relativePath) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!EXCLUDED_SCAN_DIRS.has(entry.name)) {
          pendingDirs.push(relativePath);
        }
        continue;
      }
      if (!entry.isFile() || !isSourceFile(relativePath)) {
        continue;
      }
      files.push(joinRelativeRoot(sourceRoot.relativeRoot, relativePath));
      if (files.length >= limit) {
        break;
      }
    }
  }
  return files;
}

function buildModule(scanned: ScannedSourceRoot, projectRoot: string): ProjectContextModule[] {
  const moduleName = scanned.root.displayName.trim();
  const modulePath = scanned.root.relativeRoot || inferSingleRootModulePath(scanned.files);
  if (!moduleName || !modulePath) {
    return [];
  }

  const moduleId = buildCanonicalCoverageLedgerModuleId({
    moduleName,
    modulePath,
    projectRoot,
  });
  if (!moduleId) {
    return [];
  }

  return [
    {
      kind: 'panorama-endpoint-lightweight',
      moduleId,
      moduleName,
      modulePath,
      ownedFileCount: scanned.files.length,
      ownedFiles: scanned.files.slice(0, 40),
      role: scanned.root.role,
    },
  ];
}

function inferSingleRootModulePath(files: readonly string[]): string | null {
  const firstFile = files[0];
  if (!firstFile) {
    return null;
  }
  const firstSegment = normalizeSourcePath(firstFile)?.split('/')[0];
  return firstSegment && firstSegment !== '.' ? firstSegment : null;
}

function compareScanEntries(left: Dirent, right: Dirent): number {
  return scanEntryScore(left) - scanEntryScore(right) || left.name.localeCompare(right.name);
}

function scanEntryScore(entry: Dirent): number {
  if (!entry.isDirectory()) {
    return 50;
  }
  if (entry.name === 'src' || entry.name === 'lib' || entry.name === 'Sources') {
    return 0;
  }
  if (entry.name === 'bin' || entry.name === 'scripts' || entry.name === 'test') {
    return 10;
  }
  if (entry.name.startsWith('.')) {
    return 80;
  }
  return 40;
}

function isSourceFile(filePath: string): boolean {
  const lastDot = filePath.lastIndexOf('.');
  return lastDot >= 0 && SOURCE_EXTENSIONS.has(filePath.slice(lastDot));
}

function joinRelativeRoot(relativeRoot: string, relativePath: string): string {
  return normalizeSourcePath(join(relativeRoot, relativePath)) ?? relativePath;
}

function normalizeSourcePath(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized;
}

function positiveInteger(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}
