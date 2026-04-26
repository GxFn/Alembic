import type { ToolCapabilityManifest } from '#tools/catalog/CapabilityManifest.js';

const SKILL_RISK = {
  sideEffect: false,
  dataAccess: 'project',
  writeScope: 'none',
  network: 'none',
  credentialAccess: 'none',
  requiresHumanConfirmation: 'never',
  owaspTags: ['prompt-injection'],
} satisfies ToolCapabilityManifest['risk'];

const SKILL_GOVERNANCE = {
  auditLevel: 'checkOnly',
  policyProfile: 'read',
  approvalPolicy: 'auto',
  allowedRoles: [
    'owner',
    'admin',
    'developer',
    'agent',
    'external_agent',
    'contributor',
    'visitor',
  ],
  allowInComposer: true,
  allowInRemoteMcp: true,
  allowInNonInteractive: true,
} satisfies ToolCapabilityManifest['governance'];

const SKILL_EXECUTION = {
  adapter: 'skill',
  timeoutMs: 5_000,
  maxOutputBytes: 128_000,
  abortMode: 'preStart',
  cachePolicy: 'session',
  concurrency: 'parallel-safe',
  artifactMode: 'inline',
} satisfies ToolCapabilityManifest['execution'];

export const SKILL_SEARCH_CAPABILITY: ToolCapabilityManifest = {
  id: 'skill_search',
  title: 'Skill Search',
  kind: 'skill',
  description: 'Search available Alembic Skill manifests by name, description, and trigger text.',
  owner: 'agent-platform',
  lifecycle: 'experimental',
  surfaces: ['runtime', 'mcp'],
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional search query.' },
      source: { type: 'string', enum: ['all', 'builtin', 'project'] },
    },
    required: [],
  },
  risk: SKILL_RISK,
  execution: SKILL_EXECUTION,
  governance: SKILL_GOVERNANCE,
  externalTrust: {
    source: 'skill',
    trusted: true,
    reason: 'Skill documents are loaded from local Alembic skill directories.',
    outputContainsUntrustedText: true,
  },
  evals: { required: false, cases: [] },
};

export const SKILL_LOAD_CAPABILITY: ToolCapabilityManifest = {
  id: 'skill_load',
  title: 'Skill Load',
  kind: 'skill',
  description: 'Load a Skill SKILL.md document, optionally narrowed to a markdown section.',
  owner: 'agent-platform',
  lifecycle: 'experimental',
  surfaces: ['runtime', 'mcp'],
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name.' },
      section: { type: 'string', description: 'Optional section title text to extract.' },
    },
    required: ['name'],
  },
  risk: SKILL_RISK,
  execution: SKILL_EXECUTION,
  governance: SKILL_GOVERNANCE,
  externalTrust: SKILL_SEARCH_CAPABILITY.externalTrust,
  evals: { required: false, cases: [] },
};

export const SKILL_LOAD_RESOURCE_CAPABILITY: ToolCapabilityManifest = {
  id: 'skill_load_resource',
  title: 'Skill Load Resource',
  kind: 'skill',
  description: 'Load a non-executable resource file from a Skill directory.',
  owner: 'agent-platform',
  lifecycle: 'experimental',
  surfaces: ['runtime', 'mcp'],
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name.' },
      resourcePath: {
        type: 'string',
        description: 'Relative path inside the Skill directory, such as references/RECIPES.md.',
      },
    },
    required: ['name', 'resourcePath'],
  },
  risk: SKILL_RISK,
  execution: SKILL_EXECUTION,
  governance: SKILL_GOVERNANCE,
  externalTrust: SKILL_SEARCH_CAPABILITY.externalTrust,
  evals: { required: false, cases: [] },
};

export const SKILL_VALIDATE_CAPABILITY: ToolCapabilityManifest = {
  id: 'skill_validate',
  title: 'Skill Validate',
  kind: 'skill',
  description: 'Validate Skill manifest/frontmatter fields without executing scripts or hooks.',
  owner: 'agent-platform',
  lifecycle: 'experimental',
  surfaces: ['runtime', 'mcp'],
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Optional Skill name. Omit to validate all skills.' },
      source: { type: 'string', enum: ['all', 'builtin', 'project'] },
    },
    required: [],
  },
  risk: SKILL_RISK,
  execution: SKILL_EXECUTION,
  governance: SKILL_GOVERNANCE,
  externalTrust: SKILL_SEARCH_CAPABILITY.externalTrust,
  evals: { required: false, cases: [] },
};

export const SKILL_CAPABILITY_MANIFESTS = [
  SKILL_SEARCH_CAPABILITY,
  SKILL_LOAD_CAPABILITY,
  SKILL_LOAD_RESOURCE_CAPABILITY,
  SKILL_VALIDATE_CAPABILITY,
];
