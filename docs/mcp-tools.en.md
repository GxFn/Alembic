# MCP Tools Reference

AutoSnippet provides knowledge base access to AI assistants in IDEs via [Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

---

## Overview

The MCP server runs over the stdio protocol. IDEs (Cursor / VS Code / Trae / Qoder / Claude Code) automatically launch and connect to it.

**16 tools total:**
- **Agent Tier (14)** — Directly callable by IDE AI
- **Admin Tier (2)** — Admin/CI tools

All tools pass through the Gateway pipeline (validate → guard → route → audit).

---

## Agent Tier Tools

### 1. autosnippet_health

Service health status and knowledge base statistics.

**Parameters:** None

**Response example:**
```json
{
  "status": "ok",
  "knowledgeCount": 42,
  "candidateCount": 15,
  "aiProvider": "gemini",
  "dbConnected": true
}
```

---

### 2. autosnippet_search

Unified knowledge base search. Supports multiple search modes with automatic strategy selection.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | ✅ | Search query |
| `mode` | string | — | Search mode: `auto` / `keyword` / `bm25` / `semantic` / `context` (default `auto`) |
| `type` | string | — | Type filter: `all` / `recipe` / `solution` / `rule` |
| `limit` | number | — | Max results (default 10) |
| `language` | string | — | Language filter |

**Search modes:**

| Mode | Pipeline | Use Case |
|------|----------|----------|
| `auto` | Auto-select | Default recommended |
| `keyword` | Exact keyword matching | Known exact terms |
| `bm25` | BM25 (TF-IDF) scoring | General queries |
| `semantic` | Vector semantic similarity | Conceptual/fuzzy queries |
| `context` | 4-stage funnel (keyword→semantic→fusion→rerank) | Highest quality retrieval |

---

### 3. autosnippet_knowledge

Knowledge browsing. Get, list, or confirm knowledge entry usage.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `operation` | string | ✅ | Operation: `list` / `get` / `insights` / `confirm_usage` |
| `id` | string | — | Knowledge entry ID (required for `get` / `confirm_usage`) |
| `page` | number | — | Page number (for `list`) |
| `limit` | number | — | Items per page |
| `filter` | object | — | Filter conditions |

**Operations:**

| Operation | Action |
|-----------|--------|
| `list` | List knowledge entries with pagination and filtering |
| `get` | Get full content of a single entry |
| `insights` | Get knowledge base insights (stats, trends, quality distribution) |
| `confirm_usage` | Confirm AI has used a knowledge entry (updates usage count) |

---

### 4. autosnippet_structure

Project structure exploration. Helps AI understand project organization.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `operation` | string | ✅ | Operation: `targets` / `files` / `metadata` |
| `target` | string | — | Target path (for `files`) |

**Operations:**

| Operation | Action |
|-----------|--------|
| `targets` | List all modules/targets in the project |
| `files` | List files within a specific target |
| `metadata` | Get project metadata (languages, frameworks, dependencies) |

---

### 5. autosnippet_graph

Knowledge graph queries. Analyze relationships between entries.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `operation` | string | ✅ | Operation: `query` / `impact` / `path` / `stats` |
| `id` | string | — | Starting node ID |
| `targetId` | string | — | Target node ID (for `path`) |

**Operations:**

| Operation | Action |
|-----------|--------|
| `query` | Query direct relationships of a node |
| `impact` | Analyze change impact scope |
| `path` | Find relationship path between two nodes |
| `stats` | Graph statistics (nodes, edges, density) |

---

### 6. autosnippet_guard

Code compliance check. Check code snippets or file lists against Guard rules.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | string | — | Code to check (mutually exclusive with `files`) |
| `files` | string[] | — | File paths to check |
| `language` | string | — | Code language (for `code` mode) |
| `scope` | string | — | Check scope: `file` / `target` / `project` |

---

### 7. autosnippet_submit_knowledge

Unified knowledge submission (single/batch/document). Pass 1~N entries via `items` array.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `items` | object[] | ✅ | Knowledge entry array. See fields below |
| `target_name` | string | — | Batch source identifier, e.g. `network-module-scan` |
| `source` | string | — | Source tag, default `mcp` |
| `deduplicate` | boolean | — | Auto-dedup by title in batch mode, default `true` |
| `skipConsolidation` | boolean | — | Skip consolidation analysis (set `true` when confirmed new) |
| `skipDuplicateCheck` | boolean | — | Skip duplicate detection |
| `client_id` | string | — | Client ID |
| `dimensionId` | string | — | Coldstart dimension ID |

**items element fields (full knowledge entry):**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | ✅ | Knowledge title |
| `language` | string | ✅ | Programming language |
| `content` | object | ✅ | `{ markdown, pattern?, rationale }` content object |
| `kind` | string | ✅ | Type: `rule` / `pattern` / `fact` |
| `doClause` | string | ✅ | English imperative positive rule |
| `dontClause` | string | ✅ | English negative constraint (what NOT to do) |
| `whenClause` | string | ✅ | English trigger scenario description |
| `coreCode` | string | ✅ | 3-8 line code skeleton, syntactically complete |
| `category` | string | ✅ | Category |
| `trigger` | string | ✅ | `@kebab-case` unique identifier |
| `description` | string | ✅ | Summary ≤80 chars |
| `headers` | array | ✅ | Import statement array |
| `usageGuide` | string | ✅ | Usage guide |
| `knowledgeType` | string | ✅ | Knowledge type |
| `reasoning` | object | ✅ | `{ whyStandard, sources, confidence }` reasoning |

**Document save mode (set item `knowledgeType: 'dev-document'`, only `title` + `markdown` required).**

---

### 8. autosnippet_skill

Skill management. Create, load, update, and delete project Skills.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `operation` | string | ✅ | Operation: `list` / `load` / `create` / `update` / `delete` / `suggest` |
| `name` | string | — | Skill name (required for `load`/`update`/`delete`) |
| `content` | string | — | Skill content (required for `create`/`update`) |

---

### 9. autosnippet_bootstrap

Coldstart — No parameters required. Automatically analyzes the project (AST, dependency graph, Guard audit) and returns a Mission Briefing.

---

### 10. autosnippet_dimension_complete

Dimension analysis completion notification — Called after the Agent finishes analyzing a coldstart dimension. Handles Recipe association, Skill generation, checkpoint saving, and progress push.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `dimensionId` | string | ✅ | Dimension ID (e.g. `project-profile`, `language-scans`) |
| `analysisText` | string | ✅ | Analysis report full text (Markdown) |
| `sessionId` | string | — | bootstrap session ID (optional, auto-detected) |
| `submittedRecipeIds` | string[] | — | Recipe IDs submitted in this dimension |
| `keyFindings` | string[] | — | Key findings summary (3-5 items) |
| `candidateCount` | number | — | Number of candidates submitted in this dimension |

---

### 11. autosnippet_wiki

Wiki document generation.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `operation` | string | ✅ | `plan` (plan topics + data packages) / `finalize` (write meta.json + validate) |
| `language` | string | — | Wiki document language: `zh` (default) / `en` |
| `sessionId` | string | — | bootstrap session ID |
| `articlesWritten` | string[] | — | For `finalize`: written file paths list |

---

### 12. autosnippet_panorama

Project panorama queries.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `operation` | string | — | `overview` (default) / `module` / `gaps` / `health` / `governance_cycle` / `decay_report` / `staging_check` / `enhancement_suggestions` |
| `module` | string | — | Module name (required for `module` operation) |

---

### 13. autosnippet_task

Task and decision management (5 operations). Call `prime` at the start of every conversation to load knowledge context.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `operation` | string | ✅ | Operation: `prime` / `create` / `close` / `fail` / `record_decision` |
| `id` | string | — | Task ID (close/fail) |
| `title` | string | — | Task title (create) / Decision title (record_decision) |
| `description` | string | — | Task description (create) |
| `reason` | string | — | Reason (close/fail) |

---

## Admin Tier Tools

### 14. autosnippet_enrich_candidates

Candidate field completeness diagnosis (pure logic check, no AI).

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `candidateIds` | string[] | ✅ | Candidate entry ID list |

---

### 15. autosnippet_knowledge_lifecycle

Knowledge entry lifecycle operations.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✅ | Knowledge entry ID |
| `action` | string | ✅ | Action: `submit` / `approve` / `reject` / `publish` / `deprecate` / `reactivate` / `to_draft` / `fast_track` |
| `reason` | string | — | Reason for the action |

**Lifecycle state diagram:**

```
draft → pending → approved → active → deprecated
  ↑        ↓          ↓                    ↓
  └── rejected   ← to_draft ←─────── reactivate
```

---

---

## Gateway Permission Mapping

Mapping between MCP tools and Gateway Actions:

| Tool | Gateway Action | Role Requirement |
|------|---------------|-----------------|
| `autosnippet_search` | `read:recipes` | All roles |
| `autosnippet_knowledge` (list/get) | `read:recipes` | All roles |
| `autosnippet_submit_knowledge` | `submit:knowledge` | `external_agent` / `developer` |
| `autosnippet_guard` | `read:guard_rules` | All roles |
| `autosnippet_skill` (create) | `create:skills` | `external_agent` / `developer` |
| `autosnippet_bootstrap` | `knowledge:bootstrap` | `external_agent` / `developer` |
| `autosnippet_task` | `task:create` / `task:update` (routed by operation) | `external_agent` / `developer` |
| `autosnippet_knowledge_lifecycle` | Dynamic by action | `developer` |

---

## IDE Configuration

### Cursor

`.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "autosnippet": {
      "command": "node",
      "args": ["/path/to/autosnippet/bin/mcp-server.js"],
      "env": { "ASD_PROJECT_ROOT": "/path/to/your-project" }
    }
  }
}
```

### VS Code

`.vscode/mcp.json`:
```json
{
  "servers": {
    "autosnippet": {
      "command": "node",
      "args": ["/path/to/autosnippet/bin/mcp-server.js"],
      "env": { "ASD_PROJECT_ROOT": "/path/to/your-project" }
    }
  }
}
```

These configs are auto-generated by `asd setup`.
