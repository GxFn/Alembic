---
description: "MANDATORY: Load Alembic project context — decisions, tasks, knowledge"
allowed-tools: ["mcp__asd__asd_task"]
---

Call asd_task with `{ "operation": "prime" }` to load the current project context.

**You MUST call this on EVERY user message BEFORE doing anything else.**

This returns:
- **Active decisions** — team agreements that must be followed
- **Ready tasks** — next items to work on
- **In-progress tasks** — unfinished work (ask user before resuming)
- **Task rules reminder** — behavioral rules for task management
- **Project statistics**

If there are unfinished tasks, present them to the user and ask: **Continue**, **Defer**, or **Abandon**? Do NOT auto-resume.

Call again after long conversations, compaction, or when `_contextHint` shows `CONTEXT_PRESSURE:CRITICAL`.
