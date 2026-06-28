import { buildCanonicalCoverageLedgerModuleId } from '@alembic/core/host-agent-workflows';

export interface ModuleMiningSelectedModulePayload {
  dimensionIds: string[];
  dimensions: string[];
  moduleId: string;
  moduleName: string;
  modulePath?: string;
  ownedFiles?: string[];
  plannedDimensionTargets?: Record<string, number>;
  plannedDimensions: string[];
  targetRecipes?: number;
}

export interface ModuleMiningSourceRefSnapshot {
  recipeIds: Set<string>;
  sourceRefs: ModuleMiningSourceRefRecord[];
}

export interface ModuleMiningSourceRefDelta {
  recipeIds: string[];
  sourceRefCount: number;
  sourceRefPaths: string[];
}

export interface ModuleMiningCoverageLedgerSummary {
  cells: ModuleMiningCoverageLedgerCellSummary[];
  dimensionIds: string[];
  measuredCells: number;
  reason?: string;
  selectedModuleCount: number;
  sourceRefCount: number;
  sourceRefPaths: string[];
  status: 'skipped' | 'written';
  writtenCells: number;
}

export interface ModuleMiningCoverageLedgerCellSummary {
  coveredCount: number;
  coveredSourceRefs: string[];
  dimensionId: string;
  grade: 'covered' | 'empty' | 'partial' | 'thin';
  moduleId: string;
  moduleName: string;
  totalCandidateCount: number;
}

interface ModuleMiningSourceRefRepositoryLike {
  findAll?(): readonly unknown[];
}

interface ModuleMiningModuleLike {
  [key: string]: unknown;
  dimensionIds?: string[];
  dimensions?: string[];
  moduleId: string;
  moduleName: string;
  modulePath?: string;
  ownedFiles?: string[];
  plannedDimensionTargets?: Record<string, number>;
  plannedDimensions?: string[];
  targetRecipes?: number;
}

interface ModuleMiningServiceContainerLike {
  get(name: string): unknown;
}

interface ModuleMiningLoggerLike {
  info?(message: string, meta?: Record<string, unknown>): void;
}

interface ModuleMiningSourceRefRecord {
  recipeId: string;
  sourcePath: string;
}

interface CoverageLedgerCellLike {
  coveredCount?: number;
  coveredSourceRefs?: readonly string[];
  grade?: string;
  totalCandidateCount?: number;
}

interface CoverageLedgerRoundLike {
  roundIndex?: unknown;
}

interface ModuleMiningCoverageLedgerRepositoryLike {
  getCell(scope: {
    dimensionId: string;
    moduleId: string;
    projectRoot: string;
  }): CoverageLedgerCellLike | null;
  listRoundsByProjectRoot?(projectRoot: string): readonly CoverageLedgerRoundLike[];
  upsertCell(input: Record<string, unknown>): unknown;
}

export function toModuleMiningSelectedModulePayloads(
  modules: readonly ModuleMiningModuleLike[],
  options: { projectRoot?: string } = {}
): ModuleMiningSelectedModulePayload[] {
  return modules.flatMap((module): ModuleMiningSelectedModulePayload[] => {
    const record = module as Record<string, unknown>;
    const moduleId = buildCanonicalCoverageLedgerModuleId({
      moduleId: module.moduleId,
      moduleName: module.moduleName,
      modulePath: module.modulePath,
      projectRoot: options.projectRoot,
    });
    if (!moduleId) {
      return [];
    }
    const plannedDimensions = moduleDimensionIds(record.plannedDimensions, module);
    const dimensions = moduleDimensionIds(record.dimensions, module, plannedDimensions);
    const dimensionIds = moduleDimensionIds(record.dimensionIds, module, dimensions);
    const payload: ModuleMiningSelectedModulePayload = {
      dimensionIds,
      dimensions,
      moduleId,
      moduleName: module.moduleName,
      plannedDimensions,
    };
    if (typeof module.modulePath === 'string' && module.modulePath.trim().length > 0) {
      payload.modulePath = module.modulePath;
    }
    const ownedFiles = stringArray(record.ownedFiles);
    if (ownedFiles.length > 0) {
      payload.ownedFiles = ownedFiles;
    }
    const plannedDimensionTargets = numberRecord(record.plannedDimensionTargets);
    if (Object.keys(plannedDimensionTargets).length > 0) {
      payload.plannedDimensionTargets = plannedDimensionTargets;
    }
    const targetRecipes = positiveNumber(record.targetRecipes);
    if (targetRecipes !== null) {
      payload.targetRecipes = targetRecipes;
    }
    return [payload];
  });
}

export function readModuleMiningSourceRefSnapshot(
  container: ModuleMiningServiceContainerLike
): ModuleMiningSourceRefSnapshot | null {
  const repository = getOptionalService<ModuleMiningSourceRefRepositoryLike>(
    container,
    'recipeSourceRefRepository'
  );
  if (!repository || typeof repository.findAll !== 'function') {
    return null;
  }

  const sourceRefs = normalizeSourceRefs(repository.findAll());
  return {
    recipeIds: new Set(sourceRefs.map((ref) => ref.recipeId)),
    sourceRefs,
  };
}

