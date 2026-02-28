<div align="center">

# AutoSnippet

Extract code patterns from your codebase into a knowledge base, and serve them to AI coding assistants in your IDE — so generated code actually follows your team's conventions.

[![npm version](https://img.shields.io/npm/v/autosnippet.svg?style=flat-square)](https://www.npmjs.com/package/autosnippet)
[![License](https://img.shields.io/npm/l/autosnippet.svg?style=flat-square)](https://github.com/GxFn/AutoSnippet/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen?style=flat-square)](https://nodejs.org)

[中文文档](README_CN.md)

</div>

---

## Why

Copilot and Cursor don't know how your team writes code. They'll generate something that works, but it won't look like yours — wrong naming, wrong patterns, wrong abstractions. You end up rewriting the AI's output or explaining the same conventions in every PR review.

AutoSnippet fixes this. It scans your codebase, extracts the patterns that matter (with your approval), and makes them available to any AI tool via [MCP](https://modelcontextprotocol.io/). Next time Cursor generates code, it actually follows your conventions.

```
Your code  →  AI extracts patterns  →  You review  →  Knowledge base
                                                            ↓
                                              Cursor / Copilot / VS Code / Xcode
                                                            ↓
                                                  AI follows your patterns
```

## Get Started

```bash
npm install -g autosnippet

cd your-project
asd setup        # workspace + DB + IDE configs (Cursor, VS Code, Trae, Qoder)
asd coldstart    # scans your code, generates pattern candidates
asd ui           # open the dashboard to review what was found
```

That's it. After you approve some candidates, they become **Recipes** — structured knowledge entries that your IDE's AI can query in real time.

## How It Works

```
┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐
│  ① Setup   │──→ │ ② Cold    │──→ │ ③ Target  │──→ │ ④ Revie    │──→ │ ⑤ IDE      │
│  asd setup │    │   Start    │    │   Scan     │    │  Dashboard │    │  Delivery  │
└────────────┘    └────────────┘    └────────────┘    └────────────┘    └─────┬──────┘
                                                                              │
      ┌───────────────────────────────────────────────────────────────────────┘
      ↓
┌────────────┐    ┌────────────┐
│ ⑥ AI Codes │──→ │ ⑦ New      │──→  Back to ③
│ by Rules   │    │  Patterns  │
└────────────┘    └────────────┘
```

1. **`asd setup`** — Creates the workspace, SQLite DB, MCP configs for your IDEs, installs the VS Code extension.
2. **`asd coldstart`** — Scans your codebase from multiple angles (architecture, naming, error handling, etc.). Produces **Candidates** — pattern drafts for you to review.
3. **Review in Dashboard** — Approve, edit, or reject. Approved candidates become Recipes.
4. **IDE picks them up** — Via MCP, Cursor Rules, or Agent Skills. When AI generates code, it checks your Recipes first.
5. **Keep going** — As you write new code, scan again. The knowledge base grows with your project.

You can also scan specific modules with `asd ais <target>`. Better yet, just describe what you want in Cursor using natural language — the AI will automatically invoke the knowledge base to scan and submit patterns for you.

## Dual Pipeline — Internal Agent & External Agent

Every core capability works through two fully independent pipelines. Pick whichever fits your setup — or use both:

| Capability | Internal Agent (built-in AI) | External Agent (IDE-driven) |
|---|---|---|
| **Cold Start** | Analyst/Producer dual-agent auto-scan | IDE agent reads Mission Briefing + MCP tools |
| **Knowledge Extraction** | `asd ais` → built-in AI pipeline | Cursor/Copilot calls `submit_with_check` |
| **Project Skills** | Auto-generated from analysis text | IDE agent calls `autosnippet_skill(create)` |
| **Repo Wiki** | Auto-generated at end of cold start | IDE agent calls wiki MCP tools |
| **Guard** | Built-in rule engine (no AI needed) | Same — shared infrastructure |
| **Search & Retrieval** | MCP server serves results | Same — shared infrastructure |
| **Requires** | AI provider API key | IDE with agent capabilities |

If no AI is available at all, a rule-based fallback still extracts basic knowledge from AST and Guard data.

> **LLM quality matters.** Higher-capability models (Claude Opus/Sonnet, GPT-4o, Gemini 2.5 Pro) produce significantly better results — more accurate patterns, richer architectural insights, fewer false positives.

## What's in the Box

**Pattern extraction** — AI reads your code, identifies reusable patterns, and structures them as Recipes with code, explanation, metadata, and usage guidelines. Supports ObjC, Swift, TypeScript, JavaScript, Python, Java, Kotlin, Go, Ruby (9 languages via Tree-sitter AST).

**Search** — BM25 keyword matching → semantic reranking → quality scoring → multi-signal ranking. Works in Chinese and English.

**Guard** — Regex and AST-based compliance rules derived from your Recipes. Run on files, modules, or the whole project. Hooks into CI with `asd guard:ci` and git pre-commit with `asd guard:staged`.

**Dashboard** — Web UI (`asd ui`) for everything: browsing Recipes, reviewing Candidates, AI chat, knowledge graph visualization, Guard reports, module explorer, project wiki generation, and LLM config.

**IDE integration** — MCP server (works with Cursor, VS Code, Qoder, Trae), VS Code extension (search, directives, CodeLens, Guard), Xcode support (file watcher, auto-insertion, snippet sync).

**AI providers** — Google Gemini, OpenAI, Claude, DeepSeek, Ollama (local), with auto-fallback between them. Or no AI at all — the knowledge base works without it.

## Persistent Decisions & Context

TaskGraph stores team decisions and task status in `.autosnippet/autosnippet.db` — AI assistants don't start from scratch every conversation.

- **`autosnippet_ready`** — Loads active decisions and pending tasks into context. Called at session start.
- **`autosnippet_decide`** — Saves a team agreement (e.g. "use camelCase for API fields") that persists across sessions.
- **`autosnippet_task`** — Task CRUD: create, claim, close, fail, defer, progress, decompose.
- **Auto-inject** — Every subsequent tool call carries active decisions automatically.

Access via CLI `asd task`, MCP tools (`autosnippet_ready` / `autosnippet_decide` / `autosnippet_task`), or `#asd` in VS Code Agent Mode.

## IDE Support

| IDE | Integration | How it connects |
|-----|-------------|----------------|
| **VS Code** | Extension + MCP | `#asd` in Agent Mode; search, directives, CodeLens, Guard |
| **Cursor** | MCP + Rules | `.cursor/mcp.json` + `.cursor/rules/` |
| **Claude Code** | MCP + CLAUDE.md | `CLAUDE.md` + MCP tools; supports plugins |
| **Trae / Qoder** | MCP | Auto-generated by `asd setup` |
| **Xcode** | File watcher | `asd watch` + file directives + snippet sync |

All configs generated by `asd setup`. Run `asd upgrade` to refresh after updates.

## File Directives

Write these in any source file:

```
// as:s network timeout       Search recipes and insert the match
// as:c                       Create a candidate from surrounding code
// as:a                       Run Guard audit on this file
```

The VS Code extension and `asd watch` (Xcode) pick these up automatically.

## CLI

| Command | What it does |
|---------|-------------|
| `asd setup` | Init workspace, DB, IDE configs |
| `asd coldstart` | Full codebase scan → candidates |
| `asd ais [target]` | Scan a specific module |
| `asd ui` | Dashboard + API server |
| `asd search <query>` | Search knowledge base |
| `asd guard <file>` | Run compliance check |
| `asd guard:ci` | CI mode with quality gate |
| `asd guard:staged` | Pre-commit hook |
| `asd watch` | Xcode file watcher |
| `asd sync` | Sync recipe markdown → DB |
| `asd task` | Task management (TaskGraph) |
| `asd upgrade` | Update IDE integrations |
| `asd status` | Health check |

## Project Structure

After `asd setup`, your project gets:

```
your-project/
├── AutoSnippet/           # Knowledge data (git-tracked)
│   ├── recipes/           # Approved patterns (Markdown)
│   ├── candidates/        # Pending review
│   └── skills/            # Project-specific agent instructions
├── .autosnippet/          # Runtime cache (gitignored)
│   ├── autosnippet.db     # SQLite
│   └── context/           # Vector index
├── .cursor/mcp.json       # Cursor MCP config
└── .vscode/mcp.json       # VS Code MCP config
```

Recipes are Markdown files. SQLite is a read cache. If the DB breaks, `asd sync` rebuilds it.

## Configuration

Put a `.env` in your project root, or use Dashboard → LLM Config:

```env
# Pick one (multiple = auto-fallback)
ASD_GOOGLE_API_KEY=...
ASD_OPENAI_API_KEY=...
ASD_CLAUDE_API_KEY=...
ASD_DEEPSEEK_API_KEY=...

# Or run local
ASD_AI_PROVIDER=ollama
ASD_AI_MODEL=llama3
```

## Architecture

```
IDE Layer          Cursor · VS Code · Trae · Qoder · Xcode · Dashboard
                                      │
                              MCP Server + HTTP API
                                      │
Service Layer      Search · Knowledge · Guard · Chat · Bootstrap · Wiki
                                      │
Core Layer         AST (9 lang) · KnowledgeGraph · RetrievalFunnel · QualityScorer
                                      │
Infrastructure     SQLite · VectorStore · EventBus · AuditLog · DI Container (40+)
```

## Requirements

- Node.js ≥ 20
- macOS recommended (Xcode features need it; everything else is cross-platform)
- better-sqlite3 (bundled)

## Contributing

1. `npm test` before submitting
2. Follow existing patterns (ESM, domain-driven structure)

## License

[MIT](LICENSE) © gaoxuefeng
