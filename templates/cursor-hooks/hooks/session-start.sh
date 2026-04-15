#!/bin/bash
# Alembic sessionStart hook — task behavioral rules + prime reminder
# No HTTP calls, no python3, no external dependencies.
# Injects task tracking rules into the AI's context on every session start.

cat <<'EOF'
{
  "additional_context": "[Alembic Task Rules]\n\n⚡ FIRST: Call asd_task({ \"operation\": \"prime\" }) on EVERY message. No exceptions.\n\n🔑 CRITICAL: YOU Operate asd_task — The User Doesn't\n• WRONG: \"You can run asd_task to create a task\"\n• RIGHT: (you run create yourself and tell the user \"Created task asd-42\")\n\n📋 MUST:\n• Create task for non-trivial work (≥2 files OR ≥10 lines) BEFORE starting\n• Close when done with meaningful reason\n• Close or fail ALL in_progress tasks before session ends\n\n🚫 NEVER:\n• Skip prime\n• Start new work with open in_progress tasks\n• Tell user to run task commands (YOU are the operator)\n• Leave tasks in in_progress when session ends\n\n📖 User Says → You Run:\n• \"fix bug\" / \"implement\" → create → code → close\n• \"continue\" → resume in-progress → code → close\n• \"pause\" / \"abandon\" → fail(id, reason)\n• \"agreed\" → record_decision(...)\n• Quick question → No task. Just answer.\n\n💡 When in doubt → create a task.\n\n📌 User agrees/disagrees with plan → asd_task({ operation: \"record_decision\" }) immediately\n\n✅ Session end checklist: close all tasks → fail incomplete → verify zero in_progress"
}
EOF
