import Logger from '@alembic/core/logging';
import express, { type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import {
  toStrictTestPreflightPublicDtoV1,
  toStrictTestReportPublicDtoV1,
  toStrictTestRunStatusPublicDtoV1,
} from '../../recipe-pipeline/generate/strict/StrictTestPublicContracts.js';
import {
  assertStrictTestEmptyQuery,
  parseStrictTestPreflightRequest,
  parseStrictTestRunId,
  parseStrictTestRunRequest,
  type StrictTestPreflightRequestV1,
  type StrictTestRunRequestV1,
} from '../../recipe-pipeline/generate/strict/StrictTestRequestContracts.js';
import { type AlembicHttpProblemReason, buildAlembicHttpProblem } from '../problem-taxonomy.js';

export interface StrictTestDimensionApiService {
  preflight(input: StrictTestPreflightRequestV1): Promise<unknown>;
  start(input: StrictTestRunRequestV1): Promise<unknown>;
  status(runId: string): Promise<unknown>;
  report(runId: string): Promise<unknown>;
}

type StrictTestDimensionServiceFactory = () => StrictTestDimensionApiService;
const logger = Logger.getInstance();

/** 独立 strict-test API；该 router 没有 DaemonJob/legacy bootstrap 依赖。 */
export function createStrictTestDimensionRouter(getService: StrictTestDimensionServiceFactory) {
  const router = express.Router();

  router.post('/preflight', async (req: Request, res: Response): Promise<void> => {
    try {
      assertStrictTestEmptyQuery(req.query);
      const result = await getService().preflight(parseStrictTestPreflightRequest(req.body));
      res.json({ success: true, data: toStrictTestPreflightPublicDtoV1(result) });
    } catch (error: unknown) {
      respondStrictTestError(res, error);
    }
  });

  router.post('/runs', async (req: Request, res: Response): Promise<void> => {
    try {
      assertStrictTestEmptyQuery(req.query);
      const input = parseStrictTestRunRequest(req.body);
      const service = getService();
      let result: unknown;
      try {
        result = await service.start(input);
      } catch (error: unknown) {
        // 真实 orchestrator 会先封存失败 terminal/report 再抛错；只按同一 owner-bound
        // service 重开同 run，并在 public DTO 的 demand/preflight/run 全匹配时附带安全状态。
        const failed = await reopenDurableFailedStart(service, input);
        if (failed) {
          logger.warn('[strict-test] reopened durable failed start', {
            code: publicStrictTestCode(failed.terminal?.errorCode ?? null),
            demandKey: input.demandKey,
            runId: input.runId,
            terminalState: failed.terminal?.terminalState,
          });
          respondStrictTestProblem(res, {
            code: publicStrictTestCode(failed.terminal?.errorCode ?? null),
            data: failed,
            message: 'Strict-test run failed',
            reasonCode: 'host-failure',
            status: 422,
          });
          return;
        }
        logger.warn('[strict-test] start failed without matching durable public checkpoint', {
          code: publicStrictTestCode(
            error instanceof Error ? error.message.split(':', 1)[0] : null
          ),
          demandKey: input.demandKey,
          runId: input.runId,
        });
        respondStrictTestError(res, error);
        return;
      }
      const data = toStrictTestRunStatusPublicDtoV1(result);
      if (!matchesStartAuthority(data, input)) {
        throw new Error('STRICT_TEST_START_RESULT_AUTHORITY_MISMATCH');
      }
      if (data.terminal?.terminalState === 'STRICT_TEST_FAILED') {
        respondStrictTestProblem(res, {
          code: publicStrictTestCode(data.terminal.errorCode),
          data,
          message: 'Strict-test run failed',
          reasonCode: 'host-failure',
          status: 422,
        });
        return;
      }
      res.status(202).json({ success: true, data });
    } catch (error: unknown) {
      respondStrictTestError(res, error);
    }
  });

  router.get('/runs/:runId', async (req: Request, res: Response): Promise<void> => {
    try {
      assertStrictTestEmptyQuery(req.query);
      const result = await getService().status(parseStrictTestRunId(singleParam(req.params.runId)));
      res.json({ success: true, data: toStrictTestRunStatusPublicDtoV1(result) });
    } catch (error: unknown) {
      respondStrictTestError(res, error);
    }
  });

  router.get('/runs/:runId/report', async (req: Request, res: Response): Promise<void> => {
    try {
      assertStrictTestEmptyQuery(req.query);
      const result = await getService().report(parseStrictTestRunId(singleParam(req.params.runId)));
      res.json({ success: true, data: toStrictTestReportPublicDtoV1(result) });
    } catch (error: unknown) {
      respondStrictTestError(res, error);
    }
  });

  return router;
}

async function reopenDurableFailedStart(
  service: StrictTestDimensionApiService,
  input: StrictTestRunRequestV1
): Promise<ReturnType<typeof toStrictTestRunStatusPublicDtoV1> | null> {
  try {
    const data = toStrictTestRunStatusPublicDtoV1(await service.status(input.runId));
    if (
      !matchesStartAuthority(data, input) ||
      data.phase !== 'STRICT_TEST_FAILED' ||
      data.terminal?.terminalState !== 'STRICT_TEST_FAILED' ||
      !data.terminal.failedStage ||
      !data.terminal.errorCode ||
      !data.reportHash
    ) {
      return null;
    }
    return data;
  } catch (_error: unknown) {
    // 重开只是已失败 start 的受限证据恢复；缺失/损坏 checkpoint 不得替换原始错误。
    return null;
  }
}

function matchesStartAuthority(
  data: ReturnType<typeof toStrictTestRunStatusPublicDtoV1>,
  input: StrictTestRunRequestV1
): boolean {
  return (
    data.demandKey === input.demandKey &&
    data.runId === input.runId &&
    data.preflightHash === input.preflightHash
  );
}

function defaultService(): StrictTestDimensionApiService {
  const container = getServiceContainer() as unknown as { get(name: string): unknown };
  return container.get('strictTestDimensionOrchestrator') as StrictTestDimensionApiService;
}

function respondStrictTestError(res: Response, error: unknown): void {
  if (error instanceof ZodError) {
    respondStrictTestProblem(res, {
      code: 'STRICT_TEST_REQUEST_INVALID',
      message: 'Strict-test request does not match the exact profile contract',
      reasonCode: 'invalid-input',
      status: 400,
    });
    return;
  }
  const rawCode = error instanceof Error ? error.message.split(':', 1)[0] : null;
  const code = publicStrictTestCode(rawCode);
  if (code === 'STRICT_TEST_RUN_NOT_FOUND') {
    respondStrictTestProblem(res, {
      code,
      message: 'Strict-test run was not found',
      reasonCode: 'not-found',
      status: 404,
    });
    return;
  }
  if (code === 'STRICT_TEST_REPORT_NOT_READY') {
    respondStrictTestProblem(res, {
      code,
      message: 'Strict-test report is not ready',
      reasonCode: 'conflict',
      status: 409,
    });
    return;
  }
  respondStrictTestProblem(res, {
    code,
    message: 'Strict-test operation failed',
    reasonCode: strictTestFailureReason(code),
    status: 422,
  });
}

function respondStrictTestProblem(
  res: Response,
  input: {
    readonly code: string;
    readonly data?: unknown;
    readonly message: string;
    readonly reasonCode: AlembicHttpProblemReason;
    readonly status: number;
  }
): void {
  res.status(input.status).json({
    success: false,
    error: buildAlembicHttpProblem(input.code, input.message, input.reasonCode, {
      status: input.status,
    }),
    ...(input.data === undefined ? {} : { data: input.data }),
  });
}

function publicStrictTestCode(value: string | null): string {
  return value && /^STRICT_TEST_[A-Z0-9_]+$/u.test(value) ? value : 'STRICT_TEST_FAILED';
}

function strictTestFailureReason(code: string): AlembicHttpProblemReason {
  return /(?:AUTHORITY|DRIFT|INVALID|MISMATCH)/u.test(code) ? 'schema-drift' : 'internal-error';
}

function singleParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export default createStrictTestDimensionRouter(defaultService);
