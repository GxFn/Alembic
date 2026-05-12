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
  test('keeps uninitialized workspaces on diagnostics/status/init only', () => {
    const result = resolveCodexToolPolicy({
      coreTools,
      knowledge: notInitialized,
      tierName: 'agent',
      tierOrder,
    });

    expect(result.hiddenReason).toBe('CODEX_ALEMBIC_KNOWLEDGE_REQUIRED');
    expect(result.visibleTools.map((tool) => tool.name)).toEqual([
      'alembic_codex_status',
      'alembic_codex_diagnostics',
      'alembic_codex_init',
    ]);
  });

  test('exposes cold-start job tools after initialization and before usable knowledge', () => {
    const result = resolveCodexToolPolicy({
      coreTools,
      knowledge: initializedEmpty,
      tierName: 'agent',
      tierOrder,
    });

    expect(result.visibleTools.map((tool) => tool.name)).toEqual([
      'alembic_codex_status',
      'alembic_codex_diagnostics',
      'alembic_codex_init',
      'alembic_codex_bootstrap',
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
});
