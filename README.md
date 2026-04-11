<div align="center">

# AutoSnippet

Extract patterns from your codebase into a knowledge base that AI coding assistants can query in your IDE — so generated code actually follows your team's conventions.

[![npm version](https://img.shields.io/npm/v/autosnippet.svg?style=flat-square)](https://www.npmjs.com/package/autosnippet)
[![License](https://img.shields.io/npm/l/autosnippet.svg?style=flat-square)](https://github.com/GxFn/AutoSnippet/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen?style=flat-square)](https://nodejs.org)

[中文](README_CN.md)

</div>

---

- [Why](#why) · [Getting Started](#getting-started) · [Using in IDE](#using-in-ide) · [Evolution Architecture](#evolution-architecture) · [Engineering Capabilities](#engineering-capabilities) · [IDE Support](#ide-support) · [Docs](#docs)

## Why

Copilot and Cursor don't know how your team writes code. What they generate works, but doesn't look like yours — wrong naming, wrong patterns, wrong abstractions. You end up rewriting AI output or explaining the same conventions in every Code Review.

AutoSnippet builds a layer of **localized project memory**. It scans your codebase, extracts valuable patterns (with your approval), and makes them searchable by all AI tools via [MCP](https://modelcontextprotocol.io/). Knowledge persists locally, never consuming the LLM context window — it's injected on-demand when the AI needs it. The more knowledge accumulates, the more the generated code matches your conventions.

```
Your code  →  AI extracts patterns  →  You review  →  Knowledge base
                                                        ↓
                                        Cursor / Copilot / VS Code / Xcode
                                                        ↓
                                              AI generates your way
```

## Getting Started

```bash
npm install -g autosnippet

cd your-project
asd setup     # Initialize workspace + database + MCP config (auto-detects Cursor / VS Code / Trae / Qoder)
asd ui        # Start background service (MCP Server + Dashboard) — IDE and MCP tools depend on this
```

> **Trae / Qoder users:** After `asd setup`, run `asd mirror` to sync `.cursor/` config to `.trae/` / `.qoder/`.

## Using in IDE

`asd setup` configures everything. Open your IDE's **Agent Mode** (Cursor Composer / VS Code Copilot Chat / Trae) and start chatting.

> **First time:** Manually enable the `autosnippet` service in your IDE's MCP settings.

> **Tip:** Stronger models work better. We recommend Claude Opus 4 / Sonnet 4, GPT-5, or Gemini 3 Pro in Cursor / Copilot for more accurate patterns and fewer false positives.

### Cold Start: Build Your Knowledge Base

> 💬 *"Cold start — build the project knowledge base"*

The Agent scans your entire project, extracting coding patterns, architecture conventions, and call habits, while generating a project Wiki. Cold start runs once; after that, it's daily use.

### Daily Use: Just Ask

| You say | You get |
|---------|---------|
| ① *"How do we write API endpoints in this project?"* | Code following your project's actual style, not generic examples |
| ② *"Write a user registration endpoint"* | Generated code automatically follows the API conventions just retrieved |
| ③ *"Check if this file follows our conventions"* | Pre-commit convention check — fewer back-and-forths in Code Review |
| ④ *"Save this error handling pattern as a project convention"* | One-time capture — every team member's AI learns this pattern |

After the Agent finishes writing code, the Guard compliance engine auto-checks the diff — violations trigger self-repair, no manual intervention needed.

### Gets Better Over Time

Review and approve candidates in Dashboard (`asd ui`) → they become **Recipes** → AI references them when generating code → you spot new good patterns → keep capturing → AI increasingly writes like a team member. Knowledge is local Markdown files, travels with git, never disappears with conversations, and doesn't consume context window — no matter how large the knowledge base grows, it won't slow down AI.

---

## Evolution Architecture

AutoSnippet isn't a static knowledge tool — it's a **knowledge organism**. Recipes are its cells — the IDE Agent is the external driving force, and each interaction triggers coordinated responses from different organs inside the organism.

```
                IDE Agent (Cursor / Copilot / Trae)
                   │
                   │ Capture · Write · Search · Shift · Complete · Boundary
                   │
  ═════════════════▼══════════════════════════════════════
  ║              AutoSnippet Knowledge Organism             ║
  ║                                                        ║
  ║  ┌─ Panorama (Skeleton) ──── Project Structure ───┐   ║
  ║  │                                                │   ║
  ║  │    Signal (Nerves)  ◄────►  Governance (Digest) │   ║
  ║  │        ↕                         ↕             │   ║
  ║  │              ┌──────────┐                      │   ║
  ║  │              │  Recipe  │                      │   ║
  ║  │              │  Living  │                      │   ║
  ║  │              │Knowledge │                      │   ║
  ║  │              └──────────┘                      │   ║
  ║  │        ↕                         ↕             │   ║
  ║  │    Guard (Immunity) ◄────►  Tool Forge (Create) │   ║
  ║  │                                                │   ║
  ║  └────────────────────────────────────────────────┘   ║
  ║                                                        ║
  ══════════════════════════════════════════════════════════
```

### Agent Actions × Organism Responses

Each IDE Agent action triggers coordinated responses from different organs:

| Agent Action | Organism Response | Organs Involved |
|-------------|------------------|-----------------|
| **Capture knowledge** — extract and submit patterns | Digestive system metabolizes internally: confidence routing → staging observation → evolves or decays. Developer retains full intervention rights | Digest → Nerves |
| **Write code** — start coding | Nervous system analyzes intent, auto-injects relevant Recipes with sourceRefs source evidence for higher trust | Nerves → Recipe |
| **Search knowledge** — active search | Precise retrieval based on current intent + file context, multi-path fusion ranking, dynamic weight adjustment per scenario | Nerves → Recipe |
| **Shift intent** — change direction | Nervous system records drift signals, senses problems; immune system reverse-checks whether Recipes are still valid | Nerves → Immunity |
| **Complete task** — finish writing code | Immune system triggers Guard Review, attaches relevant Recipes for Agent to fix violations | Immunity → Recipe |
| **Capability boundary** — hit an unsolvable problem | Creation system calls LLM to forge temporary tools, vm-sandboxed execution, auto-reclaimed on expiry | Create |

### Five Organs

**Skeleton — Panorama**

The organism's structural awareness. AST + call graphs infer module roles & layers (four-signal fusion, 13 role types), Tarjan SCC computes coupling, Kahn topological sort infers layering, DimensionAnalyzer generates 11-dimension health radar, outputting coverage heatmaps and gap reports. All organs share this project overview.

**Digest — Governance**

The metabolic engine for new knowledge entering the organism. ContradictionDetector finds conflicts, RedundancyAnalyzer flags duplication, DecayDetector scores decay (6 strategies + 4-dimension scoring), ConfidenceRouter numerically routes (≥ 0.85 auto-publishes, < 0.2 rejects). ProposalExecutor auto-executes evolution proposals on expiry (7 types, differentiated observation windows). Six-state lifecycle: `pending → staging → active → evolving/decaying → deprecated`.

**Nerves — Signal + Intent**

Senses all Agent behavior. IntentExtractor extracts terms, infers language and module, cross-language synonym expansion, identifies 4 scenarios. SignalBus unifies 12 signal types (guard / search / usage / lifecycle / quality / exploration / panorama / decay / forge / intent / anomaly / guard_blind_spot), HitRecorder batches usage events. When the Agent shifts intent, nerves record drift signals and coordinate the immune system for reverse checking.

**Immunity — Guard**

Bidirectional immune system. Forward: four-layer detection (regex → code-level multi-line → tree-sitter AST → cross-file), built-in 8-language rules, three-state output (pass / violation / uncertain). Backward: ReverseGuard verifies Recipe-referenced API symbols still exist (5 drift types). Auto-triggers Review when Agent completes a task, handing violations along with relevant Recipes to the Agent for fixing. RuleLearner tracks P/R/F1 for auto-tuning.

**Create — Tool Forge**

Creativity at capability boundaries. Three progressive modes — Reuse (0ms) → Compose (10ms, atomic tool assembly) → Generate (~5s, LLM writes code → vm sandbox validation: 5s timeout + 18 security rules). Temporary tools have 30min TTL, auto-reclaimed on expiry. LLM participates only during forging; execution is fully deterministic.

### Design Philosophy

1. **AI Compile-Time + Engineering Runtime** — LLM produces deterministic artifacts; runtime is pure engineering logic
2. **Deterministic Marking + Probabilistic Resolution** — Each layer does its deterministic part; uncertainty escalates to AI
3. **Orthogonal Composition > Specialized Subclasses** — Capability × Strategy × Policy replaces N subclasses
4. **Signal-Driven > Time-Driven** — Trigger on signal saturation, not scheduled scans
5. **Defense in Depth** — Constitution → Gateway → Permission → SafetyPolicy → PathGuard → ConfidenceRouter

> Organ implementation details, engineering metrics, and defense chain breakdown in [Technical Reference](docs/technical-reference.en.md)

---

## Engineering Capabilities

The above is the organism itself. Below are the engineering integration capabilities it exposes.

### Guard CLI

```bash
asd guard src/             # Check directory
asd guard:staged           # pre-commit: staged files only
asd guard:ci --min-score 90   # CI quality gate
```

### Multi-Language AST

11-language tree-sitter: Go · Python · Java · Kotlin · Swift · JS · TS · Rust · ObjC · Dart · C#. 5-stage CallGraph, incremental analysis, 8 project types auto-detected.

### 6-Channel IDE Delivery

Knowledge changes auto-deliver to IDE-consumable formats:

| Channel | Path | Content |
|---------|------|---------|
| **A** | `.cursor/rules/autosnippet-project-rules.mdc` | alwaysApply one-liner rules |
| **B** | `.cursor/rules/autosnippet-patterns-{topic}.mdc` | When/Do/Don't themed rules |
| **C · D** | `.cursor/skills/` | Project Skills + development docs |
| **F** | `AGENTS.md` / `CLAUDE.md` / `.github/copilot-instructions.md` | Agent instructions |
| **Mirror** | `.qoder/` / `.trae/` | IDE mirrors |

### More

- **Bootstrap Cold Start** — 6-phase · 10-dimension analysis, one-time knowledge base build
- **Knowledge Graph** — 14 relationship types, query impact paths and dependency depth
- **Semantic Search** — HNSW vector index + field-weighted scoring hybrid, RRF fusion + 7-signal ranking
- **sourceRefs** — Recipes carry source evidence, Agent trusts without self-verification
- **Lark Remote** — Message from phone, intent routes to Bot or IDE
- **Remote Repository** — Recipe directory as git sub-repo, shared across projects

> AI-driven features require an LLM API Key. Supports Google / OpenAI / Claude / DeepSeek / Ollama with automatic fallback.

---

## Project Structure

After `asd setup`, your project gains these:

```
your-project/
├── AutoSnippet/           # Knowledge data (git-tracked)
│   ├── recipes/           # Reviewed patterns (Markdown)
│   ├── candidates/        # Pending review
│   ├── skills/            # Project-specific Agent instructions
│   └── wiki/              # Project Wiki
├── .autosnippet/          # Runtime cache (gitignored)
│   ├── autosnippet.db     # SQLite (WAL mode)
│   └── context/           # Vector index (HNSW)
├── .cursor/
│   ├── mcp.json           # Cursor MCP config
│   ├── rules/             # Channel A + B rules
│   └── skills/            # Channel C + D Skills
├── .vscode/mcp.json       # VS Code MCP config
├── .github/copilot-instructions.md
├── AGENTS.md
└── CLAUDE.md
```

Recipes are Markdown files. SQLite is just a read cache. If the database breaks, `asd sync` rebuilds it.

---

## IDE Support

| IDE | Integration | Details |
|-----|------------|---------|
| **VS Code** | Extension + MCP | `#asd` tool references in Agent Mode; search, directives, CodeLens, Guard diagnostic squiggles, light-bulb fixes |
| **Cursor** | MCP + Rules | `.cursor/mcp.json` + `.cursor/rules/` + `.cursor/skills/` |
| **Claude Code** | MCP + CLAUDE.md | `CLAUDE.md` + MCP tools; supports hooks |
| **Trae / Qoder** | MCP | `asd setup` auto-generates, `asd mirror` syncs config |
| **Xcode** | File watching | `asd watch` + file directives + Snippet sync |
| **Lark** | Bot + WebSocket | Message from phone → intent recognition → Bot Agent or IDE Agent Mode execution |

### VS Code Extension

- **Comment Directives**: `// as:s <query>` search & insert, `// as:c` create candidate from selection, `// as:a` audit current file
- **CodeLens**: Clickable actions above directives
- **Guard Diagnostics**: Violations shown as squiggles + light-bulb quick fixes
- **Status Bar**: Live API Server connection status

All configuration auto-generated by `asd setup`. Run `asd upgrade` after updates.

---

## Docs

| Document | Content |
|----------|---------|
| **[Technical Book](https://docs.gaoxuefeng.com/part1/ch01-introduction)** | **Deep dive into every module — architecture decisions, data flows, and implementation details** |
| [Technical Reference](docs/technical-reference.en.md) | Six subsystem implementation details, engineering metrics, defense chain |
| [Dashboard](docs/dashboard.en.md) | Dashboard views and tech stack |
| [CLI Reference](docs/cli-reference.en.md) | Full usage for all 20 commands |
| [MCP Tools Reference](docs/mcp-tools.en.md) | 16 MCP tools with parameters and usage |
| [Architecture](docs/architecture.en.md) | Overall architecture and module design |
| [Configuration](docs/configuration.en.md) | LLM and advanced configuration options |
| [Guard Guide](docs/guard.en.md) | Guard rules and customization |
| [IDE Integration](docs/ide-integration.en.md) | Detailed IDE setup guides |
| [Lark Integration](docs/lark-integration.en.md) | Lark Bot setup and usage |
| [Agent Architecture](docs/agent-architecture.en.md) | Agent Runtime and MCP protocol |
| [Development](docs/development.en.md) | Contributing and dev environment setup |

---

## Requirements

- Node.js ≥ 22
- macOS recommended (Xcode features require it; other features are cross-platform)
- better-sqlite3 (bundled)

## Contributing

1. Run `npm test` before submitting
2. Follow existing code patterns (ESM, domain-driven structure)

## License

[MIT](LICENSE) © gaoxuefeng
