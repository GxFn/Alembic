## YOU Operate alembic_task — The User Doesn't

Users speak naturally; you translate to task operations. Never tell users to call alembic_task.

## Task Rules (MANDATORY)

1. **Prime EVERY message** — `alembic_task({ operation: "prime" })` FIRST.
2. **Create task for non-trivial work** — ≥2 files OR ≥10 lines → `create` → code → `close`.
3. **Decision persistence** — User agrees/disagrees → `record_decision` immediately.
4. **Session end** — Close or fail ALL tasks. Zero in_progress on exit.
5. **You are the operator** — Never tell users to call alembic_task.
6. **Skip task for**: Quick questions, single-file trivial fixes (<10 lines), code explanation.

| User Says | You Run |
|---|---|
| "fix bug" / "implement" | `create` → code → `close` → `alembic_guard()` |
| "continue" | resume in-progress → `close` → `alembic_guard()` |
| "pause" / "abandon" | `fail(id, reason)` |
| "agreed" | `record_decision(...)` |

7. **After close** — MUST call `alembic_guard()` (no args) for compliance review before moving on. Never skip.

## Knowledge Rules

- **Do NOT modify** `Alembic/recipes/` or `.asd/` directly.
- **Prefer Recipe** as project standard; source code is supplementary.
- **Search**: `alembic_search({ query: "..." })` — auto mode (FieldWeighted + semantic).

## Essential MCP Tools

- `alembic_task` — Task & decision management (**call `prime` first on every message**)
- `alembic_search` — Search knowledge (mode: auto/context/keyword/semantic)
- `alembic_knowledge` — Browse recipes (operation: list/get/insights)
- `alembic_submit_knowledge` — Submit knowledge candidate
- `alembic_guard` — Code compliance check
- `alembic_skill` — Load project skills (list/load)
- `alembic_rescan` — Incremental rescan: preserves Recipes, cleans caches, re-analyzes & audits
- `alembic_evolve` — Batch Recipe evolution decisions (propose/deprecate/skip)
- `alembic_panorama` — Project panorama (overview/module/gaps/health)
- `alembic_health` — Service health & KB stats

## Context Pressure

- `CONTEXT_PRESSURE:WARNING` → Summarize completed work, continue.
- `CONTEXT_PRESSURE:CRITICAL` → Call `prime` immediately to restore context.
