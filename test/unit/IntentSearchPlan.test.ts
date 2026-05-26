import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { normalizeHostIntentContext } from '../../lib/service/task/HostIntentContext.js';
import { IntentEpisodeStore } from '../../lib/service/task/IntentEpisodeStore.js';
import { buildIntentSearchPlan } from '../../lib/service/task/IntentSearchPlan.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'alembic-intent-search-plan-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('IntentSearchPlan', () => {
  test('builds keyword/BM25 plan from recognized draft and episode continuity', () => {
    const store = new IntentEpisodeStore({ dataRoot: tempRoot() });
    store.start({
      query: 'previous dependency injection recipe',
      sessionId: 'thread:thread-hash',
      sourceRefs: ['knowledge:previous'],
    });
    const hostIntentContext = normalizeHostIntentContext({
      intentContext: {
        keywords: ['factory'],
        recognizedIntentDraft: {
          confidence: 0.86,
          constraints: ['dependency injection'],
          query: 'compose service factory',
          sourceRefs: ['/Users/private/project/src/service.ts:42'],
          status: 'recognized',
          target: 'ServiceFactory',
        },
      },
      userQuery: 'fallback query',
    });

    const plan = buildIntentSearchPlan({
      episodeStore: store,
      hostIntentContext,
      hostTurnMeta: { threadIdHash: 'thread-hash' },
      intentContext: {
        keywords: ['factory'],
        recognizedIntentDraft: {
          confidence: 0.86,
          constraints: ['dependency injection'],
          query: 'compose service factory',
          sourceRefs: ['/Users/private/project/src/service.ts:42'],
          status: 'recognized',
          target: 'ServiceFactory',
        },
      },
      mode: 'bm25',
      rawQuery: 'fallback query',
    });

    expect(plan).toMatchObject({
      applied: true,
      confidence: 0.86,
      executableQuery: expect.stringContaining('compose service factory'),
      rankingProfile: 'bm25-intent',
      requestedMode: 'bm25',
    });
    expect(plan.executableQuery).toContain('dependency injection');
    expect(plan.executableQuery).toContain('previous dependency injection recipe');
    expect(plan.episode?.latest).toMatchObject({
      query: 'previous dependency injection recipe',
      status: 'active',
    });
    expect(plan.sourceRefs).toEqual(
      expect.arrayContaining(['[absolute-path]/service.ts:42', 'knowledge:previous'])
    );
    expect(plan.whySelected).toEqual(
      expect.arrayContaining([
        'recognizedIntentDraft.query',
        'recognizedIntentDraft.constraints',
        'intentEpisode.latest.query',
      ])
    );
    expect(JSON.stringify(plan)).not.toContain('/Users/private');
  });

  test('keeps raw query when recognized draft is low confidence', () => {
    const hostIntentContext = normalizeHostIntentContext({
      intentContext: {
        recognizedIntentDraft: {
          confidence: 0.2,
          query: 'risky inferred query',
          status: 'needs-confirmation',
        },
      },
      userQuery: 'fallback query',
    });

    const plan = buildIntentSearchPlan({
      hostIntentContext,
      intentContext: {
        recognizedIntentDraft: {
          confidence: 0.2,
          query: 'risky inferred query',
          status: 'needs-confirmation',
        },
      },
      mode: 'keyword',
      rawQuery: 'fallback query',
    });

    expect(plan).toMatchObject({
      applied: false,
      executableQuery: 'fallback query',
      rankingProfile: 'raw-fallback',
    });
    expect(plan.omitted).toEqual(
      expect.arrayContaining([
        'recognizedIntentDraft.lowConfidence',
        'recognizedIntentDraft.status:needs-confirmation',
      ])
    );
  });

  test('observes semantic mode without changing the vector query path', () => {
    const hostIntentContext = normalizeHostIntentContext({
      intentContext: {
        recognizedIntentDraft: {
          confidence: 0.91,
          query: 'semantic intent query',
          status: 'recognized',
        },
      },
      userQuery: 'fallback semantic query',
    });

    const plan = buildIntentSearchPlan({
      hostIntentContext,
      intentContext: {
        recognizedIntentDraft: {
          confidence: 0.91,
          query: 'semantic intent query',
          status: 'recognized',
        },
      },
      mode: 'semantic',
      rawQuery: 'fallback semantic query',
    });

    expect(plan).toMatchObject({
      applied: false,
      executableQuery: 'fallback semantic query',
      rankingProfile: 'semantic-observe',
    });
    expect(plan.omitted).toContain('mode:semantic:observeOnly');
  });
});
