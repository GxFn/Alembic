/**
 * Durable Decision Register resident API.
 *
 * Alembic owns the dataRoot-scoped producer side. Host/plugin callers can create
 * and mutate durable decision records without leaking raw thread ids or absolute
 * paths into disk artifacts.
 */

import express, { type Request, type Response } from 'express';
import type { z } from 'zod';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import {
  type DecisionRegisterStatus,
  type DecisionRegisterStore,
  DecisionRegisterStoreError,
} from '../../service/task/DecisionRegisterStore.js';
import {
  DecisionRegisterCreateBody,
  DecisionRegisterSearchableQuery,
  DecisionRegisterTerminalBody,
  DecisionRegisterUpdateBody,
} from '../../shared/schemas/http-requests.js';
import { validate, validateQuery } from '../middleware/validate.js';

const router = express.Router();

router.get('/capability', (_req: Request, res: Response): void => {
  res.json({ success: true, data: { capability: buildDecisionRegisterCapability() } });
});

router.post('/', validate(DecisionRegisterCreateBody), (req: Request, res: Response): void => {
  sendMutation(res, () =>
    getDecisionRegisterStore().create(req.body as z.infer<typeof DecisionRegisterCreateBody>)
  );
});

router.get('/', (req: Request, res: Response): void => {
  const decisions = getDecisionRegisterStore().list({
    includeDeleted: booleanQuery(req.query.includeDeleted),
    limit: safeLimit(req.query.limit),
    sessionId: firstString(req.query.sessionId),
    status: normalizeStatus(req.query.status),
  });
  res.json({
    success: true,
    data: {
      capability: buildDecisionRegisterCapability(),
      count: decisions.length,
      decisions,
    },
  });
});

router.get(
  '/searchable',
  validateQuery(DecisionRegisterSearchableQuery),
  (req: Request, res: Response): void => {
    const query = req.query as unknown as z.infer<typeof DecisionRegisterSearchableQuery>;
    const view = getDecisionRegisterStore().searchable({
      includeAudit: query.includeAudit,
      limit: query.limit,
      query: query.q,
      sessionId: query.sessionId,
      status: query.status,
    });
    res.json({
      success: true,
      data: {
        acceptedCount: view.acceptedCount,
        auditCount: view.auditCount,
        auditExcludedCount: view.auditExcludedCount,
        capability: buildDecisionRegisterCapability(),
        count: view.documents.length,
        documents: view.documents,
        policy: view.policy,
        query: view.query,
        status: view.status,
        totalMatched: view.totalMatched,
      },
    });
  }
);

router.get('/:decisionId', (req: Request, res: Response): void => {
  const decision = getDecisionRegisterStore().get(singleParam(req.params.decisionId));
  if (!decision) {
    res.status(404).json({
      success: false,
      error: 'Decision not found',
      reasonCode: 'decision-not-found',
    });
    return;
  }
  res.json({
    success: true,
    data: {
      capability: buildDecisionRegisterCapability(),
      decision,
    },
  });
});

router.patch(
  '/:decisionId',
  validate(DecisionRegisterUpdateBody),
  (req: Request, res: Response): void => {
    sendMutation(res, () =>
      getDecisionRegisterStore().update(
        singleParam(req.params.decisionId),
        req.body as z.infer<typeof DecisionRegisterUpdateBody>
      )
    );
  }
);

router.post(
  '/:decisionId/revoke',
  validate(DecisionRegisterTerminalBody),
  (req: Request, res: Response): void => {
    sendMutation(res, () =>
      getDecisionRegisterStore().revoke(
        singleParam(req.params.decisionId),
        req.body as z.infer<typeof DecisionRegisterTerminalBody>
      )
    );
  }
);

router.delete(
  '/:decisionId',
  validate(DecisionRegisterTerminalBody),
  (req: Request, res: Response): void => {
    sendMutation(res, () =>
      getDecisionRegisterStore().delete(
        singleParam(req.params.decisionId),
        req.body as z.infer<typeof DecisionRegisterTerminalBody>
      )
    );
  }
);

export function buildDecisionRegisterCapability() {
  return {
    available: true,
    contractVersion: 1,
    endpoints: {
      capability: '/api/v1/decision-register/capability',
      create: '/api/v1/decision-register',
      delete: '/api/v1/decision-register/:decisionId',
      list: '/api/v1/decision-register',
      read: '/api/v1/decision-register/:decisionId',
      revoke: '/api/v1/decision-register/:decisionId/revoke',
      searchable: '/api/v1/decision-register/searchable',
      update: '/api/v1/decision-register/:decisionId',
    },
    lifecycle: ['create', 'update', 'revoke', 'delete', 'read', 'list', 'searchable'],
    owner: 'alembic',
    retrieval: {
      auditReadback: {
        includeAudit: true,
        status: 'all',
      },
      defaultLifecycle: 'active-effective-only',
      defaultView: '/api/v1/decision-register/searchable',
      excludedStatuses: ['revoked', 'deleted'],
      sourceRefGate: 'observe-only',
      vectorAdmission: 'accepted-only',
    },
    route: 'decision-register',
    storage: {
      audit: 'append-only-jsonl',
      keyPrivacy: 'sha256-session-turn-source-ref-keys',
      pathPrivacy: 'absolute-path-redacted',
      scope: 'project-scope-data-root',
      storeDir: '.asd/decision-register',
    },
  };
}

function sendMutation(
  res: Response,
  mutate: () => ReturnType<DecisionRegisterStore['create']> | null
): void {
  try {
    const decision = mutate();
    if (!decision) {
      res.status(404).json({
        success: false,
        error: 'Decision not found',
        reasonCode: 'decision-not-found',
      });
      return;
    }
    res.status(decision.revision === 1 ? 201 : 200).json({
      success: true,
      data: {
        capability: buildDecisionRegisterCapability(),
        decision,
      },
    });
  } catch (err: unknown) {
    if (err instanceof DecisionRegisterStoreError) {
      res.status(err.statusCode).json({
        success: false,
        error: err.message,
        reasonCode: err.reasonCode,
      });
      return;
    }
    throw err;
  }
}

function getDecisionRegisterStore(): DecisionRegisterStore {
  return getServiceContainer().get('decisionRegisterStore') as DecisionRegisterStore;
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return firstString(value[0]);
  }
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function singleParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function safeLimit(value: unknown): number | undefined {
  const raw = firstString(value);
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanQuery(value: unknown): boolean | undefined {
  const raw = firstString(value);
  if (!raw) {
    return undefined;
  }
  return raw === 'true';
}

function normalizeStatus(value: unknown): DecisionRegisterStatus | 'all' | undefined {
  const raw = firstString(value);
  if (raw === 'active' || raw === 'revoked' || raw === 'deleted' || raw === 'all') {
    return raw;
  }
  return undefined;
}

export default router;
