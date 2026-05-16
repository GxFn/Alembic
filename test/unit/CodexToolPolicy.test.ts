import { describe, expect, test } from 'vitest';
import {
  CODEX_LOCAL_TOOLS,
  type CodexKnowledgeState,
  resolveCodexToolPolicy,
} from '../../lib/codex/index.js';

const tierOrder = { agent: 0, admin: 1 };
const coreTools = [
  {
    name: 'alembic_health',
    tier: 'agent',
    description: 'health',
    inputSchema: { type: 'object' },
  },
  {
    name: 'alembic_knowledge_lifecycle',
    tier: 'admin',
    description: 'lifecycle',
    inputSchema: { type: 'object' },
  },
];

const notInitialized: CodexKnowledgeState = {
  hasKnowledge: false,
  initialized: false,
  recipeCount: 0,
  skillCount: 0,
  status: 'not_initialized',
  usable: false,
};

const initializedEmpty: CodexKnowledgeState = {
  ...notInitialized,
  initialized: true,
  status: 'initialized_empty',
};

const knowledgeReady: CodexKnowledgeState = {
  hasKnowledge: true,
  initialized: true,
  recipeCount: 1,
  skillCount: 0,
  status: 'knowledge_ready',
  usable: true,
};

describe('Codex tool policy', () => {
  test('keeps uninitialized workspaces on diagnostics/status/init and init-on-demand tools', () => {
    const result = resolveCodexToolPolicy({
      coreTools,
      knowledge: notInitialized,
      tierName: 'agent',
      tierOrder,
    });

    expect(result.hiddenReason).toBe('CODEX_ALEMBIC_KNOWLEDGE_REQUIRED');
    expect(result.state).toBe('needs_init');
    expect(result.visibleTools.map((tool) => tool.name)).toEqual([
      'alembic_codex_status',
      'alembic_codex_diagnostics',
      'alembic_codex_init',
      'alembic_codex_ai_config',
      'alembic_codex_dashboard',
      'alembic_codex_bootstrap',
      'alembic_codex_rescan',
      'alembic_codex_job',
    ]);
  });

  test('exposes cold-start job tools after initialization and before usable knowledge', () => {
    const result = resolveCodexToolPolicy({
      coreTools,
      knowledge: initializedEmpty,
      tierName: 'agent',
      tierOrder,
    });

    expect(result.state).toBe('needs_bootstrap');
    expect(result.visibleTools.map((tool) => tool.name)).toEqual([
      'alembic_codex_status',
      'alembic_codex_diagnostics',
      'alembic_codex_init',
      'alembic_codex_ai_config',
      'alembic_codex_dashboard',
      'alembic_codex_bootstrap',
      'alembic_codex_rescan',
      'alembic_codex_job',
    ]);
  });

  test('exposes all Codex local tools and agent core tools when knowledge is usable', () => {
    const result = resolveCodexToolPolicy({
      coreTools,
      knowledge: knowledgeReady,
      tierName: 'agent',
      tierOrder,
    });
    const names = result.visibleTools.map((tool) => tool.name);

    expect(result.state).toBe('ready');
    expect(names).toEqual([...CODEX_LOCAL_TOOLS.map((tool) => tool.name), 'alembic_health']);
    expect(names).not.toContain('alembic_knowledge_lifecycle');
  });

  test('keeps admin tools hidden unless Codex admin opt-in is explicit', () => {
    const withoutOptIn = resolveCodexToolPolicy({
      adminEnabled: false,
      coreTools,
      knowledge: knowledgeReady,
      tierName: 'admin',
      tierOrder,
    });
    const withOptIn = resolveCodexToolPolicy({
      adminEnabled: true,
      coreTools,
      knowledge: knowledgeReady,
      tierName: 'admin',
      tierOrder,
    });

    expect(withoutOptIn.effectiveTier).toBe('agent');
    expect(withoutOptIn.visibleTools.map((tool) => tool.name)).not.toContain(
      'alembic_knowledge_lifecycle'
    );
    expect(withOptIn.effectiveTier).toBe('admin');
    expect(withOptIn.visibleTools.map((tool) => tool.name)).toContain(
      'alembic_knowledge_lifecycle'
    );
  });

  test('keeps cold-start tools visible while bootstrap is already running', () => {
    const result = resolveCodexToolPolicy({
      coreTools,
      knowledge: {
        ...initializedEmpty,
        jobs: {
          active: [
            {
              id: 'bootstrap_active',
              kind: 'bootstrap',
              status: 'running',
              updatedAt: '2026-05-12T00:01:00Z',
            },
          ],
          bootstrapRunning: true,
          jobsDir: '/tmp/jobs',
          jobsDirExists: true,
          latest: {
            id: 'bootstrap_active',
            kind: 'bootstrap',
            status: 'running',
            updatedAt: '2026-05-12T00:01:00Z',
          },
          latestTerminal: null,
          rescanRunning: false,
          running: true,
          total: 1,
        },
        status: 'bootstrap_running',
      },
      tierName: 'agent',
      tierOrder,
    });

    expect(result.state).toBe('bootstrap_running');
    expect(result.signals.map((signal) => signal.code)).toContain('CODEX_BOOTSTRAP_RUNNING');
    expect(result.visibleTools.map((tool) => tool.name)).toEqual([
      'alembic_codex_status',
      'alembic_codex_diagnostics',
      'alembic_codex_init',
      'alembic_codex_ai_config',
      'alembic_codex_dashboard',
      'alembic_codex_bootstrap',
      'alembic_codex_rescan',
      'alembic_codex_job',
    ]);
  });

  test('reports stale knowledge and vector skip without hiding agent tools', () => {
    const result = resolveCodexToolPolicy({
      coreTools,
      knowledge: {
        ...knowledgeReady,
        freshness: {
          checkedAt: '2026-05-12T00:02:00Z',
          latestJobAt: '2026-05-12T00:01:00Z',
          latestKnowledgeAt: '2026-05-10T00:00:00Z',
          reason: 'latest rescan job failed',
          stale: true,
          status: 'refresh_failed',
        },
        status: 'knowledge_stale',
        vector: {
          documentCount: 0,
          hnswIndexPath: '/tmp/vector_index.asvec',
          indexDir: '/tmp/index',
          jsonIndexPath: '/tmp/vector_index.json',
          memoryEmbeddingsPath: '/tmp/memory_embeddings.json',
          nonBlocking: true,
          ready: false,
          reason: 'semantic vector index is not built',
          skipped: true,
          status: 'missing',
          updatedAt: null,
        },
      },
      tierName: 'agent',
      tierOrder,
    });

    expect(result.state).toBe('ready_stale');
    expect(result.visibleTools.map((tool) => tool.name)).toContain('alembic_health');
    expect(result.signals.map((signal) => signal.code)).toEqual([
      'CODEX_KNOWLEDGE_REFRESH_FAILED',
      'CODEX_VECTOR_SKIPPED_NON_BLOCKING',
    ]);
  });

  test('reports stale daemon state without downgrading usable knowledge tools', () => {
    const result = resolveCodexToolPolicy({
      coreTools,
      daemon: {
        message: 'daemon pid is not alive',
        ready: false,
        status: 'stale',
      },
      knowledge: knowledgeReady,
      tierName: 'agent',
      tierOrder,
    });

    expect(result.state).toBe('daemon_stale');
    expect(result.visibleTools.map((tool) => tool.name)).toContain('alembic_health');
    expect(result.signals.map((signal) => signal.code)).toContain('CODEX_DAEMON_STALE');
  });

  test('reports stale SourceRefs as knowledge stale without hiding usable tools', () => {
    const result = resolveCodexToolPolicy({
      coreTools,
      knowledge: {
        ...knowledgeReady,
        freshness: {
          checkedAt: '2026-05-12T00:02:00Z',
          latestJobAt: null,
          latestKnowledgeAt: '2026-05-10T00:00:00Z',
          reason: '1 stale SourceRef(s) across 1 Recipe(s)',
          stale: true,
          status: 'source_refs_stale',
        },
        status: 'knowledge_stale',
      },
      tierName: 'agent',
      tierOrder,
    });

    expect(result.state).toBe('ready_stale');
    expect(result.visibleTools.map((tool) => tool.name)).toContain('alembic_health');
    expect(result.signals.map((signal) => signal.code)).toContain('CODEX_SOURCE_REFS_STALE');
  });
});
