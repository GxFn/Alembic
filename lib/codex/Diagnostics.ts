import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonStatus } from '../daemon/DaemonSupervisor.js';
import type { GitDiffCheckpointStatus } from '../service/evolution/git-diff-checkpoint/index.js';
import { asString, CODEX_REQUIRED_SKILLS, loadCodexPluginRegistry } from './PluginRegistry.js';
import {
  buildCodexProjectRootRequiredMessage,
  type CodexProjectRootResolution,
  summarizeCodexProjectRootResolution,
} from './ProjectRootResolver.js';
import {
  ALEMBIC_PLUGIN_HOST_ENV,
  ALEMBIC_RUNTIME_MODE_ENV,
  ALEMBIC_RUNTIME_MODE_PLUGIN,
  CODEX_ADMIN_ENABLE_ENV,
  CODEX_DEFAULT_MCP_TIER,
  CODEX_MCP_MODE_ENV,
  CODEX_MCP_SHIM_ENV,
  CODEX_PLUGIN_HOST,
  CODEX_PLUGIN_NAME,
  type CodexRuntimeContext,
  resolveCodexRuntimeContext,
} from './RuntimeContext.js';

export interface CodexPluginDiagnostics {
  assets: { missing: string[]; ok: boolean; required: string[] };
  manifest: { ok: boolean; path: string; version: string | null };
  mcp: {
    adminDisabledByDefault: boolean;
    agentTierByDefault: boolean;
    binary: string | null;
    codexShimMode: boolean;
    command: string | null;
    embeddedRuntime: boolean;
    mcpMode: boolean;
    ok: boolean;
    packagePin: boolean;
    path: string;
    pluginHost: boolean;
    pluginHostValue: string | null;
    pinnedSpecifier: string | null;
    runtimeMode: boolean;
    runtimeModeValue: string | null;
    runtimeSpecifier: string | null;
    wrapper: {
      exists: boolean;
      path: string | null;
      startupLock: boolean;
    };
  };
  ok: boolean;
  readme: {
    mentionsEmbeddedRuntime: boolean;
    mentionsPinnedRuntime: boolean;
    ok: boolean;
    path: string;
  };
  root: string;
  skills: { missing: string[]; ok: boolean; required: string[] };
}

export interface CodexRuntimeDiagnosticsOptions {
  autoInit?: Record<string, unknown>;
  projectRootResolution?: CodexProjectRootResolution;
}

