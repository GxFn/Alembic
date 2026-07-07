import { COUNTABLE_LIFECYCLES } from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import type { CoverageLedgerRecord } from '@alembic/core/repositories';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { buildPanoramaEndpointFacts } from '../../project-facts/PanoramaEndpointFacts.js';
import {
  buildPanoramaEndpointView,
  type PanoramaEndpointView,
  resolvePanoramaCoverageProjectRoots,
} from '../../project-facts/PanoramaEndpointView.js';
import {
  type ProjectScopeAnalysisContext,
  resolveProjectScopeAnalysisContext,
} from '../../project-scope/ProjectScopeAnalysis.js';
import { validateQuery } from '../middleware/validate.js';

const router = express.Router();
const logger = Logger.getInstance();

const PanoramaQuery = z.object({
  refresh: z
    .preprocess((value) => value === true || value === 'true' || value === '1', z.boolean())
    .default(false),
});

interface ContainerLike {
  get(name: string): unknown;
}

interface CoverageLedgerRepositoryLike {
  listByProjectRoot(projectRoot: string): CoverageLedgerRecord[];
}

interface KnowledgeRepositoryLike {
  countByLifecycles(lifecycles: readonly string[]): number | Promise<number>;
}

interface PanoramaViewCacheEntry {
  expiresAt: number;
  key: string;
  view: PanoramaEndpointView;
}

interface PanoramaViewInflightEntry {
  key: string;
  promise: Promise<PanoramaEndpointView>;
}

const PANORAMA_VIEW_CACHE_TTL_MS = 15_000;
const PANORAMA_ENDPOINT_MAX_FILES = 800;

let panoramaViewCache: PanoramaViewCacheEntry | null = null;
let panoramaViewInflight: PanoramaViewInflightEntry | null = null;

router.get(
  '/',
  validateQuery(PanoramaQuery),
  async (req: Request, res: Response): Promise<void> => {
    const view = await loadPanoramaView(Boolean(req.query.refresh));
    res.json({ success: true, data: view.overview });
  }
);

router.get(
  '/health',
  validateQuery(PanoramaQuery),
  async (req: Request, res: Response): Promise<void> => {
    const view = await loadPanoramaView(Boolean(req.query.refresh));
    res.json({ success: true, data: view.health });
  }
);

router.get(
  '/gaps',
  validateQuery(PanoramaQuery),
  async (req: Request, res: Response): Promise<void> => {
    const view = await loadPanoramaView(Boolean(req.query.refresh));
    res.json({ success: true, data: view.gaps });
  }
);

async function loadPanoramaView(refresh: boolean) {
  try {
    const container = getServiceContainer();
    const analysisScope = resolveProjectScopeAnalysisContext(container);
    const projectRoot = analysisScope.projectScope
      ? (analysisScope.controlRoot ?? analysisScope.projectRoot)
      : analysisScope.projectRoot;
    const cacheKey = buildPanoramaViewCacheKey(analysisScope);
    const now = Date.now();
    if (!refresh && panoramaViewCache?.key === cacheKey && panoramaViewCache.expiresAt > now) {
      return panoramaViewCache.view;
    }
    if (!refresh && panoramaViewInflight?.key === cacheKey) {
      return await panoramaViewInflight.promise;
    }
    if (refresh) {
      logger.info('[panorama] refresh query accepted; rebuilding endpoint projection', {
        projectRoot,
        projectScopeId: analysisScope.projectScopeId,
      });
    }
    const promise = buildPanoramaView({ analysisScope, container, projectRoot });
    panoramaViewInflight = { key: cacheKey, promise };
    try {
      const view = await promise;
      panoramaViewCache = {
        expiresAt: Date.now() + PANORAMA_VIEW_CACHE_TTL_MS,
        key: cacheKey,
        view,
      };
      return view;
    } finally {
      if (panoramaViewInflight?.promise === promise) {
        panoramaViewInflight = null;
      }
    }
  } catch (error: unknown) {
    logger.error('[panorama] failed to build endpoint view', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function buildPanoramaView(input: {
  analysisScope: ProjectScopeAnalysisContext;
  container: ContainerLike;
  projectRoot: string;
}): Promise<PanoramaEndpointView> {
  const coverageLedgerCells = loadCoverageLedgerCells(
    input.container,
    resolvePanoramaCoverageProjectRoots(input.analysisScope)
  );
  const [facts, totalRecipes] = await Promise.all([
    buildPanoramaEndpointFacts({
      analysisScope: input.analysisScope,
      maxFiles: PANORAMA_ENDPOINT_MAX_FILES,
    }),
    countTotalRecipes(input.container),
  ]);
  const view = buildPanoramaEndpointView({
    analysisScope: input.analysisScope,
    coverageLedgerCells,
    facts,
    totalRecipes,
  });
  if (!view.diagnostics.directModuleIdAligned) {
    logger.info('[panorama] module recipe counts degraded to project total', {
      projectRoot: input.projectRoot,
      projectScopeId: input.analysisScope.projectScopeId,
      recipeCountReason: view.diagnostics.recipeCountReason,
    });
  }
  return view;
}

function loadCoverageLedgerCells(
  container: ContainerLike,
  projectRoots: readonly string[]
): CoverageLedgerRecord[] {
  const repository = getCoverageLedgerRepository(container);
  if (!repository) {
    logger.warn('[panorama] coverageLedgerRepository unavailable; returning empty coverage view');
    return [];
  }
  const cells: CoverageLedgerRecord[] = [];
  for (const projectRoot of uniqueStrings(projectRoots)) {
    try {
      cells.push(...repository.listByProjectRoot(projectRoot));
    } catch (error: unknown) {
      logger.warn('[panorama] coverage ledger read failed for project root', {
        error: error instanceof Error ? error.message : String(error),
        projectRoot,
      });
    }
  }
  return cells;
}

function getCoverageLedgerRepository(
  container: ContainerLike
): CoverageLedgerRepositoryLike | null {
  const candidate = safeGet(container, 'coverageLedgerRepository');
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as { listByProjectRoot?: unknown }).listByProjectRoot === 'function'
  ) {
    return candidate as CoverageLedgerRepositoryLike;
  }
  return null;
}

async function countTotalRecipes(container: ContainerLike): Promise<number> {
  const candidate = safeGet(container, 'knowledgeRepository');
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as { countByLifecycles?: unknown }).countByLifecycles === 'function'
  ) {
    try {
      const count = await (candidate as KnowledgeRepositoryLike).countByLifecycles(
        COUNTABLE_LIFECYCLES
      );
      return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    } catch (error: unknown) {
      logger.warn('[panorama] knowledge recipe count failed; using zero total', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return 0;
}

function safeGet(container: ContainerLike, name: string): unknown {
  try {
    return container.get(name);
  } catch {
    return null;
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function buildPanoramaViewCacheKey(analysisScope: ProjectScopeAnalysisContext): string {
  const memberRoots = resolvePanoramaCoverageProjectRoots(analysisScope).sort();
  return JSON.stringify({
    controlRoot: analysisScope.controlRoot,
    members: memberRoots,
    projectRoot: analysisScope.projectRoot,
    projectScopeId: analysisScope.projectScopeId,
  });
}

export function clearPanoramaViewCacheForTests(): void {
  panoramaViewCache = null;
  panoramaViewInflight = null;
}

export default router;
