import { COUNTABLE_LIFECYCLES } from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import type { CoverageLedgerRecord } from '@alembic/core/repositories';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import {
  buildPanoramaEndpointView,
  resolvePanoramaCoverageProjectRoots,
} from '../../project-facts/PanoramaEndpointView.js';
import { buildProjectContextWorkflowFacts } from '../../project-facts/ProjectContextWorkflowFacts.js';
import { resolveProjectScopeAnalysisContext } from '../../project-scope/ProjectScopeAnalysis.js';
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
    if (refresh) {
      logger.info('[panorama] refresh query accepted; rebuilding endpoint projection', {
        projectRoot,
        projectScopeId: analysisScope.projectScopeId,
      });
    }
    const facts = await buildProjectContextWorkflowFacts({
      analysisScope,
      ctx: { container, logger },
      maxFileDetails: 0,
      maxFiles: 2000,
      maxModuleDetails: 0,
      maxModuleSeeds: 12,
      projectRoot,
      source: 'alembic-main-bootstrap',
    });
    const coverageLedgerCells = loadCoverageLedgerCells(
      container,
      resolvePanoramaCoverageProjectRoots(analysisScope)
    );
    const totalRecipes = await countTotalRecipes(container);
    const view = buildPanoramaEndpointView({
      analysisScope,
      coverageLedgerCells,
      facts,
      totalRecipes,
    });
    if (!view.diagnostics.directModuleIdAligned) {
      logger.info('[panorama] module recipe counts degraded to project total', {
        projectRoot,
        projectScopeId: analysisScope.projectScopeId,
        recipeCountReason: view.diagnostics.recipeCountReason,
      });
    }
    return view;
  } catch (error: unknown) {
    logger.error('[panorama] failed to build endpoint view', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
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

export default router;