export function readModuleMiningSourceRefDelta(
  container: ModuleMiningServiceContainerLike,
  before: ModuleMiningSourceRefSnapshot | null
): ModuleMiningSourceRefDelta {
  const after = readModuleMiningSourceRefSnapshot(container);
  if (!before || !after) {
    return { recipeIds: [], sourceRefCount: 0, sourceRefPaths: [] };
  }

  const beforeKeys = new Set(
    before.sourceRefs.map((ref) => sourceRefKey(ref.recipeId, ref.sourcePath))
  );
  const newSourceRefs = after.sourceRefs.filter(
    (ref) => !beforeKeys.has(sourceRefKey(ref.recipeId, ref.sourcePath))
  );
  return {
    recipeIds: uniqueStrings(newSourceRefs.map((ref) => ref.recipeId)).sort(),
    sourceRefCount: newSourceRefs.length,
    sourceRefPaths: uniqueStrings(newSourceRefs.map((ref) => ref.sourcePath)).sort(),
  };
}

export function writeModuleMiningCoverageLedger(input: {
  container: ModuleMiningServiceContainerLike;
  logger: ModuleMiningLoggerLike;
  projectRoot: string;
  selectedModules: readonly ModuleMiningModuleLike[];
  sourceRefPaths: readonly string[];
}): ModuleMiningCoverageLedgerSummary {
  const selectedModules = toModuleMiningSelectedModulePayloads(input.selectedModules, {
    projectRoot: input.projectRoot,
  });
  const sourceRefPaths = uniqueStrings(input.sourceRefPaths.map(stripSourceRefLineAnchor)).sort();
  const skippedBase = {
    cells: [],
    dimensionIds: uniqueStrings(selectedModules.flatMap((module) => module.plannedDimensions)),
    measuredCells: 0,
    selectedModuleCount: selectedModules.length,
    sourceRefCount: sourceRefPaths.length,
    sourceRefPaths,
    status: 'skipped' as const,
    writtenCells: 0,
  };
  if (selectedModules.length === 0) {
    return { ...skippedBase, reason: 'no-selected-modules' };
  }
  if (sourceRefPaths.length === 0) {
    return { ...skippedBase, reason: 'no-source-refs' };
  }
  if (!input.projectRoot.trim()) {
    return { ...skippedBase, reason: 'missing-project-root' };
  }

  const repository = getCoverageLedgerRepository(input.container);
  if (!repository) {
    return { ...skippedBase, reason: 'repository-unavailable' };
  }

  const latestRound = latestCoverageLedgerRoundIndex(repository, input.projectRoot);
  const cells: ModuleMiningCoverageLedgerCellSummary[] = [];
  for (const module of selectedModules) {
    const dimensions =
      module.plannedDimensions.length > 0 ? module.plannedDimensions : module.dimensions;
    const matchedSourceRefs = sourceRefPathsForModule({
      module,
      selectedModuleCount: selectedModules.length,
      sourceRefPaths,
    });
    if (matchedSourceRefs.length === 0) {
      continue;
    }
    for (const dimensionId of dimensions) {
      const existing = repository.getCell({
        dimensionId,
        moduleId: module.moduleId,
        projectRoot: input.projectRoot,
      });
      const coveredSourceRefs = uniqueStrings([
        ...(existing?.coveredSourceRefs ?? []),
        ...matchedSourceRefs,
      ]).sort();
      const totalCandidateCount = Math.max(
        positiveNumber(module.plannedDimensionTargets?.[dimensionId]) ??
          positiveNumber(module.targetRecipes) ??
          1,
        positiveNumber(existing?.totalCandidateCount) ?? 0,
        coveredSourceRefs.length
      );
      const coveredCount = Math.max(
        positiveNumber(existing?.coveredCount) ?? 0,
        coveredSourceRefs.length
      );
      const grade = coverageGrade(coveredCount, totalCandidateCount);
      repository.upsertCell({
        coveredCount,
        coveredSourceRefs,
        deferred: false,
        dimensionId,
        exhausted: false,
        grade,
        ...(latestRound !== null ? { lastRound: latestRound } : {}),
        moduleId: module.moduleId,
        projectRoot: input.projectRoot,
        totalCandidateCount,
        valueScore: Math.min(100, 50 + coveredCount * 10),
      });
      cells.push({
        coveredCount,
        coveredSourceRefs,
        dimensionId,
        grade,
        moduleId: module.moduleId,
        moduleName: module.moduleName,
        totalCandidateCount,
      });
    }
  }

  const summary: ModuleMiningCoverageLedgerSummary =
    cells.length > 0
      ? {
          cells,
          dimensionIds: uniqueStrings(cells.map((cell) => cell.dimensionId)).sort(),
          measuredCells: cells.filter((cell) => cell.coveredCount > 0).length,
          selectedModuleCount: selectedModules.length,
          sourceRefCount: sourceRefPaths.length,
          sourceRefPaths,
          status: 'written',
          writtenCells: cells.length,
        }
      : {
          ...skippedBase,
          reason: 'no-matching-source-refs',
        };
  input.logger.info?.('ModuleMining coverage ledger evidence recorded', {
    coverageLedger: summary,
    stage: 'module-mining-coverage-ledger',
  });
  return summary;
}

