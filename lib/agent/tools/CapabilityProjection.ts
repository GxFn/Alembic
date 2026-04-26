import { CapabilityCatalog, type CapabilityListFilter } from './CapabilityCatalog.js';
import type {
  CapabilityAuditLevel,
  CapabilityPolicyProfile,
  ToolCapabilityManifest,
  ToolExecutionProfile,
  ToolGovernanceProfile,
  ToolRiskProfile,
} from './CapabilityManifest.js';
import type { ToolDefinition, ToolMetadata } from './ToolDefinition.js';

const DEFAULT_OWNER = 'core';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16_000;
const POLICY_PROFILE_RANK: Record<CapabilityPolicyProfile, number> = {
  read: 0,
  analysis: 1,
  write: 2,
  system: 3,
  admin: 4,
};
const CONFIRMATION_RANK: Record<ToolRiskProfile['requiresHumanConfirmation'], number> = {
  never: 0,
  'on-risk': 1,
  always: 2,
};

const HTTP_DIRECT_TOOL_NAMES = new Set([
  'search_project_code',
  'read_project_file',
  'list_project_structure',
  'get_file_summary',
  'semantic_search_code',
  'search_recipes',
  'search_candidates',
  'get_recipe_detail',
  'get_project_stats',
  'search_knowledge',
  'get_related_recipes',
  'list_guard_rules',
  'get_recommendations',
  'guard_check_code',
  'query_violations',
  'check_duplicate',
  'quality_score',
  'validate_candidate',
  'get_feedback_stats',
  'graph_impact_analysis',
  'query_audit_log',
  'load_skill',
  'suggest_skills',
  'analyze_code',
  'knowledge_overview',
  'get_tool_details',
  'plan_task',
  'review_my_output',
  'get_project_overview',
  'get_class_hierarchy',
  'get_class_info',
  'get_protocol_info',
  'get_method_overrides',
  'get_category_map',
  'get_previous_analysis',
  'get_previous_evidence',
  'query_code_graph',
  'query_call_graph',
  'get_environment_info',
]);

const SIDE_EFFECT_TOOL_NAMES = new Set([
  'write_project_file',
  'submit_knowledge',
  'submit_with_check',
  'approve_candidate',
  'reject_candidate',
  'publish_recipe',
  'deprecate_recipe',
  'update_recipe',
  'record_usage',
  'add_graph_edge',
  'rebuild_index',
  'create_skill',
  'bootstrap_knowledge',
  'enrich_candidate',
  'refine_bootstrap_candidates',
  'note_finding',
  'collect_scan_recipe',
  'propose_evolution',
  'confirm_deprecation',
  'skip_evolution',
]);

const TOOL_GATEWAY_METADATA = new Map<
  string,
  Pick<ToolMetadata, 'gatewayAction' | 'gatewayResource'>
