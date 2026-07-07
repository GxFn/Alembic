import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  buildCanonicalCoverageLedgerModuleId,
  buildCoverageLedgerPanoramaRollup,
  type CoverageLedgerPanoramaDimensionCoverage,
  type CoverageLedgerPanoramaGap,
  type CoverageLedgerPanoramaHealthRadar,
  isTargetScopedCoverageModuleId,
} from '@alembic/core/host-agent-workflows';
import type { CoverageLedgerRecord } from '@alembic/core/repositories';
import type { ProjectScopeAnalysisContext } from '../project-scope/ProjectScopeAnalysis.js';
import {
  buildPanoramaModuleRecipeCountContract,
  type PanoramaModuleRecipeCountContract,
  type PanoramaProjectMapModuleInput,
} from './PanoramaCgeContract.js';
import type {
  ProjectContextModule,
  ProjectContextWorkflowFacts,
} from './ProjectContextWorkflowFacts.js';

export interface BuildPanoramaEndpointViewInput {
  analysisScope: ProjectScopeAnalysisContext;
  computedAt?: number;
  coverageLedgerCells: readonly CoverageLedgerRecord[];
  facts: Pick<
    ProjectContextWorkflowFacts,
    'fileCount' | 'moduleCount' | 'presenterInput' | 'projectMapModules' | 'projectRoot'
  >;
  totalRecipes: number;
}

export interface PanoramaLayerModule {
  fileCount: number;
  moduleId: string;
  modulePath?: string;
  name: string;
  projectRoot?: string;
  recipeCount: number | null;
  recipeCountSource: 'coverage-ledger-direct' | 'degraded-project-total';
  role: string;
}

export interface PanoramaArchitectureLayer {
  level: number;
  modules: PanoramaLayerModule[];
  name: string;
}

export interface PanoramaHealthRadarDimension {
  cellCount: number;
  coveredCellCount: number;
  coveredCandidateCount: number;
  description: string;
  id: string;
  level: 'strong' | 'adequate' | 'weak' | 'missing';
  missingCellCount: number;
  name: string;
  partialCellCount: number;
  recipeCount: number;
  score: number;
  status: 'strong' | 'adequate' | 'weak' | 'missing';
  topRecipes: string[];
  totalCandidateCount: number;
  weakCellCount: number;
}

export interface PanoramaHealthRadarView {
  basis: CoverageLedgerPanoramaHealthRadar['basis'];
  coveredDimensions: number;
  dimensionCoverage: number;
  dimensions: PanoramaHealthRadarDimension[];
  overallScore: number;
  totalDimensions: number;
  totalRecipes: number;
}

export interface PanoramaScopeBoundaryView {
  controlRoot: string | null;
  excludedCoverageCellCount: number;
  excludedModuleCount: number;
  memberRoots: string[];
  mode: 'members-only' | 'project-root';
  projectRoot: string;
  projectScopeId: string | null;
}

export interface PanoramaRecipeCountView {
  mode: PanoramaModuleRecipeCountContract['mode'];
  projectRecipeCount: PanoramaModuleRecipeCountContract['projectRecipeCount'];
  reason: PanoramaModuleRecipeCountContract['reason'];
}

export interface PanoramaOverview {
  computedAt: number;
  cycleCount: number;
  dimensionCoverage: number;
  gapCount: number;
  healthRadar: PanoramaHealthRadarView;
  layerCount: number;
  layers: PanoramaArchitectureLayer[];
  moduleCount: number;
  overallCoverage: number;
  projectRoot: string;
  projectScope: PanoramaScopeBoundaryView;
  recipeCount: PanoramaRecipeCountView;
  stale: boolean;
  totalFiles: number;
  totalRecipes: number;
}

export interface PanoramaHealth {
  avgCoupling: number;
  cycleCount: number;
  gapCount: number;
  healthRadar: PanoramaHealthRadarView;
  healthScore: number;
  highPriorityGaps: number;
  moduleCount: number;
}

export interface PanoramaKnowledgeGap {
  affectedModuleIds: string[];
  affectedRoles: string[];
  dimension: string;
  dimensionName: string;
  missingCellCount: number;
  priority: CoverageLedgerPanoramaGap['priority'];
  recipeCount: number;
  status: CoverageLedgerPanoramaGap['status'];
  suggestedTopics: string[];
  valueScore: number;
  weakCellCount: number;
}

