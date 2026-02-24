# MCP Tools Reference

AutoSnippet provides knowledge base access to AI assistants in IDEs via [Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

---

## Overview

The MCP server runs over the stdio protocol. IDEs (Cursor / VS Code / Trae / Qoder / Claude Code) automatically launch and connect to it.

**16 tools total:**
- **Agent Tier (12)** — Directly callable by IDE AI
- **Admin Tier (4)** — Admin/CI tools

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

Submit a single knowledge entry. Subject to strict pre-validation and deduplication.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | ✅ | Knowledge title |
| `language` | string | ✅ | Programming language |
| `content` | object | ✅ | `{ markdown, pattern?, rationale }` content object |
| `kind` | string | ✅ | Type: `rule` / `pattern` / `fact` |
| `category` | string | ✅ | Category |
| `knowledgeType` | string | ✅ | Knowledge type (e.g., `code-pattern`, `code-standard`) |
| `description` | string | ✅ | Chinese summary ≤80 chars |
| `doClause` | string | ✅ | English imperative positive rule |
| `dontClause` | string | ✅ | English negative constraint (what NOT to do) |
| `whenClause` | string | ✅ | English trigger scenario description |
| `trigger` | string | ✅ | `@kebab-case` unique identifier |
| `coreCode` | string | ✅ | 3-8 line code skeleton, syntactically complete |
| `headers` | array | ✅ | Import statement array, pass `[]` when none |
| `usageGuide` | string | ✅ | `###` section-format usage guide |
| `reasoning` | object | ✅ | `{ whyStandard, sources, confidence }` reasoning |
| `topicHint` | string | — | Topic hint: `networking` / `ui` / `data` / `architecture` / `conventions` |
| `scope` | string | — | Scope: `universal` / `project-specific` / `team-convention` |
| `complexity` | string | — | Complexity: `basic` / `intermediate` / `advanced` |
| `sourceFile` | string | — | Source file relative path |

---

### 8. autosnippet_submit_knowledge_batch

Batch submit knowledge entries.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `target_name` | string | ✅ | Target/module name |
| `items` | object[] | ✅ | Array of knowledge entries (same structure as `autosnippet_submit_knowledge`) |

---

### 9. autosnippet_save_document

Save a development document to the knowledge base.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | ✅ | Document title |
| `markdown` | string | ✅ | Markdown content |

---

### 10. autosnippet_skill

Skill management. Create, load, update, and delete project Skills.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `operation` | string | ✅ | Operation: `list` / `load` / `create` / `update` / `delete` / `suggest` |
| `name` | string | — | Skill name (required for `load`/`update`/`delete`) |
| `content` | string | — | Skill content (required for `create`/`update`) |

---

### 11. autosnippet_bootstrap

Coldstart and scan operations.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `operation` | string | ✅ | Operation: `knowledge` / `refine` / `scan` |
| `target` | string | — | Scan target path (for `scan`) |
| `dimensions` | string[] | — | Specify dimensions (for `knowledge`) |
| `maxFiles` | number | — | Maximum files |

**Operations:**

| Operation | Action |
|-----------|--------|
| `knowledge` | Full coldstart (multi-dimension analysis + AI population) |
| `refine` | Refine existing candidates (AI-enhanced descriptions and metadata) |
| `scan` | Scan a specific target (equivalent to `asd ais`) |

---

### 12. autosnippet_capabilities

List all available MCP tool overview. Helps AI understand what it can do.

**Parameters:** None

---

## Admin Tier Tools

### 13. autosnippet_enrich_candidates

Candidate field completeness diagnosis (pure logic check, no AI).

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `candidateIds` | string[] | ✅ | Candidate entry ID list |

---

### 14. autosnippet_knowledge_lifecycle

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

### 15. autosnippet_validate_candidate

Standalone candidate structured pre-validation (5 layers).

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `candidate` | object | ✅ | Candidate entry object |

**Validation layers:**
1. Required field completeness
2. Field format compliance
3. Content quality assessment
4. Semantic duplicate detection
5. Knowledge type compliance

---

### 16. autosnippet_check_duplicate

Similarity detection, checking if a candidate duplicates existing knowledge.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `candidate` | object | ✅ | Candidate entry object |

**Response:**
```json
{
  "isDuplicate": false,
  "similarEntries": [
    { "id": "...", "title": "...", "similarity": 0.82 }
  ],
  "threshold": 0.85
}
```

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
