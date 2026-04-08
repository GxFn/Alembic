# HTTP API Reference

AutoSnippet provides a RESTful API for the Dashboard and external integrations.

**Start:**

```bash
asd server -p 3000          # API only
asd ui -p 3000              # API + Dashboard
```

**Base URL:** `http://127.0.0.1:3000/api/v1`

**OpenAPI Spec:** `GET /api-spec` returns an OpenAPI 3.0 JSON document.

---

## Authentication

No authentication is required when running locally by default. Access is controlled through the role system configured in `constitution.yaml`:

| Role | Source | Scope |
|------|--------|-------|
| `developer` | Local requests (default) | Full access |
| `external_agent` | MCP channel / API Key | Read-only + create candidates |
| `chat_agent` | Dashboard AI Chat | Read-only + create candidates (requires reasoning) |

---

## Endpoints

### Health

#### `GET /health`

Returns service status.

**Response:**
```json
{
  "success": true,
  "status": "ok",
  "timestamp": "2026-02-22T10:00:00.000Z",
  "uptime": 3600
}
```

#### `GET /health/ready`

Readiness check (database connection + service initialization).

---

### Auth

#### `GET /auth/probe`

Returns current request role and permission info.

**Response:**
```json
{
  "role": "developer",
  "user": "local",
  "mode": "standalone"
}
```

---

### Knowledge

#### `GET /knowledge`

List knowledge entries.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | number | `1` | Page number |
| `limit` | number | `20` | Items per page |
| `status` | string | — | Filter by status: `draft` / `pending` / `approved` / `active` / `deprecated` |
| `type` | string | — | Filter by knowledge type |
| `language` | string | — | Filter by language |

#### `GET /knowledge/:id`

Get a single knowledge entry.

#### `POST /knowledge`

Create a knowledge entry.

**Request Body:**
```json
{
  "title": "Error handling pattern",
  "language": "typescript",
  "content": "...",
  "kind": "pattern",
  "knowledgeType": "code-pattern",
  "category": "error-handling",
  "description": "...",
  "headers": { "do": "...", "trigger": "...", "usageGuide": "..." }
}
```

#### `PATCH /knowledge/:id`

Update a knowledge entry.

#### `DELETE /knowledge/:id`

Delete a knowledge entry (requires developer role confirmation).

#### `POST /knowledge/:id/lifecycle`

Execute a lifecycle operation.

**Request Body:**
```json
{
  "action": "approve"
}
```

**Available actions:** `submit` / `approve` / `reject` / `publish` / `deprecate` / `reactivate` / `to_draft` / `fast_track`

---

### Search

#### `GET /search`

Search the knowledge base.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `q` | string | — | Search query (required) |
| `mode` | string | `auto` | Search mode: `auto` / `keyword` / `weighted` / `semantic` / `context` |
| `type` | string | `all` | Type filter: `all` / `recipe` / `solution` / `rule` |
| `limit` | number | `10` | Max results |
| `language` | string | — | Language filter |

**Response:**
```json
{
  "results": [
    {
      "id": "...",
      "title": "...",
      "score": 0.85,
      "snippet": "...",
      "knowledgeType": "code-pattern",
      "language": "typescript"
    }
  ],
  "total": 42,
  "mode": "weighted"
}
```

---

### Candidates

#### `GET /candidates`

List candidate entries.

#### `GET /candidates/:id`

Get candidate details.

#### `POST /candidates`

Create a candidate entry.

#### `PATCH /candidates/:id`

Update a candidate entry.

#### `DELETE /candidates/:id`

Delete a candidate entry.

#### `POST /candidates/:id/approve`

Approve candidate → convert to Recipe.

#### `POST /candidates/:id/reject`

Reject candidate.

---

### Recipes

#### `GET /recipes`

List Recipes.

#### `GET /recipes/:id`

Get Recipe details.

#### `POST /recipes/:id/relations`

