import { isAbsolute, relative, resolve, sep } from 'node:path';

export type PanoramaModuleRecipeCountMode = 'per-module-coverage-ledger' | 'project-total-only';

export type PanoramaModuleRecipeCountReason =
  | 'direct-module-id-aligned'
  | 'direct-module-id-mismatch'
  | 'no-scoped-modules';

export type PanoramaModuleRecipeCountSource = 'coverage-ledger-direct' | 'degraded-project-total';

export interface PanoramaModuleIdAlignmentEvidence {
  directAligned: boolean;
  source: 'core-p0-characterization' | 'runtime-check';
}

export interface PanoramaProjectScopeBoundaryInput {
  controlRoot?: string | null;
  memberRoots?: readonly string[];
}

export interface PanoramaProjectMapModuleInput {
  moduleId: string;
  moduleName: string;
  modulePath?: string;
  projectRoot?: string;
}

export interface PanoramaCoverageLedgerCellInput {
  coveredCount: number;
  moduleId: string;
  projectRoot: string;
}

export interface BuildPanoramaModuleRecipeCountContractInput {
  coverageLedgerCells: readonly PanoramaCoverageLedgerCellInput[];
  moduleIdAlignment: PanoramaModuleIdAlignmentEvidence;
  projectMapModules: readonly PanoramaProjectMapModuleInput[];
  projectRoot: string;
  scope?: PanoramaProjectScopeBoundaryInput;
  totalRecipes: number;
}

export interface PanoramaRecipeCountModuleView {
  moduleId: string;
  moduleName: string;
  modulePath?: string;
  projectRoot?: string;
  recipeCount: number | null;
  recipeCountSource: PanoramaModuleRecipeCountSource;
}

export interface PanoramaRecipeCountScopeBoundary {
  excludedCoverageCellCount: number;
  excludedModuleCount: number;
  memberRoots: string[];
  mode: 'members-only' | 'project-root';
}

export interface PanoramaModuleRecipeCountContract {
  mode: PanoramaModuleRecipeCountMode;
  moduleRecipeCounts: PanoramaRecipeCountModuleView[];
  projectRecipeCount: {
    totalRecipes: number;
    source: 'knowledge-entries';
  };
  reason: PanoramaModuleRecipeCountReason;
  scopeBoundary: PanoramaRecipeCountScopeBoundary;
}

export function buildPanoramaModuleRecipeCountContract(
  input: BuildPanoramaModuleRecipeCountContractInput
): PanoramaModuleRecipeCountContract {
  const scope = normalizeScopeBoundary(input.projectRoot, input.scope);
  const scopedModules = input.projectMapModules.filter((module) =>
    isScopedProjectRoot(module.projectRoot, scope.memberRoots)
  );
  const scopedCells = input.coverageLedgerCells.filter((cell) =>
    isScopedProjectRoot(cell.projectRoot, scope.memberRoots)
  );
  const totalRecipes = nonNegativeInteger(input.totalRecipes);
  const scopeBoundary: PanoramaRecipeCountScopeBoundary = {
    excludedCoverageCellCount: input.coverageLedgerCells.length - scopedCells.length,
    excludedModuleCount: input.projectMapModules.length - scopedModules.length,
    memberRoots: scope.memberRoots,
    mode: scope.mode,
  };

  if (scopedModules.length === 0) {
    return {
      mode: 'project-total-only',
      moduleRecipeCounts: [],
      projectRecipeCount: {
        source: 'knowledge-entries',
        totalRecipes,
      },
      reason: 'no-scoped-modules',
      scopeBoundary,
    };
  }

  if (!input.moduleIdAlignment.directAligned) {
    return {
      mode: 'project-total-only',
      moduleRecipeCounts: scopedModules.map((module) => ({
        ...moduleView(module),
        recipeCount: null,
        recipeCountSource: 'degraded-project-total',
      })),
      projectRecipeCount: {
        source: 'knowledge-entries',
        totalRecipes,
      },
      reason: 'direct-module-id-mismatch',
      scopeBoundary,
    };
  }

  const countsByModuleId = sumCoverageCountsByModuleId(scopedCells);
  return {
    mode: 'per-module-coverage-ledger',
    moduleRecipeCounts: scopedModules.map((module) => ({
      ...moduleView(module),
      recipeCount: countsByModuleId.get(module.moduleId) ?? 0,
      recipeCountSource: 'coverage-ledger-direct',
    })),
    projectRecipeCount: {
      source: 'knowledge-entries',
      totalRecipes,
    },
    reason: 'direct-module-id-aligned',
    scopeBoundary,
  };
}

function normalizeScopeBoundary(
  projectRoot: string,
  scope: PanoramaProjectScopeBoundaryInput | undefined
): { memberRoots: string[]; mode: 'members-only' | 'project-root' } {
  const memberRoots = uniqueResolvedPaths(scope?.memberRoots ?? []);
  if (memberRoots.length > 0) {
    return {
      memberRoots,
      mode: 'members-only',
    };
  }
  return {
    memberRoots: [resolve(projectRoot)],
    mode: 'project-root',
  };
}

function isScopedProjectRoot(projectRoot: string | undefined, memberRoots: readonly string[]) {
  if (!projectRoot) {
    return true;
  }
  const resolvedProjectRoot = resolve(projectRoot);
  return memberRoots.some((memberRoot) => isPathWithinOrEqual(resolvedProjectRoot, memberRoot));
}

function isPathWithinOrEqual(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') &&
      !relativePath.split(sep).includes('..') &&
      !isAbsolute(relativePath))
  );
}

function moduleView(module: PanoramaProjectMapModuleInput) {
  return {
    moduleId: module.moduleId,
    moduleName: module.moduleName,
    ...(module.modulePath ? { modulePath: module.modulePath } : {}),
    ...(module.projectRoot ? { projectRoot: module.projectRoot } : {}),
  };
}

function sumCoverageCountsByModuleId(
  cells: readonly PanoramaCoverageLedgerCellInput[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const cell of cells) {
    counts.set(
      cell.moduleId,
      (counts.get(cell.moduleId) ?? 0) + nonNegativeInteger(cell.coveredCount)
    );
  }
  return counts;
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function uniqueResolvedPaths(paths: readonly string[]): string[] {
  return [
    ...new Set(
      paths
        .map((path) => path.trim())
        .filter(Boolean)
        .map((path) => resolve(path))
    ),
  ];
}
