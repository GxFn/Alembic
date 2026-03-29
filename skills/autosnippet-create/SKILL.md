---
name: autosnippet-create
description: Submit knowledge to AutoSnippet. Covers single/batch MCP submission, V3 field requirements, quality validation, and lifecycle. Use when user says "submit knowledge / add to KB / create recipe" or agent needs to persist code patterns, rules, or facts.
---

# AutoSnippet Create — Knowledge Submission

> Prerequisite: MCP tools return a unified JSON Envelope `{ success, errorCode?, message?, data?, meta }`. Call `autosnippet_health` before operations to confirm service availability.

This Skill guides the Agent to submit code patterns, rules, and facts to the AutoSnippet knowledge base. Submitted entries enter **Candidates** (pending status); users review and publish them via the Dashboard.

Related Skill: **autosnippet-recipes** (search existing knowledge).

---

## Submission Paths

| Path | Tool | Use Case |
|------|------|----------|
| **Single** | `autosnippet_submit_knowledge` | Agent carefully constructs one complete entry |
| **Batch** | `autosnippet_submit_knowledge` (items array) | Cold-start dimension analysis, batch scans |
| **Dashboard** | Browser `http://localhost:3000` | User manual paste/file scan |

**Agent prefers MCP submission** — no browser needed.

---

## Single Submission — autosnippet_submit_knowledge

Submit one complete V3 knowledge entry at a time. Even if some fields fail validation, the entry is still stored; the response includes `recipeReadyHints` indicating missing fields.

### V3 Required Fields (16)

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Knowledge title, concise and clear |
| `description` | string | One-line purpose description |
| `trigger` | string | Trigger keyword, e.g. `@NetworkMonitor` |
| `language` | string | Programming language, e.g. `typescript`, `swift` |
| `kind` | enum | `rule` (constraint) / `pattern` (reusable) / `fact` (project fact) |
| `category` | string | `View`/`Service`/`Tool`/`Model`/`Network`/`Storage`/`UI`/`Utility` |
| `knowledgeType` | string | Knowledge type identifier |
| `doClause` | string | ✅ What to do (Channel A+B hard dependency) |
| `dontClause` | string | ❌ What not to do |
| `whenClause` | string | When to apply (Channel B hard dependency) |
| `coreCode` | string | Core code snippet |
| `headers` | string[] | Complete import statement list |
| `usageGuide` | string | Usage guide (Markdown, see format below) |
| `content` | object | `{ markdown: string, rationale: string }` — at minimum provide markdown |
| `reasoning` | object | `{ whyStandard: string, sources: string[], confidence: number }` |

### Optional Fields

`topicHint`, `complexity` (beginner/intermediate/advanced), `scope` (universal/project-specific/target-specific), `tags` (string[]), `constraints`, `relations`, `skipDuplicateCheck` (default false)

### usageGuide Format Requirements

**Must** use Markdown sections. Never write as a single long line.

```markdown
### When to Use
- Scenario A
- Scenario B

### When Not to Use
- Exclusion scenario

### Steps
1. First step
2. Second step

### Key Points
- Note A
- Note B
```

Optional sections: Dependencies & Prerequisites, Error Handling, Performance & Resources, Security & Compliance, Common Misuse, Alternatives, Related Knowledge.

---

## Batch Submission — autosnippet_submit_knowledge (items array)

Submit multiple entries at once. Each is validated independently; failures are rejected without blocking others.

### Parameters

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `items` | ✅ | object[] | Array of knowledge entries, each following the same field structure as single submission |

### Response

```json
{
  "count": 3,
  "total": 5,
  "ids": ["id1", "id2", "id3"],
  "errors": ["item[2]: missing doClause"],
  "rejectedItems": [2, 4],
  "rejectedSummary": { "commonMissingFields": ["doClause", "reasoning"] }
}
```

**Batch validation is stricter**: single submission stores entries even with validation warnings (with hints), **batch submission rejects entries that fail validation**.

