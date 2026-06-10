import { isProjectRuntimeTarget } from '@alembic/core/daemon';
import express, { type Request, type Response } from 'express';
import { DaemonSupervisor } from '../../daemon/DaemonSupervisor.js';
import {
  ProjectRuntimeControl,
  type ProjectRuntimeControlActionResult,
  type ProjectRuntimeControlOptions,
  type ProjectRuntimeControlSnapshot,
  type ProjectRuntimeHandoff,
  type ProjectRuntimeScopeSummary,
  type ProjectRuntimeTarget,
} from '../../daemon/ProjectRuntimeControl.js';
import {
  type AlembicHttpProblem,
  type AlembicHttpProblemReason,
  buildAlembicHttpProblem,
} from '../problem-taxonomy.js';

const router = express.Router();

type ProjectRuntimeProblemReason = Extract<
  AlembicHttpProblemReason,
  | 'cancelled'
  | 'conflict'
  | 'internal-error'
  | 'invalid-input'
  | 'not-found'
  | 'permission-denied'
  | 'timeout'
  | 'unavailable'
>;

type ProjectRuntimeProblem = AlembicHttpProblem;

interface ProjectActionPublicData {
  action: ProjectRuntimeControlActionResult['action'];
  deferredStopProject: ProjectRuntimeScopeSummary | null;
  error: string | null;
  handoff: ProjectRuntimeHandoff | null;
  ok: boolean;
  previousActiveProject: ProjectRuntimeScopeSummary | null;
  snapshot: ProjectRuntimeControlSnapshot;
  stoppedProject: ProjectRuntimeScopeSummary | null;
  targetProject: ProjectRuntimeScopeSummary | null;
}

router.get('/', async (_req: Request, res: Response): Promise<void> => {
  const control = new ProjectRuntimeControl();
  const snapshot = await control.snapshot();
  res.json({ success: true, data: snapshot });
});

router.get('/status', async (_req: Request, res: Response): Promise<void> => {
  const control = new ProjectRuntimeControl();
  const snapshot = await control.snapshot();
  res.json({ success: true, data: snapshot });
});

router.get('/current', async (_req: Request, res: Response): Promise<void> => {
  const control = new ProjectRuntimeControl();
  const snapshot = await control.snapshot();
  res.json({
    success: true,
    data: {
      activeRuntimeProject: snapshot.activeRuntimeProject,
      selectedProject: snapshot.selectedProject,
      sourceOfTruth: snapshot.sourceOfTruth,
      state: snapshot.state,
    },
  });
});

router.post('/select', async (req: Request, res: Response): Promise<void> => {
  const control = new ProjectRuntimeControl();
  const target = targetFromBody(req.body);
  if (!target) {
    res.status(400).json({ success: false, error: invalidProjectTargetProblem() });
    return;
  }
  try {
    const snapshot = await control.selectProject(target);
    res.json({ success: true, data: snapshot });
  } catch (error: unknown) {
    const problem = problemFromError(error, 'not-found', 404);
    res.status(problem.status).json({ success: false, error: problem });
  }
});

router.delete('/select', async (_req: Request, res: Response): Promise<void> => {
  const control = new ProjectRuntimeControl();
  const snapshot = await control.clearSelection();
  res.json({ success: true, data: snapshot });
});

router.post('/open-dashboard', async (req: Request, res: Response): Promise<void> => {
  const options = httpControlOptionsFromBody(req.body);
  await sendAction(
    res,
    () => new ProjectRuntimeControl().openDashboard(undefined, options),
    options
  );
});

router.post('/:projectId/start', async (req: Request, res: Response): Promise<void> => {
  const options = httpControlOptionsFromBody(req.body);
  await sendAction(
    res,
    () =>
      new ProjectRuntimeControl().startProject(
        { projectId: singleParam(req.params.projectId) },
        options
      ),
    options
  );
});