export interface CodexDiagnosticIssue {
  action: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export function buildCodexRuntimeDiagnostics(
  daemonStatus: DaemonStatus,
  context: CodexRuntimeContext = resolveCodexRuntimeContext(),
  options: CodexRuntimeDiagnosticsOptions = {}
): Record<string, unknown> {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] || '0', 10);
  const npm = probeCommand('npm');
  const npx = probeCommand('npx');
  const npmAvailable = npm.available === true;
  const npxAvailable = npx.available === true;
  const plugin = buildCodexPluginDiagnostics(context);
  const checks = {
    adminGate: context.requestedTier !== 'admin' || context.adminEnabled,
    node: nodeMajor >= 22,
    npm: npmAvailable,
    npx: npxAvailable,
    runtimeMode: context.runtimeMode === context.expectedRuntimeMode,
    runtimePluginHost: context.pluginHost === context.expectedPluginHost,
    embeddedRuntime: plugin.mcp.embeddedRuntime,
    packagePin: plugin.mcp.packagePin,
    pluginHost: plugin.mcp.pluginHost,
    pluginRuntimeMode: plugin.mcp.runtimeMode,
    pluginAssets: plugin.assets.ok,
    pluginManifest: plugin.manifest.ok,
    pluginMcp: plugin.mcp.ok,
    pluginSkills: plugin.skills.ok,
    projectRoot:
      !options.projectRootResolution || options.projectRootResolution.trust === 'trusted',
  };
  const issues = buildDiagnosticIssues({
    adminEnabled: context.adminEnabled,
    checks,
    npm,
    npx,
    packageVersion: context.packageVersion,
    pluginHost: context.pluginHost,
    plugin,
    projectRootResolution: options.projectRootResolution,
    requestedTier: context.requestedTier,
    runtimeMode: context.runtimeMode,
  });

  return {
    ok: Object.values(checks).every(Boolean),
    summary: buildDiagnosticSummary(issues),
    checks,
    issues,
    nextActions: buildDiagnosticNextActions(issues),
    primaryAction:
      issues.length === 0
        ? buildRecommendedAction({
            label: 'Check workspace status',
            reason: 'Runtime checks passed; inspect project initialization and daemon state next.',
            startsDaemon: false,
            tool: 'alembic_codex_status',
          })
        : buildRecommendedAction({
            label: 'Fix diagnostics',
            reason: 'Resolve the reported runtime or plugin metadata issue before using Alembic.',
            startsDaemon: false,
            tool: 'alembic_codex_diagnostics',
          }),
    node: {
      ok: checks.node,
      required: '>=22',
      recommended: '22 LTS',
      version: process.versions.node,
      execPath: process.execPath,
      modules: process.versions.modules,
    },
    commands: {
      npm,
      npx,
    },
    package: {
      name: context.runtimePackage,
      version: context.packageVersion,
      embeddedRuntime: plugin.mcp.embeddedRuntime,
      runtimeSpecifier: context.embeddedRuntimeSpecifier,
      pinnedSpecifier: context.pinnedRuntimeSpecifier,
      mcpBinary: context.runtimeBin,
    },
    projectRootResolution: options.projectRootResolution
      ? summarizeCodexProjectRootResolution(options.projectRootResolution)
      : null,
    autoInit: options.autoInit || null,
    gitDiffCheckpoint: readHealthGitDiffCheckpoint(daemonStatus.health),
    plugin,
    daemon: {
      ready: daemonStatus.ready,
      status: daemonStatus.status,
      stateVersion: daemonStatus.state?.version || null,
      healthVersion: readHealthVersion(daemonStatus.health),
    },
    codex: {
      channelId: context.channelId,
      expectedChannelId: context.expectedChannelId,
      pluginHost: context.pluginHost,
      runtimeMode: context.runtimeMode,
      requestedTier: context.requestedTier,
      effectiveTier: context.effectiveTier,
      adminEnabled: context.adminEnabled,
      adminMode: context.adminEnabled
        ? `enabled-by-${CODEX_ADMIN_ENABLE_ENV}`
        : `disabled-requires-${CODEX_ADMIN_ENABLE_ENV}=1`,
    },
    runtimeIdentity: {
      mode: context.runtimeMode,
      expectedMode: context.expectedRuntimeMode,
      pluginHost: context.pluginHost,
      expectedPluginHost: context.expectedPluginHost,
      isPluginRuntime: context.runtimeMode === ALEMBIC_RUNTIME_MODE_PLUGIN,
      env: {
        mode: ALEMBIC_RUNTIME_MODE_ENV,
        pluginHost: ALEMBIC_PLUGIN_HOST_ENV,
        channelId: 'ALEMBIC_CHANNEL_ID',
      },
    },
    offlineFallback: {
      note: 'The Codex plugin ships Alembic runtime code in ./runtime and starts MCP through ./bin/alembic-codex-mcp-wrapper.mjs. The wrapper invokes npx against ./runtime.tgz with a plugin-specific npm cache and startup lock.',
      globalInstall: `npm install -g ${context.pinnedRuntimeSpecifier}`,
      localPackage: context.embeddedRuntimeSpecifier,
      command: context.runtimeBin,
    },
    cleanup: {
      automaticOnUninstall: false,
      command: 'alembic_codex_cleanup',
      defaultMode: 'dry-run',
    },
  };
}

