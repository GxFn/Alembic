/**
 * MCP Tool Definitions — V3 Consolidated (14 agent + 2 admin = 16 tools)
 *
 * Each tool declaration contains name, tier (agent/admin), description, and inputSchema.
 * description is the key for Agent tool selection — use bullet list to enumerate all operations and their purposes.
 * inputSchema is auto-generated from Zod Schema (zodToMcpSchema); parameter .describe() translates to JSON Schema description.
 *
 * Agent tools (14):
 *   1-7:   Query tools (health/search/knowledge/structure/graph/call_context/guard)
 *   8:     Write tool (submit_knowledge — unified pipeline, single/batch)
 *   9:     Skill management (skill)
 *   10-12: Cold-start (bootstrap/dimension_complete/wiki)
 *   13:    Project panorama (panorama)
 *   14:    Task management (task — 5 ops: prime/create/close/fail/record_decision)
 *
 * Admin tools (2):
 *   15-16: enrich_candidates/knowledge_lifecycle
 */

import {
  BootstrapInput,
  CallContextInput,
  DimensionCompleteInput,
  EnrichCandidatesInput,
  GraphInput,
  GuardInput,
  HealthInput,
  KnowledgeInput,
  KnowledgeLifecycleInput,
  PanoramaInput,
  SearchInput,
  SkillInput,
  StructureInput,
  SubmitKnowledgeInput,
  TaskInput,
  WikiInput,
} from '#shared/schemas/mcp-tools.js';
import { zodToMcpSchema } from './zodToMcpSchema.js';

// ─── Tier Definitions ────────────────────────────────────────
export const TIER_ORDER = { agent: 0, admin: 1 };

// ─── Gateway Mapping (only write operations require gating) ─

export const TOOL_GATEWAY_MAP = {
  // bootstrap — parameterless Mission Briefing (read-only analysis, no gating needed)
  // autosnippet_bootstrap: null,
  // dimension_complete — write operation (recipe tagging + skill creation + checkpoint)
  autosnippet_dimension_complete: { action: 'knowledge:bootstrap', resource: 'knowledge' },
  // wiki — finalize is a write operation (meta.json)
  autosnippet_wiki: {
    resolver: (args: Record<string, unknown>) =>
      args?.operation === 'finalize' ? { action: 'knowledge:create', resource: 'knowledge' } : null, // plan is read-only
  },
  // guard write operation (files mode only)
  autosnippet_guard: {
    resolver: (args: Record<string, unknown>) =>
      args?.files && Array.isArray(args.files)
        ? { action: 'guard_rule:check_code', resource: 'guard_rules' }
        : null, // code mode is read-only, skip Gateway
  },
  // skill write operations (create/update/delete)
  autosnippet_skill: {
    resolver: (args: Record<string, unknown>) =>
      (
        ({
          create: { action: 'create:skills', resource: 'skills' },
          update: { action: 'update:skills', resource: 'skills' },
          delete: { action: 'delete:skills', resource: 'skills' },
        }) as Record<string, { action: string; resource: string }>
      )[args?.operation as string] || null, // list/load/suggest are read-only
  },
  // knowledge submission (unified pipeline)
  autosnippet_submit_knowledge: { action: 'knowledge:create', resource: 'knowledge' },
  // task write operations (create/close/fail + record_decision)
  autosnippet_task: {
    resolver: (args: Record<string, unknown>) =>
      (
        ({
          create: { action: 'task:create', resource: 'intent' },
          close: { action: 'task:update', resource: 'intent' },
          fail: { action: 'task:update', resource: 'intent' },
          record_decision: { action: 'task:create', resource: 'intent' },
        }) as Record<string, { action: string; resource: string }>
      )[args?.operation as string] || null, // prime is read-only
  },
  // admin tools
  autosnippet_enrich_candidates: { action: 'knowledge:update', resource: 'knowledge' },
  autosnippet_knowledge_lifecycle: { action: 'knowledge:update', resource: 'knowledge' },
};

// ─── Tool Declarations ───────────────────────────────────────

