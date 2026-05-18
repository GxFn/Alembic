import express, { type Request, type Response } from 'express';
import {
  ProjectRuntimeControl,
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

function targetFromBody(value: unknown): ProjectRuntimeTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const body = value as Record<string, unknown>;
  return {
    projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
    projectRoot: typeof body.projectRoot === 'string' ? body.projectRoot : undefined,
  };
}

function singleParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default router;