router.post('/:projectId/stop', async (req: Request, res: Response): Promise<void> => {
  const options = httpControlOptionsFromBody(req.body);
  await sendAction(
    res,
    () =>
      new ProjectRuntimeControl().stopProject(
        { projectId: singleParam(req.params.projectId) },
        options
      ),
    options
  );
});

router.post('/:projectId/open-dashboard', async (req: Request, res: Response): Promise<void> => {
  const options = httpControlOptionsFromBody(req.body);
  await sendAction(
    res,
    () =>
      new ProjectRuntimeControl().openDashboard(
        { projectId: singleParam(req.params.projectId) },
        options
      ),
    options
  );
});

router.post('/:projectId/switch', async (req: Request, res: Response): Promise<void> => {
  const options = httpControlOptionsFromBody(req.body);
  await sendAction(
    res,
    () =>
      new ProjectRuntimeControl().switchProject(
        { projectId: singleParam(req.params.projectId) },
        options
      ),
    options
  );
});

router.get('/:projectId', async (req: Request, res: Response): Promise<void> => {
  const control = new ProjectRuntimeControl();
  try {
    const project = await control.inspectProject({
      projectId: singleParam(req.params.projectId),
    });
    res.json({ success: true, data: { project } });
  } catch (error: unknown) {
    const problem = problemFromError(error, 'not-found', 404);
    res.status(problem.status).json({ success: false, error: problem });
  }
});

function targetFromBody(value: unknown): ProjectRuntimeTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  const target = {
    projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
    projectRoot: typeof body.projectRoot === 'string' ? body.projectRoot : undefined,
  };
  return isProjectRuntimeTarget(target) ? target : null;
}

function controlOptionsFromBody(value: unknown): ProjectRuntimeControlOptions {
  const body =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    restart: body.restart === true,
    stopWaitMs: numberOption(body.stopWaitMs),
    waitUntilReadyMs: numberOption(body.waitUntilReadyMs),
  };
}

function httpControlOptionsFromBody(value: unknown): ProjectRuntimeControlOptions {
  return {
    ...controlOptionsFromBody(value),
    deferSelfDaemonStop: true,
  };
}

function sendActionResult(res: Response, result: ProjectRuntimeControlActionResult): void {
  const data = projectActionPublicData(result);
  if (result.ok) {
    res.status(200).json({ success: true, data });
    return;
  }
  const problem = problemFromActionResult(result);
  res.status(problem.status).json({ success: false, data, error: problem });
}

async function sendAction(
  res: Response,
  action: () => Promise<ProjectRuntimeControlActionResult>,
  options: ProjectRuntimeControlOptions = {}
): Promise<void> {
  try {
    const result = await action();
    scheduleDeferredStopAfterResponse(res, result, options);
    sendActionResult(res, result);
  } catch (error: unknown) {
    const problem = problemFromError(error, 'not-found', 404);
    res.status(problem.status).json({ success: false, error: problem });
  }
}

function projectActionPublicData(
  result: ProjectRuntimeControlActionResult
): ProjectActionPublicData {
  return {
    action: result.action,
    deferredStopProject: result.deferredStopProject,
    error: result.error,
    handoff: result.handoff,
    ok: result.ok,
    previousActiveProject: result.previousActiveProject,
    snapshot: result.snapshot,
    stoppedProject: result.stoppedProject,
    targetProject: result.targetProject,
  };
}

function scheduleDeferredStopAfterResponse(
  res: Response,
  result: ProjectRuntimeControlActionResult,
  options: ProjectRuntimeControlOptions
): void {
  const project = result.deferredStopProject;
  if (!result.ok || !project) {
    return;
  }

  res.once('finish', () => {
    setTimeout(() => {
      new DaemonSupervisor()
        .stop({ projectRoot: project.projectRoot, waitMs: options.stopWaitMs })
        .catch((error: unknown) => {
          console.warn(`[projects] deferred daemon stop failed: ${errorMessage(error)}`);
        });
    }, 50);
  });
}

function singleParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function numberOption(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidProjectTargetProblem(): ProjectRuntimeProblem {
  return buildProjectRuntimeProblem(
    'INVALID_PROJECT_TARGET',
    'Project target requires exactly one of projectId or projectRoot',
    'invalid-input'
  );
}

function problemFromActionResult(result: ProjectRuntimeControlActionResult): ProjectRuntimeProblem {
  const message = result.error ?? 'Project runtime action failed';
  const reasonCode = classifyProjectRuntimeProblem(message);
  const status = statusForProjectRuntimeReason(reasonCode);
  return buildProjectRuntimeProblem(codeForProjectRuntimeReason(reasonCode), message, reasonCode, {
    status,
  });
}

function problemFromError(
  error: unknown,
  fallbackReason: ProjectRuntimeProblemReason,
  fallbackStatus: number
): ProjectRuntimeProblem {
  const message = errorMessage(error);
  const reasonCode = message ? classifyProjectRuntimeProblem(message) : fallbackReason;
  const status = message ? statusForProjectRuntimeReason(reasonCode) : fallbackStatus;
  return buildProjectRuntimeProblem(codeForProjectRuntimeReason(reasonCode), message, reasonCode, {
    status,
  });
}

function buildProjectRuntimeProblem(
  code: string,
  message: string,
  reasonCode: ProjectRuntimeProblemReason,
  options: { status?: number } = {}
): ProjectRuntimeProblem {
  return buildAlembicHttpProblem(code, message, reasonCode, {
    status: options.status ?? statusForProjectRuntimeReason(reasonCode),
  });
}

function classifyProjectRuntimeProblem(message: string): ProjectRuntimeProblemReason {
  const normalized = message.toLowerCase();
  if (normalized.includes('permission') || normalized.includes('forbidden')) {
    return 'permission-denied';
  }
  if (
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('did not become ready')
  ) {
    return 'timeout';
  }
  if (normalized.includes('cancel')) {
    return 'cancelled';
  }
  if (
    normalized.includes('missing') ||
    normalized.includes('not found') ||
    normalized.includes('not registered') ||
    normalized.includes('no selected')
  ) {
    return 'not-found';
  }
  if (normalized.includes('unavailable') || normalized.includes('not available')) {
    return 'unavailable';
  }
  if (
    normalized.includes('already') ||
    normalized.includes('mismatch') ||
    normalized.includes('conflict')
  ) {
    return 'conflict';
  }
  return 'internal-error';
}

function statusForProjectRuntimeReason(reasonCode: ProjectRuntimeProblemReason): number {
  switch (reasonCode) {
    case 'invalid-input':
      return 400;
    case 'permission-denied':
      return 403;
    case 'not-found':
      return 404;
    case 'conflict':
    case 'cancelled':
      return 409;
    case 'timeout':
      return 504;
    case 'unavailable':
      return 503;
    case 'internal-error':
      return 500;
  }
}

function codeForProjectRuntimeReason(reasonCode: ProjectRuntimeProblemReason): string {
  switch (reasonCode) {
    case 'invalid-input':
      return 'INVALID_PROJECT_TARGET';
    case 'permission-denied':
      return 'PROJECT_RUNTIME_PERMISSION_DENIED';
    case 'not-found':
      return 'PROJECT_RUNTIME_NOT_FOUND';
    case 'conflict':
      return 'PROJECT_RUNTIME_CONFLICT';
    case 'cancelled':
      return 'PROJECT_RUNTIME_CANCELLED';
    case 'timeout':
      return 'PROJECT_RUNTIME_TIMEOUT';
    case 'unavailable':
      return 'PROJECT_RUNTIME_UNAVAILABLE';
    case 'internal-error':
      return 'PROJECT_RUNTIME_ERROR';
  }
}

export default router;
