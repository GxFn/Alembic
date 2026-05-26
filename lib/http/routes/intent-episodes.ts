/**
 * IntentEpisode resident API.
 *
 * Alembic owns the ProjectScope-scoped durable store. Plugin/host callers may
 * write redacted episode starts and outcomes here, then read latest/recent
 * context before the next prime. Raw host thread ids and absolute paths are
 * normalized inside IntentEpisodeStore before they touch disk or responses.
 */

import express, { type Request, type Response } from 'express';
import type { z } from 'zod';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import type { IntentEpisodeStore } from '../../service/task/IntentEpisodeStore.js';
import {
  IntentEpisodeOutcomeBody,
  IntentEpisodeStartBody,
} from '../../shared/schemas/http-requests.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

router.post('/', validate(IntentEpisodeStartBody), (req: Request, res: Response): void => {
  const store = getIntentEpisodeStore();
  const episode = store.start(req.body as z.infer<typeof IntentEpisodeStartBody>);
  res.status(201).json({
    success: true,
    data: {
      capability: buildIntentEpisodeCapability(),
      episode,
    },
  });
});

router.get('/latest', (req: Request, res: Response): void => {
  const episode = getIntentEpisodeStore().latest({ sessionId: firstString(req.query.sessionId) });
  res.json({
    success: true,
    data: {
      capability: buildIntentEpisodeCapability(),
      episode,
    },
  });
});

router.get('/recent', (req: Request, res: Response): void => {
  const episodes = getIntentEpisodeStore().recent({
    limit: safeLimit(req.query.limit),
    sessionId: firstString(req.query.sessionId),
  });
  res.json({
    success: true,
    data: {
      capability: buildIntentEpisodeCapability(),
      count: episodes.length,
      episodes,
    },
  });
});

router.get('/:episodeId', (req: Request, res: Response): void => {
  const episode = getIntentEpisodeStore().get(singleParam(req.params.episodeId));
  if (!episode) {
    res.status(404).json({ success: false, error: 'IntentEpisode not found' });
    return;
  }
  res.json({
    success: true,
    data: {
      capability: buildIntentEpisodeCapability(),
      episode,
    },
  });
});

router.patch(
  '/:episodeId',
  validate(IntentEpisodeOutcomeBody),
  (req: Request, res: Response): void => {
    const episode = getIntentEpisodeStore().updateOutcome(singleParam(req.params.episodeId), {
      ...(req.body as z.infer<typeof IntentEpisodeOutcomeBody>),
    });
    if (!episode) {
      res.status(404).json({ success: false, error: 'IntentEpisode not found' });
      return;
    }
    res.json({
      success: true,
      data: {
        capability: buildIntentEpisodeCapability(),
        episode,
      },
    });
  }
);

export function buildIntentEpisodeCapability() {
  return {
    available: true,
    endpoints: {
      latest: '/api/v1/intent-episodes/latest',
      read: '/api/v1/intent-episodes/:episodeId',
      recent: '/api/v1/intent-episodes/recent',
      start: '/api/v1/intent-episodes',
      updateOutcome: '/api/v1/intent-episodes/:episodeId',
    },
    owner: 'alembic',
    storage: {
      keyPrivacy: 'sha256-session-key',
      pathPrivacy: 'absolute-path-redacted',
      scope: 'project-scope-data-root',
    },
  };
}

function getIntentEpisodeStore(): IntentEpisodeStore {
  return getServiceContainer().get('intentEpisodeStore') as IntentEpisodeStore;
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

export default router;