export interface PanoramaEndpointView {
  diagnostics: {
    directModuleIdAligned: boolean;
    recipeCountReason: PanoramaModuleRecipeCountContract['reason'];
    rollupBasis: 'coverage-ledger-rollup';
  };
  gaps: PanoramaKnowledgeGap[];
  health: PanoramaHealth;
  overview: PanoramaOverview;
}

interface ScopeMember {
  displayName: string;
  path: string;
  relativeRoot: string;
  role: string | null;
}

interface DecoratedModule extends ProjectContextModule {
  moduleId: string;
  moduleName: string;
  projectRoot?: string;
}

export function buildPanoramaEndpointView(
  input: BuildPanoramaEndpointViewInput
): PanoramaEndpointView {
  const projectRoot = resolvePanoramaProjectRoot(input);
  const scopeMembers = resolveScopeMembers(input.analysisScope);
  const decoratedModules = decorateProjectMapModules({
    modules: input.facts.projectMapModules,
    projectRoot: input.facts.projectRoot,
    scopeMembers,
  });
  const scopedModules = filterModulesByScope({
    modules: decoratedModules,
    projectRoot: input.facts.projectRoot,
    scopeMembers,
  });
  const scopedCoverageCells = filterCoverageCellsByScope({
    cells: input.coverageLedgerCells,
    projectRoot: input.facts.projectRoot,
    scopeMembers,
  });
  const moduleIdAlignment = {
    directAligned: hasDirectModuleIdAlignment(scopedModules, scopedCoverageCells),
    source: 'runtime-check' as const,
  };
  const recipeCountContract = buildPanoramaModuleRecipeCountContract({
    coverageLedgerCells: input.coverageLedgerCells,
    moduleIdAlignment,
    projectMapModules: decoratedModules.map(toRecipeCountModuleInput),
    projectRoot: input.facts.projectRoot,
    scope:
      scopeMembers.length > 0
        ? {
            controlRoot: input.analysisScope.controlRoot,
            memberRoots: scopeMembers.map((member) => member.path),
          }
        : undefined,
    totalRecipes: input.totalRecipes,
  });
  const moduleRoles = scopedModules
    .filter((module) => isTargetScopedCoverageModuleId(module.moduleId))
    .map((module) => ({
      moduleId: module.moduleId,
      roles: uniqueStrings([module.role, module.kind].filter(isNonEmptyString)),
    }))
    .filter((entry) => entry.roles.length > 0);
  const rollup = buildCoverageLedgerPanoramaRollup({
    cells: scopedCoverageCells,
    moduleRoles,
  });
  const healthRadar = buildHealthRadarView({
    dimensionCoverage: rollup.dimensionCoverage,
    healthRadar: rollup.healthRadar,
    totalRecipes: input.totalRecipes,
  });
  const gaps = rollup.gaps.map((gap) =>
    buildKnowledgeGap(gap, rollup.dimensionCoverage, healthRadar.dimensions)
  );
  const cycleCount = resolveCycleCount(input.facts.presenterInput);
  const avgCoupling = resolveAverageCoupling(input.facts.presenterInput, scopedModules.length);
  const highPriorityGaps = gaps.filter((gap) => gap.priority === 'high').length;
  const healthScore = resolveHealthScore({
    avgCoupling,
    cycleCount,
    highPriorityGaps,
    overallScore: healthRadar.overallScore,
  });
  const layers = buildArchitectureLayers(scopedModules, recipeCountContract);
  const overview: PanoramaOverview = {
    computedAt: input.computedAt ?? Date.now(),
    cycleCount,
    dimensionCoverage: healthRadar.dimensionCoverage,
    gapCount: gaps.length,
    healthRadar,
    layerCount: layers.length,
    layers,
    moduleCount: scopedModules.length,
    overallCoverage: healthRadar.overallScore,
    projectRoot,
    projectScope: {
      controlRoot: input.analysisScope.controlRoot,
      excludedCoverageCellCount: recipeCountContract.scopeBoundary.excludedCoverageCellCount,
      excludedModuleCount: recipeCountContract.scopeBoundary.excludedModuleCount,
      memberRoots: recipeCountContract.scopeBoundary.memberRoots,
      mode: recipeCountContract.scopeBoundary.mode,
      projectRoot,
      projectScopeId: input.analysisScope.projectScopeId,
    },
    recipeCount: {
      mode: recipeCountContract.mode,
      projectRecipeCount: recipeCountContract.projectRecipeCount,
      reason: recipeCountContract.reason,
    },
    stale: false,
    totalFiles: nonNegativeInteger(input.facts.fileCount),
    totalRecipes: nonNegativeInteger(input.totalRecipes),
  };
  return {
    diagnostics: {
      directModuleIdAligned: moduleIdAlignment.directAligned,
      recipeCountReason: recipeCountContract.reason,
      rollupBasis: rollup.basis,
    },
    gaps,
    health: {
      avgCoupling,
      cycleCount,
      gapCount: gaps.length,
      healthRadar,
      healthScore,
      highPriorityGaps,
      moduleCount: scopedModules.length,
    },
    overview,
  };
}

