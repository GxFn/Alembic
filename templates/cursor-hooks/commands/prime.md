# Prime AutoSnippet Context

Call `autosnippet_task` with `{ "operation": "prime" }` to load the current project context.

**You MUST call this on EVERY user message BEFORE doing anything else. No exceptions.**

This returns active decisions (team agreements), ready tasks, in-progress tasks, task rules reminder, and project stats.

If there are unfinished tasks, present them to the user and ask: **Continue**, **Defer**, or **Abandon**? Do NOT auto-resume.

Prime is automatically reminded on session start via hooks.
Call again after compaction or when `_contextHint` shows `CONTEXT_PRESSURE:CRITICAL`.
