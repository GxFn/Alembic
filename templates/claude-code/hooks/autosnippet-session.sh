#!/bin/bash
# AutoSnippet session hook for Claude Code
# SessionStart: full task rules + prime reminder
# PreCompact (--brief): minimal rules to survive compaction

if [[ "$1" == "--brief" ]]; then
  # Brief mode — survives compaction, minimal context
  cat <<'EOF'
📋 AutoSnippet Task Rules (MANDATORY):
• Prime EVERY message: autosnippet_task({ operation: "prime" }) FIRST.
• Create task for non-trivial work (≥2 files OR ≥10 lines). Claim → code → close.
• Handle in-progress tasks before new work. Close/defer ALL on session end.
• You are the task operator — user speaks naturally, you run task operations.
• User agrees/disagrees → record_decision immediately.
• "fix bug"/"implement" → create→claim→code→close | "pause" → defer | "abandon" → fail | "next" → ready()
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
• Claim before coding, close when done with meaningful reason
• Handle unfinished tasks first (ask user: Continue/Defer/Abandon)
• Close or defer ALL in_progress tasks before session ends

🚫 NEVER:
• Skip prime
• Start new work with open in_progress tasks
• Tell user to run task commands (YOU are the operator)
• Leave tasks in in_progress when session ends

📖 User Says → You Run:
• "fix bug" / "implement" → create → claim → code → close
• "continue" → resume in-progress → code → close
• "pause" → defer(id, reason)
• "abandon" → fail(id, reason)
• "break down" → decompose(id, subtasks)
• "what's next" → ready() → present list
• "agreed" → record_decision(...)
• Quick question → No task. Just answer.

💡 When in doubt → create a task. When idle → autosnippet_task({ operation: "ready" })

📌 User agrees/disagrees with plan → autosnippet_task({ operation: "record_decision" }) immediately

✅ Session end checklist:
  [ ] Close every claimed task with reason
  [ ] Defer incomplete tasks with notes
  [ ] Verify zero in_progress
  [ ] Mention ready tasks for next session

🔎 Search knowledge: autosnippet_search({ query: "..." })
📚 Do NOT modify AutoSnippet/recipes/ or .autosnippet/ directly
EOF
fi
