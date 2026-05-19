import { isProjectRuntimeTarget } from '@alembic/core/daemon';
import express, { type Request, type Response } from 'express';
import { DaemonSupervisor } from '../../daemon/DaemonSupervisor.js';
import {
  ProjectRuntimeControl,
  type ProjectRuntimeControlActionResult,
  type ProjectRuntimeControlOptions,
  type ProjectRuntimeTarget,
} from '../../daemon/ProjectRuntimeControl.js';

const router = express.Router();

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
      state: snapshot.state,
    },
  });
});

router.post('/select', async (req: Request, res: Response): Promise<void> => {
  const control = new ProjectRuntimeControl();
  const target = targetFromBody(req.body);
  if (!target) {
    res.status(400).json({
      success: false,
      error: 'Project target requires exactly one of projectId or projectRoot',
    });
    return;
  }
  try {
    const snapshot = await control.selectProject(target);
    res.json({ success: true, data: snapshot });
  } catch (error: unknown) {
    res.status(404).json({ success: false, error: errorMessage(error) });
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
    res.status(404).json({ success: false, error: errorMessage(error) });
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
    waitUntilReadyMs: numberOption(body.waitUntilReadyMs ?? body.waitMs),
  };
}

function httpControlOptionsFromBody(value: unknown): ProjectRuntimeControlOptions {
  return {
    ...controlOptionsFromBody(value),
    deferSelfDaemonStop: true,
  };
}

function sendActionResult(res: Response, result: ProjectRuntimeControlActionResult): void {
  res.status(result.ok ? 200 : 409).json({ success: result.ok, data: result, error: result.error });
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
    res.status(404).json({ success: false, error: errorMessage(error) });
  }
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

export default router;