function getCoverageLedgerRepository(
  container: ModuleMiningServiceContainerLike
): ModuleMiningCoverageLedgerRepositoryLike | null {
  const repository = getOptionalService<ModuleMiningCoverageLedgerRepositoryLike>(
    container,
    'coverageLedgerRepository'
  );
  if (
    repository &&
    typeof repository.getCell === 'function' &&
    typeof repository.upsertCell === 'function'
  ) {
    return repository;
  }
  return null;
}

function getOptionalService<T>(
  container: ModuleMiningServiceContainerLike,
  name: string
): T | null {
  try {
    return container.get(name) as T;
  } catch {
    return null;
  }
}

function latestCoverageLedgerRoundIndex(
  repository: ModuleMiningCoverageLedgerRepositoryLike,
  projectRoot: string
): number | null {
  if (typeof repository.listRoundsByProjectRoot !== 'function') {
    return null;
  }
  return repository.listRoundsByProjectRoot(projectRoot).reduce<number | null>((latest, round) => {
    const roundIndex = positiveNumber(round.roundIndex);
    if (roundIndex === null) {
      return latest;
    }
    return latest === null || roundIndex > latest ? roundIndex : latest;
  }, null);
}

function normalizeSourceRefs(sourceRefs: readonly unknown[]): ModuleMiningSourceRefRecord[] {
  return sourceRefs.flatMap((ref) => {
    const record = isRecord(ref) ? ref : {};
    const recipeId = stringValue(record.recipeId) ?? stringValue(record.recipe_id);
    const rawSourcePath = stringValue(record.sourcePath) ?? stringValue(record.source_path);
    const status = stringValue(record.status) ?? 'active';
    const sourcePath = rawSourcePath ? stripSourceRefLineAnchor(rawSourcePath) : undefined;
    if (!recipeId || !sourcePath || status === 'stale') {
      return [];
    }
    return [{ recipeId, sourcePath }];
  });
}

function sourceRefPathsForModule(input: {
  module: ModuleMiningSelectedModulePayload;
  selectedModuleCount: number;
  sourceRefPaths: readonly string[];
}): string[] {
  const matched = input.sourceRefPaths.filter((sourcePath) =>
    sourcePathMatchesModule(sourcePath, input.module)
  );
  if (matched.length > 0) {
    return matched;
  }
  return input.selectedModuleCount === 1 ? [...input.sourceRefPaths] : [];
}

function sourcePathMatchesModule(
  sourcePath: string,
  module: ModuleMiningSelectedModulePayload
): boolean {
  const normalizedSourcePath = normalizePathLike(sourcePath);
  if (!normalizedSourcePath) {
    return false;
  }
  const candidatePaths = uniqueStrings([
    module.modulePath ?? '',
    ...structuredModulePathAliases(module.moduleId),
    ...(module.ownedFiles ?? []),
  ])
    .map(normalizePathLike)
    .filter((value): value is string => Boolean(value));
  return candidatePaths.some(
    (candidate) =>
      normalizedSourcePath === candidate ||
      normalizedSourcePath.startsWith(`${candidate}/`) ||
      normalizedSourcePath.endsWith(`/${candidate}`)
  );
}

function structuredModulePathAliases(moduleId: string): string[] {
  const parts = moduleId
    .split(':')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 2 ? [parts.slice(2).join(':')] : [];
}

function moduleDimensionIds(
  value: unknown,
  module: ModuleMiningModuleLike,
  fallback: readonly string[] = []
): string[] {
  const values = stringArray(value);
  if (values.length > 0) {
    return values;
  }
  if (fallback.length > 0) {
    return [...fallback];
  }
  return uniqueStrings([
    ...(module.plannedDimensions ?? []),
    ...(module.dimensionIds ?? []),
    ...(module.dimensions ?? []),
  ]);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? uniqueStrings(value.map((item) => (typeof item === 'string' ? item : '')))
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, raw]) => {
      const normalizedKey = key.trim();
      const numericValue = positiveNumber(raw);
      return normalizedKey && numericValue !== null ? [[normalizedKey, numericValue]] : [];
    })
  );
}

function coverageGrade(
  coveredCount: number,
  totalCandidateCount: number
): ModuleMiningCoverageLedgerCellSummary['grade'] {
  if (coveredCount <= 0) {
    return 'empty';
  }
  return coveredCount >= totalCandidateCount ? 'covered' : 'partial';
}

function positiveNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

function sourceRefKey(recipeId: string, sourcePath: string): string {
  return `${recipeId}\u0000${sourcePath}`;
}

function stripSourceRefLineAnchor(sourceRef: string): string {
  return sourceRef
    .trim()
    .replace(/:\d+(?:-\d+)?$/, '')
    .replace(/#L\d+(?:-L?\d+)?$/i, '');
}

function normalizePathLike(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/u, '');
  return normalized.length > 0 ? normalized : null;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
