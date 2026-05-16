import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  getCodexSavedProjectRootPath,
  readCodexInitMarker,
} from '../../lib/codex/ProjectRootResolver.js';
import {
  DAEMON_STATE_SCHEMA_VERSION,
  type DaemonState,
  getPackageVersion,
  resolveDaemonPaths,
} from '../../lib/daemon/DaemonState.js';
import type { DaemonStatus } from '../../lib/daemon/DaemonSupervisor.js';
import { JobStore } from '../../lib/daemon/JobStore.js';
import { CodexMcpServer, getVisibleCodexTools } from '../../lib/external/mcp/CodexMcpServer.js';
import { getGhostWorkspaceDir, ProjectRegistry } from '../../lib/shared/ProjectRegistry.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const ORIGINAL_ALEMBIC_PROJECT_DIR = process.env.ALEMBIC_PROJECT_DIR;
const ORIGINAL_CODEX_ENABLE_ADMIN = process.env.ALEMBIC_CODEX_ENABLE_ADMIN;
const ORIGINAL_CODEX_WORKSPACE_DIR = process.env.CODEX_WORKSPACE_DIR;
const ORIGINAL_CODEX_WORKSPACE_ROOT = process.env.CODEX_WORKSPACE_ROOT;
const ORIGINAL_DEEPSEEK_KEY = process.env.ALEMBIC_DEEPSEEK_API_KEY;
const ORIGINAL_INIT_CWD = process.env.INIT_CWD;
const ORIGINAL_MCP_TIER = process.env.ALEMBIC_MCP_TIER;
const ORIGINAL_PWD = process.env.PWD;
const ORIGINAL_PROVIDER = process.env.ALEMBIC_AI_PROVIDER;

function useTempAlembicHome(): string {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-codex-home-'));
  process.env.ALEMBIC_HOME = tempHome;
  return tempHome;
}

function makeProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-codex-project-'));
}