export function resolvePanoramaCoverageProjectRoots(
  analysisScope: ProjectScopeAnalysisContext
): string[] {
  const members = resolveScopeMembers(analysisScope);
  if (members.length > 0) {
    return members.map((member) => member.path);
  }
  return [resolve(analysisScope.projectRoot)];
}

function decorateProjectMapModules(input: {
  modules: readonly ProjectContextModule[];
  projectRoot: string;
  scopeMembers: readonly ScopeMember[];
}): DecoratedModule[] {
  const decorated = input.modules.flatMap((module) => {
    const normalized = normalizeModuleForPanorama({
      module,
      projectRoot: input.projectRoot,
      scopeMembers: input.scopeMembers,
    });
    return normalized ? [normalized] : [];
  });
  return dedupeModules(decorated);
}

function filterModulesByScope(input: {
  modules: readonly DecoratedModule[];
  projectRoot: string;
  scopeMembers: readonly ScopeMember[];
}): DecoratedModule[] {
  const roots =
    input.scopeMembers.length > 0
      ? input.scopeMembers.map((member) => member.path)
      : [resolve(input.projectRoot)];
  return input.modules.filter((module) => {
    if (!module.projectRoot) {
      return input.scopeMembers.length === 0;
    }
    return roots.some((root) => isPathWithinOrEqual(module.projectRoot ?? '', root));
  });
}

function normalizeModuleForPanorama(input: {
  module: ProjectContextModule;
  projectRoot: string;
  scopeMembers: readonly ScopeMember[];
}): DecoratedModule | null {
  const moduleName = input.module.moduleName?.trim();
  if (!moduleName) {
    return null;
  }
  const projectRoot = resolveModuleProjectRoot(input.module, input.projectRoot, input.scopeMembers);
  const moduleId =
    buildCanonicalCoverageLedgerModuleId({
      moduleId: input.module.moduleId,
      moduleName,
      modulePath: input.module.modulePath,
      projectRoot,
    }) ?? input.module.moduleId;
  if (!moduleId?.trim()) {
    return null;
  }
  return {
    ...input.module,
    moduleId,
    moduleName,
    ...(projectRoot ? { projectRoot } : {}),
  };
}

function resolveModuleProjectRoot(
  module: ProjectContextModule,
  fallbackProjectRoot: string,
  scopeMembers: readonly ScopeMember[]
): string | undefined {
  if (scopeMembers.length === 0) {
    return fallbackProjectRoot;
  }
  const explicitProjectRoot = readModuleProjectRoot(module);
  if (
    explicitProjectRoot &&
    scopeMembers.some((member) => isPathWithinOrEqual(explicitProjectRoot, member.path))
  ) {
    return explicitProjectRoot;
  }
  const paths = [module.modulePath, ...(module.ownedFiles ?? [])]
    .filter(isNonEmptyString)
    .map(normalizeSourcePath)
    .filter(isNonEmptyString);
  const member = scopeMembers.find((candidate) =>
    paths.some(
      (pathValue) =>
        pathValue === candidate.relativeRoot || pathValue.startsWith(`${candidate.relativeRoot}/`)
    )
  );
  return member?.path;
}