export function buildCodexPluginDiagnostics(
  context: CodexRuntimeContext = resolveCodexRuntimeContext()
): CodexPluginDiagnostics {
  const registry = loadCodexPluginRegistry(context);
  const args = registry.mcp.args;
  const packageIndex = args.indexOf('--package');
  const runtimeSpecifier = packageIndex >= 0 ? args[packageIndex + 1] || null : null;
  const command =
    typeof registry.mcp.server?.command === 'string' ? registry.mcp.server.command : null;
  const wrapperArg = args.find((arg) => arg.endsWith('alembic-codex-mcp-wrapper.mjs')) || null;
  const wrapperPath = wrapperArg
    ? join(registry.plugin.root, wrapperArg.replace(/^\.\//, ''))
    : null;
  const wrapperSource =
    wrapperPath && existsSync(wrapperPath) ? readFileSync(wrapperPath, 'utf8') : '';
  const wrapperUsesRuntime =
    wrapperSource.includes('npx') &&
    wrapperSource.includes('--package') &&
    wrapperSource.includes(context.embeddedRuntimeSpecifier) &&
    wrapperSource.includes(context.runtimeBin);
  const wrapperUsesStartupLock =
    wrapperSource.includes('lockDir') && wrapperSource.includes('npm_config_cache');
  const binary =
    args.find((arg) => arg === context.runtimeBin) ||
    (wrapperUsesRuntime ? context.runtimeBin : null);
  const embeddedRuntime =
    command === 'node' &&
    wrapperUsesRuntime &&
    wrapperUsesStartupLock &&
    binary === context.runtimeBin &&
    !args.includes('latest');
  const packagePin = embeddedRuntime;
  const adminDisabledByDefault = registry.mcp.env?.[CODEX_ADMIN_ENABLE_ENV] === '0';
  const agentTierByDefault = registry.mcp.env?.ALEMBIC_MCP_TIER === CODEX_DEFAULT_MCP_TIER;
  const pluginHostValue =
    typeof registry.mcp.env?.[ALEMBIC_PLUGIN_HOST_ENV] === 'string'
      ? registry.mcp.env[ALEMBIC_PLUGIN_HOST_ENV]
      : null;
  const runtimeModeValue =
    typeof registry.mcp.env?.[ALEMBIC_RUNTIME_MODE_ENV] === 'string'
      ? registry.mcp.env[ALEMBIC_RUNTIME_MODE_ENV]
      : null;
  const pluginHost = pluginHostValue === CODEX_PLUGIN_HOST;
  const runtimeMode = runtimeModeValue === ALEMBIC_RUNTIME_MODE_PLUGIN;
  const mcpMode = registry.mcp.env?.[CODEX_MCP_MODE_ENV] === '1';
  const codexShimMode = registry.mcp.env?.[CODEX_MCP_SHIM_ENV] === '1';
  const missingAssets = registry.plugin.assets.filter(
    (asset) => !existsSync(join(registry.plugin.root, asset))
  );
  const requiredSkills = [...CODEX_REQUIRED_SKILLS];
  const missingSkills = requiredSkills.filter(
    (skill) => !existsSync(join(registry.plugin.root, 'skills', skill, 'SKILL.md'))
  );
  const mentionsEmbeddedRuntime = registry.plugin.readme.includes(context.embeddedRuntimeSpecifier);
  const mentionsPinnedRuntime = registry.plugin.readme.includes(context.pinnedRuntimeSpecifier);
  const readmeOk = mentionsEmbeddedRuntime && mentionsPinnedRuntime;

  return {
    assets: {
      missing: missingAssets,
      ok: registry.plugin.assets.length > 0 && missingAssets.length === 0,
      required: registry.plugin.assets,
    },
    manifest: {
      ok:
        registry.plugin.manifest.ok &&
        asString(registry.plugin.manifest.value?.name) === CODEX_PLUGIN_NAME,
      path: registry.plugin.manifest.path,
      version: asString(registry.plugin.manifest.value?.version) || null,
    },
    mcp: {
      adminDisabledByDefault,
      agentTierByDefault,
      binary,
      codexShimMode,
      command,
      embeddedRuntime,
      mcpMode,
      ok:
        embeddedRuntime &&
        adminDisabledByDefault &&
        agentTierByDefault &&
        pluginHost &&
        runtimeMode &&
        mcpMode &&
        codexShimMode,
      packagePin,
      path: registry.mcp.json.path,
      pluginHost,
      pluginHostValue,
      pinnedSpecifier: context.embeddedRuntimeSpecifier,
      runtimeMode,
      runtimeModeValue,
      runtimeSpecifier: runtimeSpecifier || context.embeddedRuntimeSpecifier,
      wrapper: {
        exists: Boolean(wrapperPath && existsSync(wrapperPath)),
        path: wrapperPath,
        startupLock: wrapperUsesStartupLock,
      },
    },
    ok:
      registry.plugin.manifest.ok &&
      embeddedRuntime &&
      adminDisabledByDefault &&
      agentTierByDefault &&
      pluginHost &&
      runtimeMode &&
      mcpMode &&
      codexShimMode &&
      missingAssets.length === 0 &&
      missingSkills.length === 0 &&
      readmeOk,
    readme: {
      mentionsEmbeddedRuntime,
      mentionsPinnedRuntime,
      ok: readmeOk,
      path: registry.plugin.readmePath,
    },
    root: registry.plugin.root,
    skills: {
      missing: missingSkills,
      ok: missingSkills.length === 0,
      required: requiredSkills,
    },
  };
}

function buildDiagnosticIssues(input: {
  adminEnabled: boolean;
  checks: Record<string, boolean>;
  npm: Record<string, unknown>;
  npx: Record<string, unknown>;
  packageVersion: string;
  pluginHost: string;
  plugin: CodexPluginDiagnostics;
  projectRootResolution?: CodexProjectRootResolution;
  requestedTier: string;
  runtimeMode: string;
}): CodexDiagnosticIssue[] {
  const issues: CodexDiagnosticIssue[] = [];
  if (input.projectRootResolution && input.projectRootResolution.trust !== 'trusted') {
    const rejected = input.projectRootResolution.trust === 'rejected';
    issues.push({
      action:
        'Pass the current workspace directory as the projectRoot argument, then rerun the Alembic tool.',
      code: rejected ? 'CODEX_PROJECT_ROOT_REJECTED' : 'CODEX_PROJECT_ROOT_UNRESOLVED',
      message: buildCodexProjectRootRequiredMessage(input.projectRootResolution),
      severity: 'error',
    });
  }
  if (!input.checks.node) {
    issues.push({
      action:
        'Install Node.js 22 LTS or newer, then restart Codex. Keep MCP and daemon on the same Node executable.',
      code: 'NODE_VERSION_UNSUPPORTED',
      message: `Alembic Codex requires Node.js >=22; current runtime is ${process.versions.node}.`,
      severity: 'error',
    });
  }
  if (!input.checks.npm) {
    issues.push({
      action: 'Install npm or use a Node.js distribution that includes npm.',
      code: 'NPM_UNAVAILABLE',
      message: String(input.npm.error || 'npm is not available.'),
      severity: 'error',
    });
  }
  if (!input.checks.npx) {
    issues.push({
      action: `Install npm/npx support, or install the fallback runtime globally with npm install -g alembic-ai@${input.packageVersion}.`,
      code: 'NPX_UNAVAILABLE',
      message: String(input.npx.error || 'npx is not available.'),
      severity: 'error',
    });
  }
  if (!input.checks.runtimeMode || !input.checks.runtimePluginHost) {
    issues.push({
      action: 'Start Alembic Codex with ALEMBIC_RUNTIME_MODE=plugin and ALEMBIC_PLUGIN_HOST=codex.',
      code: 'RUNTIME_IDENTITY_MISMATCH',
      message: `Current runtime identity is ALEMBIC_RUNTIME_MODE=${input.runtimeMode}, ALEMBIC_PLUGIN_HOST=${input.pluginHost}.`,
      severity: 'error',
    });
  }
  if (!input.checks.packagePin) {
    issues.push({
      action:
        'Update plugins/alembic-codex/.mcp.json to launch ./bin/alembic-codex-mcp-wrapper.mjs, then run npm run prepare:codex-plugin-runtime.',
      code: 'PLUGIN_RUNTIME_PIN_MISMATCH',
      message:
        'Codex plugin MCP config is not using the embedded Alembic runtime tarball from ./runtime.tgz.',
      severity: 'error',
    });
  }
  if (!input.checks.pluginMcp && input.checks.packagePin) {
    issues.push({
      action:
        'Restore plugins/alembic-codex/.mcp.json Codex env defaults: ALEMBIC_RUNTIME_MODE=plugin, ALEMBIC_PLUGIN_HOST=codex, ALEMBIC_MCP_MODE=1, ALEMBIC_CODEX_MCP_MODE=1, ALEMBIC_MCP_TIER=agent, ALEMBIC_CODEX_ENABLE_ADMIN=0.',
      code: 'PLUGIN_MCP_ENV_INCOMPLETE',
      message: 'Codex plugin MCP config is missing required Codex runtime environment defaults.',
      severity: 'error',
    });
  }
  if (!input.checks.pluginManifest || !input.plugin.readme.ok) {
    issues.push({
      action: 'Run npm run verify:codex-plugin and repair plugin metadata before publishing.',
      code: 'PLUGIN_METADATA_INCOMPLETE',
      message: 'Codex plugin manifest or README metadata is incomplete.',
      severity: 'error',
    });
  }
  if (!input.checks.pluginAssets || !input.checks.pluginSkills) {
    issues.push({
      action: 'Restore missing plugin assets or skills under plugins/alembic-codex.',
      code: 'PLUGIN_ASSETS_OR_SKILLS_MISSING',
      message: 'Codex plugin assets or skills are missing from the package.',
      severity: 'error',
    });
  }
  if (input.requestedTier === 'admin' && !input.adminEnabled) {
    issues.push({
      action: `Set ${CODEX_ADMIN_ENABLE_ENV}=1 only for explicit admin workflows.`,
      code: 'CODEX_ADMIN_OPT_IN_REQUIRED',
      message: 'Admin tier was requested, but the Codex-specific admin opt-in is disabled.',
      severity: 'warning',
    });
  }
  return issues;
}

function buildDiagnosticNextActions(issues: CodexDiagnosticIssue[]): string[] {
  if (issues.length === 0) {
    return ['Alembic Codex runtime checks passed.'];
  }
  return [...new Set(issues.map((issue) => issue.action))];
}

function buildDiagnosticSummary(issues: CodexDiagnosticIssue[]): string {
  if (issues.length === 0) {
    return 'Alembic Codex runtime checks passed. Continue with status, init, bootstrap, or priming.';
  }
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const parts = [];
  if (errorCount > 0) {
    parts.push(`${errorCount} error${errorCount === 1 ? '' : 's'}`);
  }
  if (warningCount > 0) {
    parts.push(`${warningCount} warning${warningCount === 1 ? '' : 's'}`);
  }
  return `Alembic Codex diagnostics found ${parts.join(' and ')}. Review issues before starting project knowledge workflows.`;
}

function buildRecommendedAction(input: {
  arguments?: Record<string, unknown>;
  label: string;
  reason: string;
  startsDaemon: boolean;
  tool: string;
}) {
  return {
    arguments: input.arguments || {},
    label: input.label,
    reason: input.reason,
    startsDaemon: input.startsDaemon,
    tool: input.tool,
  };
}

function probeCommand(command: string): Record<string, unknown> {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 2000,
  });
  const output = `${result.stdout || result.stderr || ''}`.trim();
  return {
    available: result.status === 0,
    version: result.status === 0 ? output : null,
    error:
      result.status === 0 ? null : result.error?.message || output || `Unable to run ${command}`,
  };
}

function readHealthVersion(health: Record<string, unknown> | null): string | null {
  const data = health?.data;
  if (!data || typeof data !== 'object') {
    return null;
  }
  const version = (data as { version?: unknown }).version;
  return typeof version === 'string' ? version : null;
}

function readHealthGitDiffCheckpoint(
  health: Record<string, unknown> | null
): GitDiffCheckpointStatus | null {
  const data = health?.data;
  if (!data || typeof data !== 'object') {
    return null;
  }
  const status = (data as { gitDiffCheckpoint?: unknown }).gitDiffCheckpoint;
  if (!status || typeof status !== 'object') {
    return null;
  }
  return status as GitDiffCheckpointStatus;
}
