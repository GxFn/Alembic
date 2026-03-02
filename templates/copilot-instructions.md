<!-- autosnippet:begin -->
<!-- MANDATORY: On EVERY human message, call autosnippet_task({ operation: "prime" }) FIRST. -->

# {{projectName}} — AutoSnippet 项目指引

## CRITICAL: You Operate autosnippet_task — The User Doesn't

You are the task operator. Users speak naturally; you translate to task operations.
DO NOT tell users to call autosnippet_task. That's YOUR job.

- WRONG: "你可以调用 autosnippet_task({ operation: 'create' }) 来创建任务"
- RIGHT: *(你自己调用 create，然后告诉用户 "已创建任务 asd-42: 修复登录 bug")*

## Task Tracking Rules (MANDATORY)

1. **MUST prime on EVERY message** — `autosnippet_task({ operation: "prime" })` BEFORE doing anything else. No exceptions.
2. **MUST create a task for non-trivial work** — If work involves ≥2 files OR ≥10 lines, create BEFORE starting.
3. **MUST claim before coding** — `autosnippet_task({ operation: "claim", id })` then code.
4. **MUST close when done** — `autosnippet_task({ operation: "close", id, reason })` with meaningful reason.
5. **MUST handle unfinished tasks first** — If prime returns in-progress tasks, ask user: Continue, Defer, or Abandon? Do NOT auto-resume.
6. **NEVER skip prime** — Even for follow-up messages.
7. **NEVER start new work with open in-progress tasks** — Handle existing first.
8. **NEVER leave tasks in in_progress when session ends** — Close or defer everything.
9. **NEVER tell the user to run task commands** — You are the operator.

When in doubt → create a task. When idle → `autosnippet_task({ operation: "ready" })`.

### When NOT to Create Tasks

Quick questions, single-file trivial fixes (<10 lines), code explanation, running existing tests.
Rule: <2min AND ≤1 file AND <10 lines → no task. Everything else → create.

## User Says → You Run

| User Says | Your Action |
|---|---|
| "帮我修 bug" / "fix this" | `create` → `claim` → code → `close` |
| "做功能" / "implement" | `create` → `claim` → code → `close` |
| "继续" / "continue" | resume in-progress task → code → `close` |
| "先不做了" / "pause" | `defer(id, reason)` |
| "不做了" / "abandon" | `fail(id, reason)` |
| "太大了" / "break down" | `decompose(id, subtasks)` |
| "有什么要做的" / "what's next" | `ready()` → present |
| "就这么定了" / "agreed" | `record_decision(...)` |
| Quick question | No task. Just answer. |

## Session Closing Protocol

Before ending work, you MUST complete this checklist:

- [ ] Close every claimed task: `autosnippet_task({ operation: "close", id, reason: "what was accomplished" })`
- [ ] Defer any incomplete task: `autosnippet_task({ operation: "defer", id, reason: "why and what remains" })`
- [ ] Verify: zero tasks in in_progress state
- [ ] If prime showed ready tasks, mention them to the user for next session

**Work is not done until all tasks are closed or deferred.**

## Knowledge Rules

- **禁止直接修改** `AutoSnippet/recipes/`、`.autosnippet/` 等知识库目录
- **优先使用 Recipe**；搜索用 `autosnippet_search`
- MCP 调用失败时**不要重试**，回退到已有上下文

<!-- autosnippet:end -->
<!-- REMINDER: If you have not yet called autosnippet_task({ operation: "prime" }), do it NOW. -->
<!-- REMINDER: If user agreed/disagreed with a plan → autosnippet_task({ operation: "record_decision" | "revise_decision" | "unpin_decision" }) immediately. -->
