## YOU Operate autosnippet_task — The User Doesn't

Users speak naturally; you translate to task operations. Never tell users to call autosnippet_task.

## Task Rules (MANDATORY)

1. **Prime EVERY message** — `autosnippet_task({ operation: "prime" })` FIRST.
2. **Create task for non-trivial work** — ≥2 files OR ≥10 lines → `create` → code → `close`.
3. **Decision persistence** — User agrees/disagrees → `record_decision` immediately.
4. **Session end** — Close or fail ALL tasks. Zero in_progress on exit.
5. **You are the operator** — Never tell users to call autosnippet_task.
6. **Skip task for**: Quick questions, single-file trivial fixes (<10 lines), code explanation.

| User Says | You Run |
|---|---|
| "fix bug" / "implement" | `create` → code → `close` → `autosnippet_guard()` |
| "continue" | resume in-progress → `close` → `autosnippet_guard()` |
| "pause" / "abandon" | `fail(id, reason)` |
| "agreed" | `record_decision(...)` |

7. **After close** — MUST call `autosnippet_guard()` (no args) for compliance review before moving on. Never skip.

## Knowledge Rules

- **Do NOT modify** `AutoSnippet/recipes/` or `.autosnippet/` directly.
- **Prefer Recipe** as project standard; source code is supplementary.
- **Search**: `autosnippet_search({ query: "..." })` — auto mode (BM25 + semantic).

## Essential MCP Tools

- `autosnippet_task` — Task & decision management (**call `prime` first on every message**)
- `autosnippet_search` — Search knowledge (mode: auto/context/keyword/semantic)
- `autosnippet_knowledge` — Browse recipes (operation: list/get/insights)
- `autosnippet_submit_knowledge` — Submit knowledge candidate
- `autosnippet_guard` — Code compliance check
- `autosnippet_skill` — Load project skills (list/load)
- `autosnippet_panorama` — Project panorama (overview/module/gaps/health)
- `autosnippet_health` — Service health & KB stats

## Context Pressure

- `CONTEXT_PRESSURE:WARNING` → Summarize completed work, continue.
- `CONTEXT_PRESSURE:CRITICAL` → Call `prime` immediately to restore context.
