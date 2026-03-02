#!/bin/bash
# AutoSnippet sessionStart hook — task behavioral rules + prime reminder
# No HTTP calls, no python3, no external dependencies.
# Injects task tracking rules into the AI's context on every session start.

cat <<'EOF'
{
  "additional_context": "[AutoSnippet Task Rules]\n\n⚡ FIRST: Call autosnippet_task({ \"operation\": \"prime\" }) on EVERY message. No exceptions.\n\n� CRITICAL: YOU Operate autosnippet_task — The User Doesn't\n• WRONG: \"You can run autosnippet_task to create a task\"\n• RIGHT: (you run create yourself and tell the user \"Created task asd-42\")\n\n📋 MUST:\n• Create task for non-trivial work (≥2 files OR ≥10 lines) BEFORE starting\n• Claim before coding, close when done with meaningful reason\n• Handle unfinished tasks first (ask user: Continue/Defer/Abandon)\n• Close or defer ALL in_progress tasks before session ends\n\n🚫 NEVER:\n• Skip prime\n• Start new work with open in_progress tasks\n• Tell user to run task commands (YOU are the operator)\n• Leave tasks in in_progress when session ends\n\n📖 User Says → You Run:\n• \"fix bug\" / \"implement\" → create → claim → code → close\n• \"continue\" → resume in-progress → code → close\n• \"pause\" → defer(id, reason)\n• \"abandon\" → fail(id, reason)\n• \"break down\" → decompose(id, subtasks)\n• \"what's next\" → ready()\n• \"agreed\" → record_decision(...)\n• Quick question → No task. Just answer.\n\n💡 When in doubt → create a task. When idle → autosnippet_task({ operation: \"ready\" })\n\n📌 User agrees/disagrees with plan → autosnippet_task({ operation: \"record_decision\" }) immediately\n\n✅ Session end checklist: close all tasks → defer incomplete → verify zero in_progress"
}
EOF
