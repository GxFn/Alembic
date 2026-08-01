import express, { type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import {
  assertStrictTestEmptyQuery,
  parseStrictTestPreflightRequest,
  parseStrictTestRunId,
  parseStrictTestRunRequest,
  type StrictTestPreflightRequestV1,
  type StrictTestRunRequestV1,
} from '../../recipe-pipeline/generate/strict/StrictTestRequestContracts.js';

export interface StrictTestDimensionApiService {
  preflight(input: StrictTestPreflightRequestV1): Promise<unknown>;
  start(input: StrictTestRunRequestV1): Promise<unknown>;
  status(runId: string): Promise<unknown>;
  report(runId: string): Promise<unknown>;
}

type StrictTestDimensionServiceFactory = () => StrictTestDimensionApiService;

/** 独立 strict-test API；该 router 没有 DaemonJob/legacy bootstrap 依赖。 */
export function createStrictTestDimensionRouter(getService: StrictTestDimensionServiceFactory) {
  const router = express.Router();

  router.post('/preflight', async (req: Request, res: Response): Promise<void> => {
    try {
      assertStrictTestEmptyQuery(req.query);
      const result = await getService().preflight(parseStrictTestPreflightRequest(req.body));
      res.json({ success: true, data: result });
    } catch (error: unknown) {
      respondStrictTestError(res, error);
    }
  });

  router.post('/runs', async (req: Request, res: Response): Promise<void> => {
    try {
      assertStrictTestEmptyQuery(req.query);
      const result = await getService().start(parseStrictTestRunRequest(req.body));
      res.status(202).json({ success: true, data: result });
    } catch (error: unknown) {
      respondStrictTestError(res, error);
    }
  });

  router.get('/runs/:runId', async (req: Request, res: Response): Promise<void> => {
    try {
      assertStrictTestEmptyQuery(req.query);
      const result = await getService().status(parseStrictTestRunId(singleParam(req.params.runId)));
      res.json({ success: true, data: result });
    } catch (error: unknown) {
      respondStrictTestError(res, error);
    }
  });

  router.get('/runs/:runId/report', async (req: Request, res: Response): Promise<void> => {
    try {
      assertStrictTestEmptyQuery(req.query);
      const result = await getService().report(parseStrictTestRunId(singleParam(req.params.runId)));
      res.json({ success: true, data: result });
    } catch (error: unknown) {
      respondStrictTestError(res, error);
    }
  });

  return router;
}

function defaultService(): StrictTestDimensionApiService {
  const container = getServiceContainer() as unknown as { get(name: string): unknown };
  return container.get('strictTestDimensionOrchestrator') as StrictTestDimensionApiService;
}

function respondStrictTestError(res: Response, error: unknown): void {
  if (error instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: {
        code: 'STRICT_TEST_REQUEST_INVALID',
        message: 'Strict-test request does not match the exact profile contract',
        details: error.flatten(),
      },
    });
    return;
  }
  const code = error instanceof Error ? error.message.split(':', 1)[0] : 'STRICT_TEST_FAILED';
  const status =
    code === 'STRICT_TEST_RUN_NOT_FOUND'
      ? 404
      : code === 'STRICT_TEST_REPORT_NOT_READY'
        ? 409
        : 422;
  res.status(status).json({
    success: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

function singleParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export default createStrictTestDimensionRouter(defaultService);
