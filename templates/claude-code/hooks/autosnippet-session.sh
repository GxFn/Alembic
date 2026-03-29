#!/bin/bash
# AutoSnippet session hook for Claude Code
# SessionStart: full task rules + prime reminder
# PreCompact (--brief): minimal rules to survive compaction

if [[ "$1" == "--brief" ]]; then
  # Brief mode — survives compaction, minimal context
  cat <<'EOF'
📋 AutoSnippet Task Rules (MANDATORY):
• Prime EVERY message: autosnippet_task({ operation: "prime" }) FIRST.
• Create task for non-trivial work (≥2 files OR ≥10 lines). Create → code → close.
• Handle in-progress tasks before new work. Close/fail ALL on session end.
• You are the task operator — user speaks naturally, you run task operations.
• User agrees/disagrees → record_decision immediately.
• "fix bug"/"implement" → create→code→close | "pause"/"abandon" → fail
EOF
else
  # Full mode — SessionStart
  cat <<'EOF'
[AutoSnippet Task Rules]

⚡ FIRST: Call autosnippet_task({ "operation": "prime" }) on EVERY message. No exceptions.

🔑 CRITICAL: YOU Operate autosnippet_task — The User Doesn't
• WRONG: "You can run autosnippet_task to create a task"
• RIGHT: (you run create yourself and tell the user "Created task asd-42")

📋 MUST:
• Create task for non-trivial work (≥2 files OR ≥10 lines) BEFORE starting
• Close when done with meaningful reason
• Close or fail ALL in_progress tasks before session ends

🚫 NEVER:
• Skip prime
• Start new work with open in_progress tasks
• Tell user to run task commands (YOU are the operator)
• Leave tasks in in_progress when session ends

📖 User Says → You Run:
• "fix bug" / "implement" → create → code → close
• "continue" → resume in-progress → code → close
• "pause" / "abandon" → fail(id, reason)
• "agreed" → record_decision(...)
• Quick question → No task. Just answer.

💡 When in doubt → create a task.

📌 User agrees/disagrees with plan → autosnippet_task({ operation: "record_decision" }) immediately

✅ Session end checklist:
  [ ] Close every task with reason
  [ ] Fail incomplete tasks with notes
  [ ] Verify zero in_progress

🔎 Search knowledge: autosnippet_search({ query: "..." })
📚 Do NOT modify AutoSnippet/recipes/ or .autosnippet/ directly
EOF
fi
