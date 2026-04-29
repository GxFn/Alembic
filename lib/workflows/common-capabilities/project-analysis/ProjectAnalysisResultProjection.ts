import { inferTargetRole } from '#workflows/common-capabilities/presentation/TargetClassifier.js';

type ProjectAnalysisTargetItem =
  | string
  | {
      name: string;
      type?: string;
      packageName?: string;
      path?: unknown;
    };

interface ProjectAnalysisTargetFile {
  targetName: string;
  relativePath: string;
}

export interface ProjectAnalysisTargetSummary {
  name: string;
  type: string;
  packageName?: string;
  inferredRole: string;
  fileCount: number;
  isLocalPackage?: true;
}

export interface ProjectAnalysisLocalPackageModule {
  name: string;
  packageName: string;
  fileCount: number;
  inferredRole: string;
  keyFiles: string[];
}

export function buildProjectAnalysisTargetsSummary({
  allTargets,
  allFiles,
  projectRoot,
}: {
  allTargets: ProjectAnalysisTargetItem[];
  allFiles: ProjectAnalysisTargetFile[];
  projectRoot: string;
}): ProjectAnalysisTargetSummary[] {
  return allTargets.map((target) => {
    const name = typeof target === 'string' ? target : target.name;
    const packageName = typeof target === 'object' ? target.packageName : undefined;
    const targetPath = typeof target === 'object' ? target.path : undefined;
    return {
      name,
      type: (typeof target === 'object' ? target.type : undefined) || 'target',
      packageName: packageName || undefined,
      inferredRole: inferTargetRole(name),
      fileCount: allFiles.filter((file) => file.targetName === name).length,
      isLocalPackage:
        typeof targetPath === 'string' && targetPath !== projectRoot ? true : undefined,
    };
  });
}

export function buildProjectAnalysisLocalPackageModules({
  targetsSummary,
  allFiles,
}: {
  targetsSummary: ProjectAnalysisTargetSummary[];
  allFiles: ProjectAnalysisTargetFile[];
}): ProjectAnalysisLocalPackageModule[] {
  return targetsSummary
    .filter((target) => target.isLocalPackage && target.fileCount > 0)
    .map((target) => ({
      name: target.name,
      packageName: target.packageName || target.name,
      fileCount: target.fileCount,
      inferredRole: target.inferredRole,
      keyFiles: allFiles
        .filter((file) => file.targetName === target.name)
        .slice(0, 8)
        .map((file) => file.relativePath),
    }));
}
