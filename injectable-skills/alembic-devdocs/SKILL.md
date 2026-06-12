---
name: alembic-devdocs
description: Generate and browse project Wiki documentation through the Alembic resident daemon's wiki HTTP API (generate → status → files). Use when user says "generate wiki/docs", "write documentation", or agent needs structured project documentation produced from the knowledge base.
---

# Alembic — Wiki Documentation Generation

This skill guides the agent through generating structured **Wiki documentation**
from the Alembic knowledge base via the resident daemon's **wiki HTTP API**.

> There is NO `alembic_wiki` MCP tool. The former tool contract was removed in
> the Train B cleanup wave (it never had a connected handler); wiki generation
> is owned by the resident service (`WikiGenerator`) behind the daemon HTTP
> routes below. Calling a tool named `alembic_wiki` will fail.

## When to use this skill

- User asks to **generate project documentation** or **wiki**
- After a **cold-start bootstrap** completes — produce docs from newly captured knowledge
- When the user says "generate docs" / "write wiki" / "create documentation"
- After significant **knowledge base changes** — refresh documentation

## Wiki HTTP API (resident daemon, `/api/v1/wiki/*`)

| Route | Method | Description |
|-------|--------|-------------|
| `/api/v1/wiki/generate` | POST | Trigger full wiki generation (AI-driven; topics planned from project structure + knowledge base) |
| `/api/v1/wiki/update` | POST | Incremental update after knowledge changes |
| `/api/v1/wiki/abort` | POST | Abort a running generation |
| `/api/v1/wiki/status` | GET | Generation status / progress |
| `/api/v1/wiki/files` | GET | List generated wiki files |
| `/api/v1/wiki/file/:path` | GET | Read one wiki file's content |

The resident daemon must be running (`alembic start`); the Dashboard's Wiki
view drives the same routes interactively.

## Workflow

### Step 1: Trigger generation

`POST /api/v1/wiki/generate` (use `/update` for an incremental refresh after
knowledge changes). Generation is asynchronous and AI-driven — the service
plans topics and writes the articles itself; the agent does not hand-write
wiki articles.

### Step 2: Monitor

Poll `GET /api/v1/wiki/status` until generation completes (or abort with
`POST /api/v1/wiki/abort`).

### Step 3: Browse the result

- `GET /api/v1/wiki/files` — list the generated articles
- `GET /api/v1/wiki/file/:path` — read a specific article
- Or open the Dashboard Wiki view.

## Supporting MCP tools (context lookups, unchanged)

| Tool | Operation | Description |
|------|-----------|-------------|
| `alembic_search` | — | Search knowledge for additional context |
| `alembic_knowledge` | `get` | Retrieve full Recipe content for reference |

## Related Skills

| Skill | When to use |
|-------|-------------|
| `alembic-create` | Submitting **code patterns/recipes** to KB (not documents) |
| `alembic-devdocs` (this) | Generating **Wiki documentation** from KB |
| `alembic-recipes` | Looking up existing knowledge for reference |