function makeInitializedWorkspace(projectRoot: string): void {
  fs.mkdirSync(path.join(projectRoot, '.asd'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.asd', 'config.json'), '{}\n');
  fs.writeFileSync(path.join(projectRoot, '.asd', 'alembic.db'), '');
  fs.mkdirSync(path.join(projectRoot, 'Alembic', 'recipes'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'Alembic', 'skills'), { recursive: true });
}

function makeUsableKnowledgeBase(projectRoot: string): void {
  makeInitializedWorkspace(projectRoot);
  fs.writeFileSync(
    path.join(projectRoot, 'Alembic', 'recipes', 'http-client.md'),
    '---\ntitle: HTTP Client\n---\nUse the project HTTP client.\n'
  );
}

function makeDaemonState(projectRoot: string, overrides: Partial<DaemonState> = {}): DaemonState {
  const paths = resolveDaemonPaths(projectRoot);
  return {
    schemaVersion: DAEMON_STATE_SCHEMA_VERSION,
    projectRoot: paths.projectRoot,
    dataRoot: paths.dataRoot,
    projectId: paths.projectId,
    pid: 12345,
    host: '127.0.0.1',
    port: 39127,
    url: 'http://127.0.0.1:39127',
    dashboardUrl: 'http://127.0.0.1:39127',
    token: 'test-token',
    version: getPackageVersion(),
    mode: 'daemon',
    startedAt: '2026-05-08T00:00:00.000Z',
    lastReadyAt: '2026-05-08T00:00:01.000Z',
    databasePath: path.join(paths.runtimeDir, 'alembic.db'),
    schemaMigrationVersion: '001',
    ...overrides,
  };
}

function makeDaemonStatus(
  projectRoot: string,
  overrides: Partial<DaemonStatus> = {}
): DaemonStatus {
  const paths = resolveDaemonPaths(projectRoot);
  const state = makeDaemonState(projectRoot);
  return {
    status: 'ready',
    ready: true,
    projectRoot: paths.projectRoot,
    dataRoot: paths.dataRoot,
    projectId: paths.projectId,
    statePath: paths.statePath,
    pidPath: paths.pidPath,
    lockDir: paths.lockDir,
    logPath: paths.logPath,
    state,
    pidAlive: true,
    health: null,
    ...overrides,
  };
}

function makeSupervisor(status: DaemonStatus) {
  return {
    status: vi.fn(async () => status),
    ensure: vi.fn(async () => status),
    stop: vi.fn(async () => ({ ...status, status: 'stopped' as const, ready: false, state: null })),
  };
}

afterEach(() => {
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
  if (ORIGINAL_CODEX_ENABLE_ADMIN === undefined) {
    delete process.env.ALEMBIC_CODEX_ENABLE_ADMIN;
  } else {
    process.env.ALEMBIC_CODEX_ENABLE_ADMIN = ORIGINAL_CODEX_ENABLE_ADMIN;
  }
  if (ORIGINAL_ALEMBIC_PROJECT_DIR === undefined) {
    delete process.env.ALEMBIC_PROJECT_DIR;
  } else {
    process.env.ALEMBIC_PROJECT_DIR = ORIGINAL_ALEMBIC_PROJECT_DIR;
  }
  if (ORIGINAL_CODEX_WORKSPACE_DIR === undefined) {
    delete process.env.CODEX_WORKSPACE_DIR;
  } else {
    process.env.CODEX_WORKSPACE_DIR = ORIGINAL_CODEX_WORKSPACE_DIR;
  }
  if (ORIGINAL_CODEX_WORKSPACE_ROOT === undefined) {
    delete process.env.CODEX_WORKSPACE_ROOT;
  } else {
    process.env.CODEX_WORKSPACE_ROOT = ORIGINAL_CODEX_WORKSPACE_ROOT;
  }
  if (ORIGINAL_INIT_CWD === undefined) {
    delete process.env.INIT_CWD;
  } else {
    process.env.INIT_CWD = ORIGINAL_INIT_CWD;
  }
  if (ORIGINAL_MCP_TIER === undefined) {
    delete process.env.ALEMBIC_MCP_TIER;
  } else {
    process.env.ALEMBIC_MCP_TIER = ORIGINAL_MCP_TIER;
  }
  if (ORIGINAL_PWD === undefined) {
    delete process.env.PWD;
  } else {
    process.env.PWD = ORIGINAL_PWD;
  }
  if (ORIGINAL_PROVIDER === undefined) {
    delete process.env.ALEMBIC_AI_PROVIDER;
  } else {
    process.env.ALEMBIC_AI_PROVIDER = ORIGINAL_PROVIDER;
  }
  if (ORIGINAL_DEEPSEEK_KEY === undefined) {
    delete process.env.ALEMBIC_DEEPSEEK_API_KEY;
  } else {
    process.env.ALEMBIC_DEEPSEEK_API_KEY = ORIGINAL_DEEPSEEK_KEY;
  }
  vi.restoreAllMocks();
});

describe('CodexMcpServer', () => {
  test('lists Codex local tools alongside agent-tier Alembic tools', () => {
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    const tools = getVisibleCodexTools('agent', projectRoot);
    const names = tools.map((tool) => tool.name);

    expect(names).toContain('alembic_codex_status');
    expect(names).toContain('alembic_codex_diagnostics');
    expect(names).toContain('alembic_codex_ai_config');
    expect(names).toContain('alembic_codex_dashboard');
    expect(names).toContain('alembic_codex_bootstrap');
    expect(names).toContain('alembic_codex_job');
    expect(names).toContain('alembic_codex_cleanup');
    expect(names).toContain('alembic_health');
    expect(names).not.toContain('alembic_knowledge_lifecycle');
  });

  test('exposes MCP tool annotations so clients can reduce approval prompts', () => {
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    const tools = getVisibleCodexTools('agent', projectRoot);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(tools.every((tool) => tool.annotations)).toBe(true);
    expect(byName.get('alembic_codex_status')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName.get('alembic_guard')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(byName.get('alembic_codex_bootstrap')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(byName.get('alembic_codex_cleanup')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  test('exposes cold-start and init-on-demand tools before workspace initialization', () => {
    const projectRoot = makeProjectRoot();
    const names = getVisibleCodexTools('agent', projectRoot).map((tool) => tool.name);

    expect(names).toEqual([
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

  test('exposes only cold-start tools when initialized workspace has no usable knowledge', () => {
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const names = getVisibleCodexTools('agent', projectRoot).map((tool) => tool.name);

    expect(names).toEqual([
      'alembic_codex_status',
      'alembic_codex_diagnostics',
      'alembic_codex_init',
      'alembic_codex_ai_config',
      'alembic_codex_dashboard',
      'alembic_codex_bootstrap',
      'alembic_codex_rescan',
      'alembic_codex_job',
    ]);
    expect(names).not.toContain('alembic_task');
    expect(names).not.toContain('alembic_health');
  });

  test('detects usable knowledge from the registered ghost data root', () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, true);
    const ghostRoot = getGhostWorkspaceDir(entry.id);
    makeInitializedWorkspace(ghostRoot);
    fs.mkdirSync(path.join(projectRoot, 'Alembic', 'recipes'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'Alembic', 'recipes', 'project-tree-should-not-count.md'),
      '# Ignored Project Tree Recipe\n'
    );

    expect(getVisibleCodexTools('agent', projectRoot).map((tool) => tool.name)).toEqual([
      'alembic_codex_status',
      'alembic_codex_diagnostics',
      'alembic_codex_init',
      'alembic_codex_ai_config',
      'alembic_codex_dashboard',
      'alembic_codex_bootstrap',
      'alembic_codex_rescan',
      'alembic_codex_job',
    ]);

    fs.writeFileSync(
      path.join(ghostRoot, 'Alembic', 'recipes', 'ghost-recipe.md'),
      '# Ghost Recipe\n'
    );

    const names = getVisibleCodexTools('agent', projectRoot).map((tool) => tool.name);

    expect(names).toContain('alembic_task');
    expect(names).toContain('alembic_health');
    expect(names).toContain('alembic_codex_dashboard');
  });

  test('requires a second Codex admin opt-in before exposing admin-tier tools', () => {
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    process.env.ALEMBIC_MCP_TIER = 'admin';
    delete process.env.ALEMBIC_CODEX_ENABLE_ADMIN;

    expect(getVisibleCodexTools(undefined, projectRoot).map((tool) => tool.name)).not.toContain(
      'alembic_knowledge_lifecycle'
    );

    process.env.ALEMBIC_CODEX_ENABLE_ADMIN = '1';

    expect(getVisibleCodexTools(undefined, projectRoot).map((tool) => tool.name)).toContain(
      'alembic_knowledge_lifecycle'
    );
  });

  test('status inspects workspace and daemon state without ensuring daemon startup', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
        message: 'daemon is not started',
      })
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_status', {})) as {
      success: boolean;
      data: {
        initialized: boolean;
        daemon: { ready: boolean };
        diagnostics: { node: { ok: boolean } };
        nextActions: string[];
        onboarding: {
          primaryAction: { startsDaemon: boolean; tool: string };
          state: string;
        };
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.initialized).toBe(false);
    expect(result.data.daemon.ready).toBe(false);
    expect(result.data.diagnostics.node.ok).toBe(true);
    expect(result.data.onboarding).toMatchObject({
      state: 'needs_init',
      primaryAction: { startsDaemon: false, tool: 'alembic_codex_init' },
    });
    expect(result.data.nextActions).toContain(
      'Initialize Ghost workspace: call alembic_codex_init'
    );
    expect(supervisor.status).toHaveBeenCalledTimes(1);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('tool-call projectRoot override scopes status to the requested project', async () => {
    useTempAlembicHome();
    delete process.env.ALEMBIC_PROJECT_DIR;
    delete process.env.CODEX_WORKSPACE_DIR;
    delete process.env.CODEX_WORKSPACE_ROOT;
    const pluginRoot = path.join(
      makeProjectRoot(),
      '.codex',
      'plugins',
      'cache',
      'alembic-codex',
      'alembic-codex',
      '0.1.2'
    );
    fs.mkdirSync(pluginRoot, { recursive: true });
    process.env.PWD = pluginRoot;

    const projectRoot = makeProjectRoot();
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ supervisor });

    const result = (await server.handleToolCall('alembic_codex_status', { projectRoot })) as {
      data: {
        projectRoot: string;
        projectRootResolution: { path: string; source: string; trust: string };
      };
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.data.projectRoot).toBe(projectRoot);
    expect(result.data.projectRootResolution).toMatchObject({
      path: projectRoot,
      source: 'explicit-option',
      trust: 'trusted',
    });
    expect(supervisor.status).toHaveBeenCalledWith(projectRoot);
  });

  test('tool-call projectRoot override saves the project root for later calls', async () => {
    useTempAlembicHome();
    delete process.env.ALEMBIC_PROJECT_DIR;
    delete process.env.CODEX_WORKSPACE_DIR;
    delete process.env.CODEX_WORKSPACE_ROOT;
    const pluginRoot = path.join(
      makeProjectRoot(),
      '.codex',
      'plugins',
      'cache',
      'alembic-codex',
      'alembic-codex',
      '0.1.2'
    );
    fs.mkdirSync(pluginRoot, { recursive: true });
    process.env.INIT_CWD = pluginRoot;
    process.env.PWD = pluginRoot;

    const projectRoot = makeProjectRoot();
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const firstServer = new CodexMcpServer({ supervisor });
    await firstServer.handleToolCall('alembic_codex_status', { projectRoot });

    const secondServer = new CodexMcpServer({ supervisor });
    const result = (await secondServer.handleToolCall('alembic_codex_status', {})) as {
      data: {
        projectRoot: string;
        projectRootResolution: { path: string; source: string; trust: string };
      };
      success: boolean;
    };

    expect(fs.existsSync(getCodexSavedProjectRootPath())).toBe(true);
    expect(result.success).toBe(true);
    expect(result.data.projectRoot).toBe(projectRoot);
    expect(result.data.projectRootResolution).toMatchObject({
      path: projectRoot,
      source: 'saved-project-root',
      trust: 'trusted',
    });
    expect(fs.existsSync(path.join(pluginRoot, '.asd'))).toBe(false);
  });

  test('status recommends bootstrap after initialization when knowledge is still empty', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_status', {})) as {
      success: boolean;
      data: {
        initialized: boolean;
        knowledge: { usable: boolean; recipeCount: number; skillCount: number };
        onboarding: { primaryAction: { tool: string }; state: string };
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.initialized).toBe(true);
    expect(result.data.knowledge).toMatchObject({ usable: false, recipeCount: 0, skillCount: 0 });
    expect(result.data.onboarding).toMatchObject({
      state: 'needs_bootstrap',
      primaryAction: { tool: 'alembic_codex_bootstrap' },
    });
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('explicit Codex init creates a Ghost workspace marker without starting daemon', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_init', {})) as {
      success: boolean;
      data: {
        status: {
          autoInit: { markerExists: boolean; route: string };
          initialized: boolean;
          workspace: { dataRoot: string; ghost: boolean };
        };
      };
    };
    const marker = readCodexInitMarker(projectRoot);

    expect(result.success).toBe(true);
    expect(result.data.status.initialized).toBe(true);
    expect(result.data.status.workspace.ghost).toBe(true);
    expect(result.data.status.autoInit).toMatchObject({
      markerExists: true,
      route: 'explicit',
    });
    expect(marker).toMatchObject({
      initializedBy: 'alembic_codex_init',
      route: 'explicit',
      projectRoot,
    });
    expect(fs.existsSync(path.join(projectRoot, '.asd'))).toBe(false);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('AI config status masks secrets and configure requires chat-secret confirmation', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const rejected = (await server.handleToolCall('alembic_codex_ai_config', {
      mode: 'configure',
      provider: 'deepseek',
      apiKey: 'secret-deepseek-key',
    })) as {
      data: { errorCode: string; needsUserInput: boolean };
      success: boolean;
    };

    expect(rejected.success).toBe(false);
    expect(rejected.data).toMatchObject({
      errorCode: 'CODEX_AI_SECRET_CONFIRMATION_REQUIRED',
      needsUserInput: true,
    });
    expect(readCodexInitMarker(projectRoot)).toBeNull();

    const configured = (await server.handleToolCall('alembic_codex_ai_config', {
      mode: 'configure',
      provider: 'deepseek',
      apiKey: 'secret-deepseek-key',
      confirmChatSecret: true,
    })) as {
      data: { aiConfig: { provider: string; ready: boolean; vars: Record<string, string> } };
      success: boolean;
    };
    const serialized = JSON.stringify(configured);

    expect(configured.success).toBe(true);
    expect(configured.data.aiConfig).toMatchObject({
      provider: 'deepseek',
      ready: true,
    });
    expect(configured.data.aiConfig.vars.ALEMBIC_DEEPSEEK_API_KEY).toBe('se...-key');
    expect(serialized).not.toContain('secret-deepseek-key');
    expect(readCodexInitMarker(projectRoot)).toMatchObject({
      initializedBy: 'codex-plugin-init-on-demand',
      requestedTool: 'alembic_codex_ai_config',
    });
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('init-on-demand initializes before reading Codex job status', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_job', { limit: 5 })) as {
      success: boolean;
      data: { jobs: unknown[] };
    };
    const marker = readCodexInitMarker(projectRoot);

    expect(result.success).toBe(true);
    expect(result.data.jobs).toEqual([]);
    expect(marker).toMatchObject({
      initializedBy: 'codex-plugin-init-on-demand',
      requestedTool: 'alembic_codex_job',
      route: 'tool-call',
    });
    expect(fs.existsSync(path.join(projectRoot, '.asd'))).toBe(false);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('tool-call projectRoot override sends init to the requested project', async () => {
    useTempAlembicHome();
    delete process.env.ALEMBIC_PROJECT_DIR;
    delete process.env.CODEX_WORKSPACE_DIR;
    delete process.env.CODEX_WORKSPACE_ROOT;
    const pluginRoot = path.join(
      makeProjectRoot(),
      '.codex',
      'plugins',
      'cache',
      'alembic-codex',
      'alembic-codex',
      '0.1.2'
    );
    fs.mkdirSync(pluginRoot, { recursive: true });
    process.env.PWD = pluginRoot;

    const projectRoot = makeProjectRoot();
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ supervisor });

    const result = (await server.handleToolCall('alembic_codex_init', { projectRoot })) as {
      data: { status: { initialized: boolean; workspace: { ghost: boolean } } };
      success: boolean;
    };
    const marker = readCodexInitMarker(projectRoot);

    expect(result.success).toBe(true);
    expect(result.data.status.workspace.ghost).toBe(true);
    expect(marker).toMatchObject({
      initializedBy: 'alembic_codex_init',
      projectRoot,
      route: 'explicit',
    });
    expect(fs.existsSync(path.join(pluginRoot, '.asd'))).toBe(false);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('status and diagnostics do not initialize a fresh workspace', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    await server.handleToolCall('alembic_codex_status', {});
    await server.handleToolCall('alembic_codex_diagnostics', {});

    expect(readCodexInitMarker(projectRoot)).toBeNull();
    expect(fs.existsSync(path.join(projectRoot, '.asd'))).toBe(false);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('manual init fails closed when only a plugin-cache fallback root is available', async () => {
    useTempAlembicHome();
    delete process.env.ALEMBIC_PROJECT_DIR;
    delete process.env.CODEX_WORKSPACE_DIR;
    delete process.env.CODEX_WORKSPACE_ROOT;
    delete process.env.INIT_CWD;
    const pluginRoot = path.join(
      makeProjectRoot(),
      '.codex',
      'plugins',
      'cache',
      'gxfn',
      'alembic-codex',
      '0.1.1'
    );
    fs.mkdirSync(pluginRoot, { recursive: true });
    process.env.PWD = pluginRoot;
    const supervisor = makeSupervisor(
      makeDaemonStatus(pluginRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ supervisor });

    const result = (await server.handleToolCall('alembic_codex_init', {})) as {
      data: {
        errorCode: string;
        needsUserInput: boolean;
        projectRootResolution: { trust: string; userMessage: string };
        required: { projectRoot: string };
        requiredActions: string[];
      };
      message: string;
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.message).toContain('cannot determine the target project directory');
    expect(result.data.errorCode).toBe('CODEX_PROJECT_ROOT_REJECTED');
    expect(result.data.needsUserInput).toBe(true);
    expect(result.data.required.projectRoot).toBe('absolute path');
    expect(result.data.requiredActions).toContain(
      'Provide the target project root as an absolute path.'
    );
    expect(result.data.projectRootResolution.trust).toBe('rejected');
    expect(result.data.projectRootResolution.userMessage).toContain(
      'project workflows cannot be used yet'
    );
    expect(fs.existsSync(path.join(pluginRoot, '.asd'))).toBe(false);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('unresolved Desktop project root exposes tools that require explicit projectRoot', async () => {
    useTempAlembicHome();
    delete process.env.ALEMBIC_PROJECT_DIR;
    delete process.env.CODEX_WORKSPACE_DIR;
    delete process.env.CODEX_WORKSPACE_ROOT;
    delete process.env.INIT_CWD;
    const pluginRoot = path.join(
      makeProjectRoot(),
      '.codex',
      'plugins',
      'cache',
      'alembic-codex',
      'alembic-codex',
      '0.1.2'
    );
    fs.mkdirSync(pluginRoot, { recursive: true });
    process.env.PWD = pluginRoot;

    const tools = getVisibleCodexTools('agent');
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const supervisor = makeSupervisor(
      makeDaemonStatus(pluginRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ supervisor });

    const result = (await server.handleToolCall('alembic_health', {})) as {
      data: { errorCode: string; needsUserInput: boolean; required: { projectRoot: string } };
      success: boolean;
    };

    expect(byName.has('alembic_task')).toBe(true);
    expect(byName.get('alembic_task')?.inputSchema?.properties).toMatchObject({
      projectRoot: {
        type: 'string',
      },
    });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      errorCode: 'CODEX_PROJECT_ROOT_REJECTED',
      needsUserInput: true,
      required: { projectRoot: 'absolute path' },
    });
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('diagnostics reports runtime version and offline fallback without starting daemon', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_diagnostics', {})) as {
      success: boolean;
      data: {
        cleanup: { automaticOnUninstall: boolean; command: string };
        checks: { packagePin: boolean; pluginAssets: boolean; pluginSkills: boolean };
        nextActions: string[];
        offlineFallback: { globalInstall: string };
        package: { pinnedSpecifier: string; version: string };
        plugin: { mcp: { ok: boolean; packagePin: boolean }; skills: { ok: boolean } };
        primaryAction: { tool: string };
        summary: string;
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.package.pinnedSpecifier).toBe(`alembic-ai@${getPackageVersion()}`);
    expect(result.data.checks).toMatchObject({
      packagePin: true,
      pluginAssets: true,
      pluginSkills: true,
    });
    expect(result.data.plugin.mcp).toMatchObject({ ok: true, packagePin: true });
    expect(result.data.plugin.skills.ok).toBe(true);
    expect(result.data.nextActions).toContain('Alembic Codex runtime checks passed.');
    expect(result.data.primaryAction.tool).toBe('alembic_codex_status');
    expect(result.data.summary).toContain('runtime checks passed');
    expect(result.data.offlineFallback.globalInstall).toBe(
      `npm install -g alembic-ai@${getPackageVersion()}`
    );
    expect(result.data.cleanup).toMatchObject({
      automaticOnUninstall: false,
      command: 'alembic_codex_cleanup',
    });
    expect(supervisor.status).toHaveBeenCalledTimes(1);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('diagnostics reports explicit admin opt-in guidance when admin tier is requested', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    process.env.ALEMBIC_MCP_TIER = 'admin';
    delete process.env.ALEMBIC_CODEX_ENABLE_ADMIN;
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_diagnostics', {})) as {
      success: boolean;
      data: {
        checks: { adminGate: boolean };
        issues: Array<{ code: string }>;
        nextActions: string[];
        ok: boolean;
        primaryAction: { tool: string };
        summary: string;
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.ok).toBe(false);
    expect(result.data.checks.adminGate).toBe(false);
    expect(result.data.issues.map((issue) => issue.code)).toContain('CODEX_ADMIN_OPT_IN_REQUIRED');
    expect(result.data.primaryAction.tool).toBe('alembic_codex_diagnostics');
    expect(result.data.summary).toContain('warning');
    expect(result.data.nextActions).toContain(
      'Set ALEMBIC_CODEX_ENABLE_ADMIN=1 only for explicit admin workflows.'
    );
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('core Alembic tools ensure daemon and forward through the local bridge token', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_input, _init) =>
        new Response(JSON.stringify({ ok: true, toolId: 'alembic_health', text: 'healthy' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = await server.handleToolCall('alembic_health', {});
    const [url, init] = fetchSpy.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true, toolId: 'alembic_health' });
    expect(supervisor.ensure).toHaveBeenCalledWith({ projectRoot, waitUntilReadyMs: 3000 });
    expect(String(url)).toBe('http://127.0.0.1:39127/api/v1/mcp/call');
    expect(headers['x-alembic-daemon-token']).toBe('test-token');
    expect(body).toMatchObject({ name: 'alembic_health', args: {} });
    expect(body.actor).toMatchObject({ role: 'external_agent' });
  });

  test('blocks project-knowledge tools when no usable knowledge base exists', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_health', {})) as {
      data: { errorCode?: string };
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.data.errorCode).toBe('CODEX_ALEMBIC_KNOWLEDGE_REQUIRED');
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('Codex bootstrap job fails closed when internal AI provider is missing', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    delete process.env.ALEMBIC_AI_PROVIDER;
    delete process.env.ALEMBIC_DEEPSEEK_API_KEY;
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_bootstrap', { maxFiles: 25 })) as {
      data: { errorCode: string; needsUserInput: boolean };
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      errorCode: 'AI_PROVIDER_REQUIRED',
      needsUserInput: true,
    });
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('Codex bootstrap job ensures daemon and posts to the daemon jobs API', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    process.env.ALEMBIC_AI_PROVIDER = 'deepseek';
    process.env.ALEMBIC_DEEPSEEK_API_KEY = 'test-deepseek-key';
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { jobId: 'bootstrap_test', job: { id: 'bootstrap_test' } },
          }),
          { status: 202, headers: { 'content-type': 'application/json' } }
        )
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = await server.handleToolCall('alembic_codex_bootstrap', { maxFiles: 25 });
    const [url, init] = fetchSpy.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

    expect(result).toMatchObject({ success: true, data: { jobId: 'bootstrap_test' } });
    expect(supervisor.ensure).toHaveBeenCalledWith({ projectRoot, waitUntilReadyMs: 3000 });
    expect(String(url)).toBe('http://127.0.0.1:39127/api/v1/jobs/bootstrap');
    expect(headers['x-alembic-daemon-token']).toBe('test-token');
    expect(body).toMatchObject({
      jobContext: {
        actor: { role: 'external_agent' },
        channelId: 'codex',
        client: 'codex-plugin',
        createdByTool: 'alembic_codex_bootstrap',
      },
      maxFiles: 25,
    });
    expect(typeof (body.jobContext as { sessionId?: unknown }).sessionId).toBe('string');
  });

  test('blocks direct admin tool calls without Codex admin opt-in', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    process.env.ALEMBIC_MCP_TIER = 'admin';
    delete process.env.ALEMBIC_CODEX_ENABLE_ADMIN;
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_knowledge_lifecycle', {
      operation: 'approve',
    })) as {
      data: { errorCode: string; needsUserInput: boolean };
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      errorCode: 'CODEX_ADMIN_OPT_IN_REQUIRED',
      needsUserInput: true,
    });
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('Codex job status reads local JobStore without starting daemon', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const store = new JobStore({ projectRoot });
    const job = store.create({ kind: 'rescan', request: { reason: 'codex' }, source: 'codex' });
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_job', { jobId: job.id })) as {
      success: boolean;
      data: { job: { id: string } };
    };

    expect(result.success).toBe(true);
    expect(result.data.job.id).toBe(job.id);
    expect(supervisor.status).toHaveBeenCalledTimes(1);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('Codex job status uses daemon jobs API when it is already running', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { job: { id: 'bootstrap_live', progress: { percent: 60 } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_job', {
      jobId: 'bootstrap_live',
    })) as {
      success: boolean;
      data: { job: { progress: { percent: number } } };
    };
    const [url, init] = fetchSpy.mock.calls[0];
    const headers = init?.headers as Record<string, string>;

    expect(result.success).toBe(true);
    expect(result.data.job.progress.percent).toBe(60);
    expect(String(url)).toBe('http://127.0.0.1:39127/api/v1/jobs/bootstrap_live');
    expect(headers['x-alembic-daemon-token']).toBe('test-token');
    expect(supervisor.ensure).not.toHaveBeenCalled();
    expect(supervisor.status).toHaveBeenCalledTimes(1);
  });

  test('Codex job status falls back to local JobStore when daemon job API is unavailable', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const store = new JobStore({ projectRoot });
    const job = store.create({ kind: 'bootstrap', request: { maxFiles: 25 }, source: 'codex' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection closed'));
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_job', { jobId: job.id })) as {
      success: boolean;
      data: { job: { id: string } };
    };

    expect(result.success).toBe(true);
    expect(result.data.job.id).toBe(job.id);
    expect(supervisor.ensure).not.toHaveBeenCalled();
    expect(supervisor.status).toHaveBeenCalledTimes(1);
  });

  test('cleanup defaults to dry-run and does not stop daemon', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_cleanup', {})) as {
      success: boolean;
      data: { dryRun: boolean; targets: { runtimeDir: string } };
    };

    expect(result.success).toBe(true);
    expect(result.data.dryRun).toBe(true);
    expect(result.data.targets.runtimeDir).toContain('.asd');
    expect(supervisor.stop).not.toHaveBeenCalled();
  });

  test('package and plugin config point Codex to the packaged MCP runtime tarball', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
      version: string;
      bin: Record<string, string>;
      scripts: Record<string, string>;
    };
    const pluginMcp = JSON.parse(
      fs.readFileSync(path.resolve('plugins/alembic-codex/.mcp.json'), 'utf8')
    ) as {
      mcpServers: {
        alembic: { args: string[]; command: string; cwd: string; env: Record<string, string> };
      };
    };
    const pluginJson = JSON.parse(
      fs.readFileSync(path.resolve('plugins/alembic-codex/.codex-plugin/plugin.json'), 'utf8')
    ) as { interface: { defaultPrompt: string[]; screenshots: string[] } };

    expect(packageJson.bin['alembic-codex-mcp']).toBe('dist/bin/codex-mcp.js');
    expect(packageJson.scripts['verify:codex-plugin']).toBe('node scripts/verify-codex-plugin.mjs');
    expect(pluginMcp.mcpServers.alembic.command).toBe('node');
    expect(pluginMcp.mcpServers.alembic.args).toContain('./bin/alembic-codex-mcp-wrapper.mjs');
    expect(
      fs
        .readFileSync(
          path.resolve('plugins/alembic-codex/bin/alembic-codex-mcp-wrapper.mjs'),
          'utf8'
        )
        .includes('./runtime.tgz')
    ).toBe(true);
    expect(pluginMcp.mcpServers.alembic.cwd).toBe('.');
    expect(pluginMcp.mcpServers.alembic.env.ALEMBIC_RUNTIME_MODE).toBe('plugin');
    expect(pluginMcp.mcpServers.alembic.env.ALEMBIC_PLUGIN_HOST).toBe('codex');
    expect(pluginMcp.mcpServers.alembic.env.ALEMBIC_MCP_MODE).toBe('1');
    expect(pluginMcp.mcpServers.alembic.env.ALEMBIC_CODEX_MCP_MODE).toBe('1');
    expect(pluginMcp.mcpServers.alembic.env.ALEMBIC_CODEX_PLUGIN_ROOT).toBe('.');
    expect(pluginMcp.mcpServers.alembic.env.ALEMBIC_CODEX_ENABLE_ADMIN).toBe('0');
    expect(pluginMcp.mcpServers.alembic.env.npm_config_cache).toBeUndefined();
    expect(pluginJson.interface.defaultPrompt).toContain(
      'Guide me through Alembic Codex first-minute setup for this project'
    );
    expect(pluginJson.interface.defaultPrompt).toContain(
      'Initialize Alembic Codex in Ghost mode for this project'
    );
    expect(pluginJson.interface.defaultPrompt).toContain(
      'Run Alembic Codex diagnostics for this project'
    );
    expect(pluginJson.interface.screenshots).toContain('./assets/alembic-codex-status.svg');
    expect(fs.existsSync(path.resolve('plugins/alembic-codex/skills/alembic/SKILL.md'))).toBe(true);
  });
});
