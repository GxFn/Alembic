---
name: autosnippet-lifecycle
description: Understand the Recipe lifecycle (draft -> active -> deprecated) and the Agent's role boundaries. Agent can submit candidates, validate, confirm usage, but CANNOT create/modify/publish/delete Recipes directly.
---

# AutoSnippet Recipe Lifecycle

This skill documents the Recipe lifecycle and clarifies what Agent can and cannot do.

---

## Lifecycle Stages

```
                  Human approves
  Candidate -----+-----> Draft Recipe -----> Active Recipe -----> Deprecated
  (Agent submits) |      (human creates)     (human publishes)    (human deprecates)
                  |
                  +-----> Rejected
                         (human rejects)
```

### Stage Details

| Stage | Who | How |
|-------|-----|-----|
| **Candidate** | Agent submits via MCP | `submit_candidate` / `submit_candidates` / `submit_draft_recipes` |
| **Review** | Human via Dashboard | Dashboard Candidates page -> approve/reject |
| **Draft Recipe** | Human via Dashboard | Approved candidate becomes draft Recipe |
| **Active Recipe** | Human via Dashboard/API | `PATCH /api/v1/recipes/:id/publish` |
| **Updated** | Human via Dashboard/API | `PATCH /api/v1/recipes/:id` |
| **Deprecated** | Human via Dashboard/API | `PATCH /api/v1/recipes/:id/deprecate` |
| **Deleted** | Human via Dashboard/API | `DELETE /api/v1/recipes/:id` |

---

## Agent Role: What You CAN Do

### 1. Submit Candidates
- `autosnippet_submit_knowledge` - single structured candidate (built-in auto-validate + dedup)
- `autosnippet_submit_knowledge_batch` - batch structured candidates

### 2. Validate and Enhance Candidates
- Submit via `autosnippet_submit_knowledge` which auto-validates and checks duplicates
- Add structured content: rationale, steps, codeChanges, knowledgeType, complexity, tags, constraints, headers

### 3. Search and Query Recipes
- `autosnippet_knowledge(operation=list)` - list with filters (kind/language/category/knowledgeType/status/complexity)
- `autosnippet_knowledge(operation=get, id)` - get full Recipe details
- `autosnippet_search` - unified search (mode=auto/context/keyword/semantic)
- `autosnippet_graph(operation=query/impact)` - knowledge graph

### 4. Record Usage Telemetry
- `autosnippet_knowledge(operation=confirm_usage)` - record when user adopts/applies a Recipe
  - `usageType: "adoption"` - user adopted the Recipe
  - `usageType: "application"` - user applied the Recipe in code

---

## Agent Role: What You CANNOT Do

| Forbidden Action | Why | Human Alternative |
|-----------------|-----|-------------------|
| Create Recipe directly | Agent produces candidates, not Recipes | Dashboard: approve candidate |
| Modify Recipe content | Recipe content is human-controlled | Dashboard: edit Recipe |
| Publish Recipe (draft -> active) | Publishing is a human review decision | Dashboard: publish button |
| Deprecate Recipe | Deprecation is a human lifecycle decision | Dashboard: deprecate button |
| Delete Recipe | Deletion is irreversible, human-only | Dashboard: delete button |
| Update quality scores | Quality assessment is human-controlled | Dashboard: quality panel |
| Write to `AutoSnippet/recipes/` directly | Bypass candidate review process | Submit as candidate first |

---

## Typical Agent Workflows

### Workflow 1: User asks to add a code pattern
1. Analyze the code pattern
2. Generate structured candidate with rationale, steps, etc.
3. `autosnippet_submit_knowledge` - submit to candidate pool (auto-validates + dedup check)
4. Tell user: "Candidate submitted. Review in Dashboard Candidates page."

### Workflow 2: User asks about an existing Recipe
1. `autosnippet_search` or `autosnippet_knowledge(operation=list)` to find it
2. `autosnippet_knowledge(operation=get, id)` to get full details
3. Present the Recipe content to user
4. If user adopts it: `autosnippet_knowledge(operation=confirm_usage)` with usageType=adoption

### Workflow 3: User asks to update a Recipe
1. Explain: "I cannot modify Recipes directly. I can submit an improved version as a new candidate."
2. `autosnippet_knowledge(operation=get, id)` to read current content
3. Generate improved candidate based on user's feedback
4. `autosnippet_submit_knowledge` - submit improved version
5. Tell user: "Improved version submitted as candidate. Update the Recipe in Dashboard."

---

## Related Skills

- **autosnippet-recipes**: Project context, Recipe lookup, MCP tools reference
- **autosnippet-candidates**: Candidate generation workflow (single file / batch scan)
