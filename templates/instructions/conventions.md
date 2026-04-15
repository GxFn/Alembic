## YOU Operate asd_task — The User Doesn't

Users speak naturally; you translate to task operations. Never tell users to call asd_task.

## Task Rules (MANDATORY)

1. **Prime EVERY message** — `asd_task({ operation: "prime" })` FIRST.
2. **Create task for non-trivial work** — ≥2 files OR ≥10 lines → `create` → code → `close`.
3. **Decision persistence** — User agrees/disagrees → `record_decision` immediately.
4. **Session end** — Close or fail ALL tasks. Zero in_progress on exit.
5. **You are the operator** — Never tell users to call asd_task.
6. **Skip task for**: Quick questions, single-file trivial fixes (<10 lines), code explanation.

| User Says | You Run |
|---|---|
| "fix bug" / "implement" | `create` → code → `close` → `asd_guard()` |
| "continue" | resume in-progress → `close` → `asd_guard()` |
| "pause" / "abandon" | `fail(id, reason)` |
| "agreed" | `record_decision(...)` |

7. **After close** — MUST call `asd_guard()` (no args) for compliance review before moving on. Never skip.

## Knowledge Rules

- **Do NOT modify** `Alembic/recipes/` or `.asd/` directly.
- **Prefer Recipe** as project standard; source code is supplementary.
- **Search**: `asd_search({ query: "..." })` — auto mode (FieldWeighted + semantic).

## Essential MCP Tools

- `asd_task` — Task & decision management (**call `prime` first on every message**)
- `asd_search` — Search knowledge (mode: auto/context/keyword/semantic)
- `asd_knowledge` — Browse recipes (operation: list/get/insights)
- `asd_submit_knowledge` — Submit knowledge candidate
- `asd_guard` — Code compliance check
- `asd_skill` — Load project skills (list/load)
- `asd_rescan` — Incremental rescan: preserves Recipes, cleans caches, re-analyzes & audits
- `asd_evolve` — Batch Recipe evolution decisions (propose/deprecate/skip)
- `asd_panorama` — Project panorama (overview/module/gaps/health)
- `asd_health` — Service health & KB stats

## Context Pressure

- `CONTEXT_PRESSURE:WARNING` → Summarize completed work, continue.
- `CONTEXT_PRESSURE:CRITICAL` → Call `prime` immediately to restore context.