---

## Submission Workflow

### Standard Flow (Agent via MCP)

```
1. Analyze code → construct V3 fields
2. autosnippet_submit_knowledge → stored as pending
3. Check response:
   - Success → inform user "Submitted. Review in Dashboard Candidates."
   - Has rejectedItems → fill in missing fields per rejectedSummary.commonMissingFields, retry
4. [Optional] autosnippet_enrich_candidates → diagnose candidate field completeness
```

### One Entry Per Scenario

Splitting principle: different use cases, different API endpoints, different configurations → separate entries each. Never merge multiple patterns into one.

### Batch Anti-Redundancy Rules (⚠️ MANDATORY)

**Items in the array must NOT be cross-redundant**:
- No highly overlapping doClause / coreCode / trigger entries within the same batch
- If two entries share 80%+ content, **merge into one** or split into **primary + extends supplementary** entries
- Primary entry contains complete core content; supplementary entry contains only the differences, referencing the primary trigger in `_relations.extends`
- The system only detects fusion between "candidates vs existing DB entries" — **it does NOT check intra-batch redundancy** — Agent must self-enforce

**Example**: Two routing knowledge entries (registration flow + dispatch supplement) should be structured as:
1. Primary: Complete route registration pattern (register + open + doc sync)
2. Supplementary: Only deepLink/Modal/Tab stack differences, `_relations.extends → primary trigger`

---

## Post-Submission Management

| Need | Tool |
|------|------|
| Check candidate status | `autosnippet_knowledge(operation=list)` |
| Diagnose missing fields | `autosnippet_enrich_candidates` |
| Review/publish | `autosnippet_knowledge_lifecycle(operation=approve/publish/fast_track)` |
| Search existing knowledge to avoid duplicates | `autosnippet_search(mode=context, query=...)` |

---

## Kind Routing & Pipeline Impact

| kind | Purpose | Pipeline Output |
|------|---------|-----------------|
| `rule` | Coding conventions, constraints | → Channel A (.mdc rule files) |
| `pattern` | Code patterns, usage | → Channel B (.mdc pattern files + Snippet) |
| `fact` | Project facts, architecture decisions | → Search/Guard context, no direct file output |

`doClause` is a **hard dependency** for Channel A+B — missing this field means .mdc files cannot be generated at all.

---

## Example: Submit One Entry

```json
{
  "title": "Network Monitor — Connectivity Listener",
  "description": "Monitor network connectivity changes using NWPathMonitor",
  "trigger": "@NetworkMonitor",
  "language": "swift",
  "kind": "pattern",
  "category": "Network",
  "knowledgeType": "api-usage",
  "doClause": "Use NWPathMonitor to observe network status changes; dispatch UI updates to the main queue",
  "dontClause": "Do not use the deprecated Reachability library; do not update UI directly on background threads",
  "whenClause": "When the app needs real-time network connectivity awareness",
  "coreCode": "let monitor = NWPathMonitor()\nmonitor.pathUpdateHandler = { path in\n  DispatchQueue.main.async {\n    self.isConnected = path.status == .satisfied\n  }\n}\nmonitor.start(queue: DispatchQueue.global())",
  "headers": ["import Network"],
  "usageGuide": "### When to Use\n- App needs real-time network status\n- Initialize once at launch\n\n### Key Points\n- Access via singleton sharedMonitor\n- start() begins monitoring, cancel() stops\n- Callback runs on global queue; switch to main thread for UI updates",
  "content": {
    "markdown": "NWPathMonitor is the recommended network status monitoring API for iOS 12+, replacing deprecated Reachability.",
    "rationale": "Apple-recommended, thread-safe, supports cellular/WiFi/wired detection."
  },
  "reasoning": {
    "whyStandard": "Apple Developer Documentation recommended approach, replacing SCNetworkReachability",
    "sources": ["Apple Developer Documentation - NWPathMonitor"],
    "confidence": 0.95
  }
}
```