>([
  ['search_project_code', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['read_project_file', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['list_project_structure', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['get_file_summary', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['semantic_search_code', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['search_recipes', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['get_recipe_detail', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['get_project_stats', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['search_knowledge', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['get_related_recipes', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['check_duplicate', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['quality_score', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['get_feedback_stats', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['graph_impact_analysis', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['knowledge_overview', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['get_recommendations', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['search_candidates', { gatewayAction: 'read:candidates', gatewayResource: 'candidates' }],
  ['list_guard_rules', { gatewayAction: 'read:guard_rules', gatewayResource: 'guard_rules' }],
  ['query_violations', { gatewayAction: 'read:guard_rules', gatewayResource: 'guard_rules' }],
  ['guard_check_code', { gatewayAction: 'guard_rule:check_code', gatewayResource: 'guard_rules' }],
  ['query_audit_log', { gatewayAction: 'read:audit_logs', gatewayResource: '/audit_logs/self' }],
  ['load_skill', { gatewayAction: 'read:skills', gatewayResource: 'skills' }],
  ['suggest_skills', { gatewayAction: 'read:skills', gatewayResource: 'skills' }],
  ['get_tool_details', { gatewayAction: 'read:agent_tools', gatewayResource: 'agent_tools' }],
  ['plan_task', { gatewayAction: 'read:agent_tools', gatewayResource: 'agent_tools' }],
  ['review_my_output', { gatewayAction: 'read:agent_tools', gatewayResource: 'agent_tools' }],
  ['validate_candidate', { gatewayAction: 'validate:candidates', gatewayResource: 'candidates' }],
  ['analyze_code', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['get_project_overview', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['get_class_hierarchy', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['get_class_info', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['get_protocol_info', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['get_method_overrides', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['get_category_map', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['get_previous_analysis', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['get_previous_evidence', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['query_code_graph', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['query_call_graph', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['get_environment_info', { gatewayAction: 'read:environment', gatewayResource: 'environment' }],
]);

const TOOL_POLICY_PROFILES = new Map<string, CapabilityPolicyProfile>([
  ['write_project_file', 'write'],
  ['rebuild_index', 'admin'],
  ['bootstrap_knowledge', 'admin'],
  ['create_skill', 'write'],
  ['guard_check_code', 'analysis'],
  ['validate_candidate', 'analysis'],
  ['analyze_code', 'analysis'],
  ['plan_task', 'analysis'],
  ['review_my_output', 'analysis'],
]);

const TOOL_ABORT_MODES = new Map<string, ToolExecutionProfile['abortMode']>([
  ['search_project_code', 'cooperative'],
  ['semantic_search_code', 'cooperative'],
  ['list_project_structure', 'cooperative'],
  ['guard_check_code', 'cooperative'],
  ['rebuild_index', 'cooperative'],
  ['bootstrap_knowledge', 'cooperative'],
]);

const NON_COMPOSABLE_TOOL_NAMES = new Set([
  'get_tool_details',
  'plan_task',
  'review_my_output',
  'get_environment_info',
]);

export interface InternalCapabilityBuild {
  tools: ToolDefinition[];
  manifests: ToolCapabilityManifest[];
  catalog: CapabilityCatalog;
}

export function buildInternalToolCapabilities(tools: ToolDefinition[]): InternalCapabilityBuild {
  const enrichedTools = tools.map(withToolCapabilityMetadata);
  const manifests = enrichedTools.map(createInternalToolManifest);
  return {
    tools: enrichedTools,
    manifests,
    catalog: new CapabilityCatalog(manifests),
  };
}

export function createCapabilityCatalog(
  manifests: ToolCapabilityManifest[],
  filter: CapabilityListFilter = {}
) {
  return new CapabilityCatalog(manifests.filter((manifest) => matchesFilter(manifest, filter)));
}

export function withToolCapabilityMetadata(tool: ToolDefinition): ToolDefinition {
  const gatewayMetadata = TOOL_GATEWAY_METADATA.get(tool.name) || {};
  const directCallable = HTTP_DIRECT_TOOL_NAMES.has(tool.name);
  const sideEffect = SIDE_EFFECT_TOOL_NAMES.has(tool.name) || tool.metadata?.sideEffect === true;
  const declaredComposable = tool.metadata?.composable ?? !NON_COMPOSABLE_TOOL_NAMES.has(tool.name);
  const metadata: ToolMetadata = {
    ...(tool.metadata || {}),
    ...gatewayMetadata,
    surface: inferSurface(tool, directCallable),
    directCallable,
    sideEffect,
    composable: !sideEffect && declaredComposable,
    policyProfile: resolvePolicyProfile(tool.name, sideEffect, tool.metadata?.policyProfile),
    auditLevel: resolveAuditLevel(gatewayMetadata, sideEffect, tool.metadata?.auditLevel),
    abortMode: resolveAbortMode(tool.name, sideEffect, tool.metadata?.abortMode),
  };
  return { ...tool, metadata };
}

export function createInternalToolManifest(tool: ToolDefinition): ToolCapabilityManifest {
  const metadata = withToolCapabilityMetadata(tool).metadata as Required<ToolMetadata>;
  return {
    id: tool.name,
    title: titleFromToolName(tool.name),
    kind: 'internal-tool',
    description: tool.description,
    owner: metadata.owner || DEFAULT_OWNER,
    lifecycle: metadata.lifecycle || 'active',
    surfaces: metadata.surface,
    inputSchema: tool.parameters || {},
    risk: inferRiskProfile(tool.name, metadata),
    execution: inferExecutionProfile(tool.name, metadata),
    governance: inferGovernanceProfile(metadata),
    evals: {
      required: metadata.sideEffect || metadata.policyProfile !== 'read',
      cases: [],
    },
  };
}

function matchesFilter(manifest: ToolCapabilityManifest, filter: CapabilityListFilter) {
  if (filter.lifecycle && manifest.lifecycle !== filter.lifecycle) {
    return false;
  }
  if (filter.surface && !manifest.surfaces.includes(filter.surface)) {
    return false;
  }
  if (filter.ids && !filter.ids.includes(manifest.id)) {
    return false;
  }
  return true;
}

function inferPolicyProfile(toolName: string, sideEffect: boolean): CapabilityPolicyProfile {
  const explicit = TOOL_POLICY_PROFILES.get(toolName);
  if (explicit) {
    return explicit;
  }
  return sideEffect ? 'write' : 'read';
}

function resolvePolicyProfile(
  toolName: string,
  sideEffect: boolean,
  declared: CapabilityPolicyProfile | undefined
): CapabilityPolicyProfile {
  const inferred = inferPolicyProfile(toolName, sideEffect);
  if (!declared) {
    return inferred;
  }
  if (!sideEffect) {
    return declared;
  }
  return POLICY_PROFILE_RANK[declared] < POLICY_PROFILE_RANK.write ? 'write' : declared;
}

function inferSurface(tool: ToolDefinition, directCallable: boolean): ToolMetadata['surface'] {
  if (tool.metadata?.surface) {
    return tool.metadata.surface;
  }
  return directCallable ? ['runtime', 'http'] : ['runtime'];
}

function inferAuditLevel(
  gatewayMetadata: Pick<ToolMetadata, 'gatewayAction' | 'gatewayResource'>,
  sideEffect: boolean
): CapabilityAuditLevel {
  if (sideEffect) {
    return 'full';
  }
  return gatewayMetadata.gatewayAction ? 'checkOnly' : 'none';
}

function resolveAuditLevel(
  gatewayMetadata: Pick<ToolMetadata, 'gatewayAction' | 'gatewayResource'>,
  sideEffect: boolean,
  declared: CapabilityAuditLevel | undefined
): CapabilityAuditLevel {
  if (sideEffect) {
    return 'full';
  }
  return declared ?? inferAuditLevel(gatewayMetadata, sideEffect);
}

function resolveAbortMode(
  toolName: string,
  sideEffect: boolean,
  declared: ToolExecutionProfile['abortMode'] | undefined
): ToolExecutionProfile['abortMode'] {
  const forcedMode = TOOL_ABORT_MODES.get(toolName);
  if (forcedMode) {
    return forcedMode;
  }
  if (sideEffect && (!declared || declared === 'none')) {
    return 'preStart';
  }
  return declared || 'none';
}

function inferRiskProfile(toolName: string, metadata: Required<ToolMetadata>): ToolRiskProfile {
  const systemAccess = metadata.policyProfile === 'system';
  const writesProject =
    !systemAccess &&
    (POLICY_PROFILE_RANK[metadata.policyProfile] >= POLICY_PROFILE_RANK.write ||
      toolName === 'write_project_file');
  const inferred: ToolRiskProfile = {
    sideEffect: metadata.sideEffect,
    dataAccess: inferDataAccess(metadata.gatewayResource, systemAccess),
    writeScope: systemAccess ? 'system' : writesProject ? 'project' : 'none',
    network: systemAccess ? 'allowlisted' : 'none',
    credentialAccess: 'none',
    requiresHumanConfirmation: metadata.sideEffect ? 'on-risk' : 'never',
    owaspTags: inferOwaspTags(metadata.sideEffect, systemAccess),
  };
  return mergeRiskProfile(inferred, metadata.risk || {});
}

function mergeRiskProfile(
  inferred: ToolRiskProfile,
  override: Partial<Omit<ToolRiskProfile, 'sideEffect'>>
): ToolRiskProfile {
  const merged: ToolRiskProfile = {
    ...inferred,
    ...override,
    sideEffect: inferred.sideEffect,
  };
  if (!inferred.sideEffect) {
    return merged;
  }
  return {
    ...merged,
    writeScope:
      inferred.writeScope !== 'none' && merged.writeScope === 'none'
        ? inferred.writeScope
        : merged.writeScope,
    requiresHumanConfirmation:
      CONFIRMATION_RANK[merged.requiresHumanConfirmation] <
      CONFIRMATION_RANK[inferred.requiresHumanConfirmation]
        ? inferred.requiresHumanConfirmation
        : merged.requiresHumanConfirmation,
  };
}

function inferExecutionProfile(
  toolName: string,
  metadata: Required<ToolMetadata>
): ToolExecutionProfile {
  return {
    adapter: 'internal',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    abortMode: metadata.abortMode || 'none',
    cachePolicy: metadata.sideEffect ? 'none' : 'session',
    concurrency: metadata.sideEffect ? 'single' : 'parallel-safe',
    artifactMode: 'inline',
  };
}

function inferGovernanceProfile(metadata: Required<ToolMetadata>): ToolGovernanceProfile {
  return {
    gatewayAction: metadata.gatewayAction,
    gatewayResource: metadata.gatewayResource,
    auditLevel: metadata.auditLevel,
    policyProfile: metadata.policyProfile,
    approvalPolicy: metadata.sideEffect ? 'explain-then-run' : 'auto',
    allowedRoles: ['owner', 'admin', 'developer', 'external_agent'],
    allowInComposer: metadata.composable,
    allowInRemoteMcp: metadata.surface.includes('mcp') && !metadata.sideEffect,
    allowInNonInteractive: !metadata.sideEffect,
  };
}

function inferDataAccess(gatewayResource: string | undefined, systemAccess: boolean) {
  if (systemAccess) {
    return 'workspace';
  }
  if (!gatewayResource) {
    return 'none';
  }
  if (gatewayResource === 'project') {
    return 'project';
  }
  if (gatewayResource.includes('audit')) {
    return 'workspace';
  }
  return 'workspace';
}

function inferOwaspTags(sideEffect: boolean, systemAccess: boolean): ToolRiskProfile['owaspTags'] {
  const tags: ToolRiskProfile['owaspTags'] = [];
  if (sideEffect) {
    tags.push('excessive-agency');
  }
  if (systemAccess) {
    tags.push('supply-chain', 'unbounded-consumption');
  }
  return tags;
}

function titleFromToolName(name: string) {
  return name
    .split('_')
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() || ''}${part.slice(1)}`)
    .join(' ');
}
