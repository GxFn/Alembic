---
name: alembic-create
description: Submit new Alembic knowledge candidates from Codex. Covers `alembic_submit_knowledge`, required V3 fields, batch rules, and review boundaries.
---

# Alembic Create

Use this skill when the user asks to add knowledge, create a Recipe, save a convention, or when implementation reveals a reusable pattern worth preserving.

Submitted entries become candidates. Users review and publish them later through the Dashboard or an explicit admin workflow.

## Tool

Use `alembic_submit_knowledge`.

For one item:

```json
{
  "items": [
    {
      "title": "Network Client Retry Policy",
      "description": "Use the shared retry helper for idempotent API requests",
      "trigger": "@network-client-retry",
      "language": "typescript",
      "kind": "pattern",
      "category": "Network",
      "knowledgeType": "api-usage",
      "doClause": "Use the shared retry helper for idempotent GET requests",
      "dontClause": "Do not hand-roll retry loops in feature modules",
      "whenClause": "When adding an idempotent API request",
      "coreCode": "await retryRequest(() => client.get(path), { attempts: 3 })",
      "headers": ["import { retryRequest } from '@/network/retry'"],
      "usageGuide": "### When to Use\n- Idempotent GET requests\n\n### When Not to Use\n- Non-idempotent writes\n\n### Steps\n1. Wrap the request in retryRequest.\n2. Keep feature-specific error handling outside the helper.\n\n### Key Points\n- Keep retries centralized.\n- Avoid duplicate timers.",
      "content": {
        "markdown": "The project centralizes retry behavior in retryRequest.",
        "rationale": "Central retry policy keeps feature modules consistent."
      },
      "reasoning": {
        "whyStandard": "Multiple network modules use the same helper.",
        "sources": ["src/network/retry.ts", "src/features/example.ts"],
        "confidence": 0.82
      }
    }
  ]
}
```

## Required V3 Fields

Every candidate should include:

`title`, `description`, `trigger`, `language`, `kind`, `category`, `knowledgeType`, `doClause`, `dontClause`, `whenClause`, `coreCode`, `headers`, `usageGuide`, `content`, and `reasoning`.

Use `kind` carefully:

| kind | Use |
| --- | --- |
| `rule` | A constraint Guard should enforce |
| `pattern` | A reusable implementation approach |
| `fact` | Architecture or project structure knowledge |

## Quality Rules

- Create one entry per scenario. Do not merge unrelated patterns.
- Search existing knowledge first to avoid duplicates.
- Include concrete source file paths in `reasoning.sources`.
- Include complete imports in `headers`.
- Write `usageGuide` as structured Markdown sections, not a single paragraph.
- If confidence is low, submit a narrower candidate or ask the user before saving it.

## Batch Rules

When passing multiple items, make sure the items are not redundant with each other. If two entries share most of their `doClause`, `coreCode`, or trigger intent, merge them or make one a small extension of the other through relations.

Batch submission is stricter than a single entry. If the response reports rejected items, fill the missing fields and retry only the rejected entries.

## Boundaries

Do not publish or deprecate Recipes from the default Codex plugin tier. Candidate submission is allowed; lifecycle changes belong to the Dashboard or admin mode.