export const TOOLS = [
  // ══════════════════════════════════════════════════════
  //  Tier: agent — Core Agent Toolset (14)
  // ══════════════════════════════════════════════════════

  // 1. Health Check
  {
    name: 'autosnippet_health',
    tier: 'agent',
    description:
      'Check service status and knowledge base stats. Returns total (entry count) and kind/lifecycle distribution. When total=0, cold-start is needed (call autosnippet_bootstrap).',
    inputSchema: zodToMcpSchema(HealthInput),
  },

  // 2. Unified Search
  {
    name: 'autosnippet_search',
    tier: 'agent',
    description:
      'Search the knowledge base. 5 modes:\n' +
      '• auto (default) — automatically selects optimal strategy\n' +
      '• keyword — exact keyword matching, best for trigger/title lookup\n' +
      '• bm25 — full-text search, best for natural language descriptions\n' +
      '• semantic — vector semantic search, best for fuzzy concept matching\n' +
      '• context — combined search + context association, best for coding assistance\n' +
      'Returns results grouped by kind (rule/pattern/fact).',
    inputSchema: zodToMcpSchema(SearchInput),
  },

  // 3. Knowledge Browser
  {
    name: 'autosnippet_knowledge',
    tier: 'agent',
    description:
      'Knowledge entry management.\n' +
      '• list — filter entries by kind/category/status\n' +
      '• get — retrieve full content of a single entry (requires id)\n' +
      '• insights — quality analysis and improvement suggestions (requires id)\n' +
      '• confirm_usage — record that knowledge was actually adopted (requires id)',
    inputSchema: zodToMcpSchema(KnowledgeInput),
  },

  // 4. Project Structure
  {
    name: 'autosnippet_structure',
    tier: 'agent',
    description:
      'Explore project structure.\n' +
      '• targets — list build targets (modules/Targets/Packages)\n' +
      '• files — list files for a specific Target\n' +
      '• metadata — project metadata (language, dependencies, configuration)',
    inputSchema: zodToMcpSchema(StructureInput),
  },

  // 5. Knowledge Graph
  {
    name: 'autosnippet_graph',
    tier: 'agent',
    description:
      'Knowledge relationship graph queries.\n' +
      '• query — query relationships of a node\n' +
      '• impact — analyze impact scope of modifying a knowledge entry\n' +
      '• path — find relationship path between two knowledge nodes\n' +
      '• stats — global graph statistics (nodes/edges/density)',
    inputSchema: zodToMcpSchema(GraphInput),
  },

  // 6. Call Context
  {
    name: 'autosnippet_call_context',
    tier: 'agent',
    description:
      'Query function/method call chains.\n' +
      '• callers — who calls it (upstream call chain)\n' +
      '• callees — what it calls (downstream dependency chain)\n' +
      '• impact — modification impact radius (upstream + downstream + affected file count)\n' +
      '• both — retrieve callers + callees simultaneously',
    inputSchema: zodToMcpSchema(CallContextInput),
  },

  // 7. Guard Code Check
  {
    name: 'autosnippet_guard',
    tier: 'agent',
    description:
      'Code compliance check and Guard immune system.\n' +
      '• no params → auto-check git diff incremental files (preferred after coding)\n' +
      '• files → check specified file list\n' +
      '• code → inline check code snippet\n' +
      '• operation: "reverse_audit" → Recipe→Code reverse validation (check if knowledge is outdated)\n' +
      '• operation: "coverage_matrix" → module-level Guard rule coverage matrix\n' +
      'Each violation includes a fix guide (doClause + coreCode). Fix accordingly and re-check.',
    inputSchema: zodToMcpSchema(GuardInput),
  },

  // 8. Submit Knowledge (Unified Pipeline)
  {
    name: 'autosnippet_submit_knowledge',
    tier: 'agent',
    description:
      'Submit knowledge entries (single/batch unified pipeline). Pass 1~N items via the items array.\n' +
      '• All entries undergo strict validation; all V3 fields must be provided at once\n' +
      '• Unified consolidation analysis: detects overlap with existing Recipes and batch candidates\n' +
      '• Overlap detected → evolution proposal created automatically (merge/enhance/reorganize); system auto-executes after observation window\n' +
      '• Set skipConsolidation: true to skip consolidation check. content and reasoning must be objects.\n' +
      '• Set supersedes: "old-recipe-id" to declare the new Recipe replaces an existing one (creates a supersede proposal with observation window).\n' +
      '⚠️ Batch rule: items in the array must NOT be cross-redundant — no highly overlapping doClause/coreCode/trigger within the same batch. ' +
      'If two entries share 80%+ content, merge into one or split into primary + extends supplementary entries.',
    inputSchema: zodToMcpSchema(SubmitKnowledgeInput),
  },

  // 9. Skill Management
  {
    name: 'autosnippet_skill',
    tier: 'agent',
    description:
      'Skill management.\n' +
      '• list — list all available Skills (built-in + project-level)\n' +
      '• load — load full Skill content for detailed guidance (requires name)\n' +
      '• create — create project-level Skill (requires name + description + content)\n' +
      '• update — update project-level Skill content\n' +
      '• delete — delete project-level Skill (built-in cannot be deleted)\n' +
      '• suggest — recommend Skills to create based on project analysis',
    inputSchema: zodToMcpSchema(SkillInput),
  },

  // 10. Cold-Start Bootstrap
  {
    name: 'autosnippet_bootstrap',
    tier: 'agent',
    description:
      'Cold-start — no parameters needed. Auto-analyzes the project (AST, dependency graph, Guard audit) and returns a Mission Briefing:\n' +
      '• Project metadata and language statistics\n' +
      '• Dimension task list (8 dimensions × 3 Tiers)\n' +
      '• Execution plan and submission examples\n' +
      'After receiving the Briefing, complete all dimension analyses per the executionPlan.',
    inputSchema: zodToMcpSchema(BootstrapInput),
  },

  // 11. Dimension Complete Notification
  {
    name: 'autosnippet_dimension_complete',
    tier: 'agent',
    description:
      'Dimension analysis completion notification. Handles: Recipe linking, Skill generation (auto-synthesized from submitted candidates), Checkpoint saving, cross-dimension Hints distribution.\n' +
      'analysisText can be brief — the system auto-synthesizes detailed content from submitted candidates for Skill generation.',
    inputSchema: zodToMcpSchema(DimensionCompleteInput),
  },

  // 12. Wiki Documentation Generation
  {
    name: 'autosnippet_wiki',
    tier: 'agent',
    description:
      'Wiki documentation generation.\n' +
      '• plan — plan topics + data packages (integrates project structure and knowledge base; returns topic list + per-topic data package for Agent to write)\n' +
      '• finalize — complete generation (write meta.json, dedup check, validate completeness; call after all articles are written)',
    inputSchema: zodToMcpSchema(WikiInput),
  },

  // 13. Project Panorama
  {
    name: 'autosnippet_panorama',
    tier: 'agent',
    description:
      'Project panorama queries. Auto-triggers structure scan when no data exists — no manual cold-start needed.\n' +
      '• overview (default) — project skeleton + architecture layers + module roles + knowledge coverage\n' +
      '• module — single module details + neighbor relationships (requires module param)\n' +
      '• gaps — knowledge gaps (modules with code but no Recipes)\n' +
      '• health — panorama health score (coverage + coupling + circular deps + health score)\n' +
      '• governance_cycle — full knowledge metabolism cycle (contradiction detection + redundancy analysis + decay assessment)\n' +
      '• decay_report — decay assessment report (5 strategy detection + decayScore)\n' +
      '• staging_check — staging entry check + auto-publish on expiry\n' +
      '• enhancement_suggestions — Recipe enhancement suggestions based on usage data',
    inputSchema: zodToMcpSchema(PanoramaInput),
  },

  // 14. Task & Decision Management
  {
    name: 'autosnippet_task',
    tier: 'agent',
    description:
      'Task and decision management (5 operations). Call prime first at the start of each conversation to load knowledge context.\n' +
      '• prime — load knowledge context + initialize intent lifecycle\n' +
      '• create — create task anchor (for non-trivial work: ≥2 files or ≥10 lines)\n' +
      '• close — complete task + trigger Guard compliance review\n' +
      '• fail — abandon task\n' +
      '• record_decision — record user preference decision',
    inputSchema: zodToMcpSchema(TaskInput),
  },

  // ══════════════════════════════════════════════════════
  //  Tier: admin — Admin/CI Tools (+2)
  // ══════════════════════════════════════════════════════

  // 15. Candidate Field Diagnosis
  {
    name: 'autosnippet_enrich_candidates',
    tier: 'admin',
    description:
      'Diagnose field completeness of candidate entries (no AI). Returns missingFields list per candidate for Agent to fill in and resubmit.',
    inputSchema: zodToMcpSchema(EnrichCandidatesInput),
  },

  // 16. Knowledge Lifecycle
  {
    name: 'autosnippet_knowledge_lifecycle',
    tier: 'admin',
    description:
      'Knowledge entry lifecycle operations. approve/fast_track → publish; reject → reject; deprecate → deprecate; reactivate → restore.',
    inputSchema: zodToMcpSchema(KnowledgeLifecycleInput),
  },
];