function toRecipeCountModuleInput(module: DecoratedModule): PanoramaProjectMapModuleInput {
  return {
    moduleId: module.moduleId,
    moduleName: module.moduleName,
    ...(module.modulePath ? { modulePath: module.modulePath } : {}),
    ...(module.projectRoot ? { projectRoot: module.projectRoot } : {}),
  };
}

function filterCoverageCellsByScope(input: {
  cells: readonly CoverageLedgerRecord[];
  projectRoot: string;
  scopeMembers: readonly ScopeMember[];
}): CoverageLedgerRecord[] {
  const roots =
    input.scopeMembers.length > 0
      ? input.scopeMembers.map((member) => member.path)
      : [resolve(input.projectRoot)];
  return input.cells.filter((cell) =>
    roots.some((root) => isPathWithinOrEqual(cell.projectRoot, root))
  );
}

function hasDirectModuleIdAlignment(
  modules: readonly DecoratedModule[],
  cells: readonly CoverageLedgerRecord[]
): boolean {
  if (modules.length === 0) {
    return false;
  }
  const moduleIds = new Set(modules.map((module) => module.moduleId));
  return (
    modules.every((module) => isTargetScopedCoverageModuleId(module.moduleId)) &&
    cells.every((cell) => moduleIds.has(cell.moduleId))
  );
}

function buildHealthRadarView(input: {
  dimensionCoverage: readonly CoverageLedgerPanoramaDimensionCoverage[];
  healthRadar: CoverageLedgerPanoramaHealthRadar;
  totalRecipes: number;
}): PanoramaHealthRadarView {
  const dimensions = input.dimensionCoverage.map((dimension) => ({
    cellCount: dimension.cellCount,
    coveredCellCount: dimension.coveredCellCount,
    coveredCandidateCount: dimension.coveredCandidateCount,
    description: dimension.label,
    id: dimension.id,
    level: dimension.status,
    missingCellCount: dimension.missingCellCount,
    name: dimension.label,
    partialCellCount: dimension.partialCellCount,
    recipeCount: dimension.coveredCandidateCount,
    score: dimension.score,
    status: dimension.status,
    topRecipes: [],
    totalCandidateCount: dimension.totalCandidateCount,
    weakCellCount: dimension.weakCellCount,
  }));
  const coveredDimensions = dimensions.filter(
    (dimension) => dimension.status === 'strong' || dimension.status === 'adequate'
  ).length;
  return {
    basis: input.healthRadar.basis,
    coveredDimensions,
    dimensionCoverage:
      dimensions.length > 0 ? Math.round((coveredDimensions / dimensions.length) * 100) : 0,
    dimensions,
    overallScore: input.healthRadar.score,
    totalDimensions: dimensions.length,
    totalRecipes: nonNegativeInteger(input.totalRecipes),
  };
}

function buildKnowledgeGap(
  gap: CoverageLedgerPanoramaGap,
  dimensionCoverage: readonly CoverageLedgerPanoramaDimensionCoverage[],
  healthDimensions: readonly PanoramaHealthRadarDimension[]
): PanoramaKnowledgeGap {
  const coverage = dimensionCoverage.find((dimension) => dimension.id === gap.dimensionId);
  const health = healthDimensions.find((dimension) => dimension.id === gap.dimensionId);
  return {
    affectedModuleIds: [...gap.affectedModuleIds],
    affectedRoles: [...gap.affectedRoles],
    dimension: gap.dimensionId,
    dimensionName: gap.dimensionName,
    missingCellCount: gap.missingCellCount,
    priority: gap.priority,
    recipeCount: coverage?.coveredCandidateCount ?? health?.recipeCount ?? 0,
    status: gap.status,
    suggestedTopics: [...gap.suggestedTopics],
    valueScore: gap.valueScore,
    weakCellCount: gap.weakCellCount,
  };
}