Discover related Recipes (via knowledge graph).

---

### Guard Rules

#### `GET /rules`

Get all Guard rules (built-in + custom).

**Response:**
```json
{
  "rules": [
    {
      "id": "js-no-eval",
      "title": "Disallow eval()",
      "description": "eval() poses security and performance risks",
      "severity": "error",
      "languages": ["javascript", "typescript"],
      "category": "safety",
      "enabled": true
    }
  ]
}
```

#### `POST /rules`

Create a custom Guard rule.

**Request Body:**
```json
{
  "name": "no-console-error",
  "pattern": "console\\.error",
  "action": "warn",
  "description": "Avoid direct use of console.error",
  "languages": ["javascript", "typescript"]
}
```

#### `GET /rules/:id`

Get rule details.

#### `PATCH /rules/:id/enable`

Enable a rule.

#### `PATCH /rules/:id/disable`

Disable a rule.

---

### Violations

#### `GET /violations`

List Guard violation records.

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `ruleId` | string | Filter by rule ID |
| `severity` | string | Filter by severity level |
| `file` | string | Filter by file path |

---

### Modules

#### `GET /modules`

Get project module structure.

#### `GET /modules/project-info`

Get project basic info (root path, project name, detected languages/frameworks).

---

### Skills

#### `GET /skills`

List all Skills.

#### `GET /skills/:name`

Load a specific Skill's content.

#### `POST /skills`

Create a new Skill.

#### `PUT /skills/:name`

Update a Skill.

#### `DELETE /skills/:name`

Delete a Skill.

---

### Snippets

#### `GET /snippets`

List code snippets.

#### `POST /snippets/install`

Install code snippets to IDE (Xcode / VS Code).

---

### AI

#### `POST /ai/chat`

AI conversation (AgentRuntime).

**Request Body:**
```json
{
  "message": "Analyze code patterns in src/utils",
  "conversationId": "optional-id"
}
```

Supports SSE streaming responses.

#### `GET /ai/status`

AI Provider status.

#### `POST /ai/reload`

Hot-reload AI Provider (switch model/key).

---

### Extract

#### `POST /extract`

Extract knowledge candidates from source code.

---

### Commands

#### `POST /commands/:command`

Execute CLI commands via API (`setup` / `sync` / `coldstart`, etc.).

---

### Wiki

#### `GET /wiki`

Get project Wiki.

#### `POST /wiki/generate`

AI-generate project Wiki.

---

### Monitoring

#### `GET /monitoring/metrics`

Performance metrics.

#### `GET /monitoring/errors`

Error logs.

---

## WebSocket (Real-time Push)

Connect via Socket.IO at `ws://127.0.0.1:3000` to receive real-time events:

| Event | Data | Description |
|-------|------|-------------|
| `bootstrap:progress` | `{ phase, dimension, progress, total }` | Coldstart progress |
| `bootstrap:complete` | `{ stats }` | Coldstart completed |
| `refine:progress` | `{ step, progress }` | Refinement progress |
| `skill:suggestion` | `{ skill, reason }` | Skill recommendation |
| `guard:violation` | `{ file, rule, severity }` | Real-time Guard violation |

---

## Error Response

All APIs use a unified error format:

```json
{
  "success": false,
  "error": {
    "code": "KNOWLEDGE_NOT_FOUND",
    "message": "Knowledge entry not found",
    "details": {}
  }
}
```

**HTTP Status Codes:**

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Created |
| `400` | Bad request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not found |
| `429` | Rate limited |
| `500` | Internal server error |

---

## Middleware

API requests pass through the following middleware:

1. **CORS** — Cross-origin configuration (allows all origins by default)
2. **Helmet** — HTTP security headers
3. **RequestLogger** — Request logging
4. **RoleResolver** — Role resolution
5. **GatewayMiddleware** — Gateway permission check
6. **RateLimiter** — Request rate limiting
7. **ErrorHandler** — Unified error handling