function buildArchitectureLayers(
  modules: readonly DecoratedModule[],
  recipeCountContract: PanoramaModuleRecipeCountContract
): PanoramaArchitectureLayer[] {
  const recipeCountsByModuleId = new Map(
    recipeCountContract.moduleRecipeCounts.map((module) => [module.moduleId, module])
  );
  const groups = new Map<string, PanoramaLayerModule[]>();
  for (const module of modules) {
    const role = module.role ?? module.kind ?? 'module';
    const recipeCount = recipeCountsByModuleId.get(module.moduleId);
    const group = groups.get(role) ?? [];
    group.push({
      fileCount: nonNegativeInteger(module.ownedFileCount ?? module.ownedFiles?.length ?? 0),
      moduleId: module.moduleId,
      ...(module.modulePath ? { modulePath: module.modulePath } : {}),
      name: module.moduleName,
      ...(module.projectRoot ? { projectRoot: module.projectRoot } : {}),
      recipeCount: recipeCount?.recipeCount ?? null,
      recipeCountSource: recipeCount?.recipeCountSource ?? 'degraded-project-total',
      role,
    });
    groups.set(role, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, group], index) => ({
      level: index + 1,
      modules: group.sort((left, right) => left.name.localeCompare(right.name)),
      name,
    }));
}

function resolvePanoramaProjectRoot(input: BuildPanoramaEndpointViewInput): string {
  return (
    input.analysisScope.controlRoot ?? input.analysisScope.projectRoot ?? input.facts.projectRoot
  );
}

function resolveScopeMembers(analysisScope: ProjectScopeAnalysisContext): ScopeMember[] {
  const controlRoot = analysisScope.controlRoot;
  const folders = analysisScope.projectScope?.folders ?? [];
  if (!controlRoot || folders.length === 0) {
    return [];
  }
  return folders.flatMap((folder) => {
    const relativeRoot = normalizeSourcePath(relative(controlRoot, folder.path));
    if (!relativeRoot) {
      return [];
    }
    return [
      {
        displayName: folder.displayName || relativeRoot,
        path: resolve(folder.path),
        relativeRoot,
        role: folder.role || null,
      },
    ];
  });
}

function resolveCycleCount(presenterInput: unknown): number {
  const map = readRecord(readRecord(presenterInput)?.map);
  const cycles = map?.cycles;
  if (Array.isArray(cycles)) {
    return cycles.length;
  }
  const cycleCount = readNumber(map?.cycleCount);
  return nonNegativeInteger(cycleCount ?? 0);
}

function resolveAverageCoupling(presenterInput: unknown, moduleCount: number): number {
  const map = readRecord(readRecord(presenterInput)?.map);
  const summary = readRecord(map?.dependencySummary);
  const explicit = readNumber(summary?.avgCoupling ?? summary?.averageCoupling ?? map?.avgCoupling);
  if (explicit !== null) {
    return roundOneDecimal(Math.max(0, explicit));
  }
  const edgeCount = readNumber(summary?.edgeCount ?? map?.edgeCount);
  if (edgeCount === null || moduleCount <= 0) {
    return 0;
  }
  return roundOneDecimal(edgeCount / Math.max(1, moduleCount));
}

function resolveHealthScore(input: {
  avgCoupling: number;
  cycleCount: number;
  highPriorityGaps: number;
  overallScore: number;
}): number {
  const cycleScore = input.cycleCount === 0 ? 20 : Math.max(0, 20 - input.cycleCount * 5);
  const highGapScore = input.highPriorityGaps === 0 ? 10 : 0;
  const couplingScore = input.avgCoupling < 10 ? 10 : 0;
  return clampScore(
    Math.round(input.overallScore * 0.6 + cycleScore + highGapScore + couplingScore)
  );
}

function isPathWithinOrEqual(candidate: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') &&
      !relativePath.split(sep).includes('..') &&
      !isAbsolute(relativePath))
  );
}

function normalizeSourcePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function dedupeModules(modules: readonly DecoratedModule[]): DecoratedModule[] {
  const byId = new Map<string, DecoratedModule>();
  for (const module of modules) {
    if (!byId.has(module.moduleId)) {
      byId.set(module.moduleId, module);
    }
  }
  return [...byId.values()].sort((left, right) => left.moduleId.localeCompare(right.moduleId));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readModuleProjectRoot(module: ProjectContextModule): string | null {
  const value = readRecord(module)?.projectRoot;
  return isNonEmptyString(value) ? value : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 100) {
    return 100;
  }
  return value;
}
