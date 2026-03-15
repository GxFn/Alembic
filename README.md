<div align="center">

# AutoSnippet

Extract code patterns from your codebase into a knowledge base, and serve them to AI coding assistants in your IDE — so generated code actually follows your team's conventions.

[![npm version](https://img.shields.io/npm/v/autosnippet.svg?style=flat-square)](https://www.npmjs.com/package/autosnippet)
[![License](https://img.shields.io/npm/l/autosnippet.svg?style=flat-square)](https://github.com/GxFn/AutoSnippet/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen?style=flat-square)](https://nodejs.org)

[中文文档](README_CN.md)

</div>

---

- [Why](#why) · [Get Started](#get-started) · [Using in Your IDE](#using-in-your-ide) · [More Capabilities](#more-capabilities) · [Dashboard](#dashboard) · [IDE Support](#ide-support) · [Architecture](docs/architecture.en.md)

## Why

Copilot and Cursor don't know how your team writes code. They'll generate something that works, but it won't look like yours — wrong naming, wrong patterns, wrong abstractions. You end up rewriting the AI's output or explaining the same conventions in every PR review.

AutoSnippet builds a **persistent local memory** for your project. It scans your codebase, extracts the patterns that matter (with your approval), and makes them available to any AI tool via [MCP](https://modelcontextprotocol.io/). This knowledge lives locally, doesn't consume your LLM context window, and is injected on demand when AI needs it — the more knowledge accumulates, the more your AI writes code that actually follows your conventions.

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
asd setup     # workspace + DB + MCP configs (auto-detects Cursor / VS Code / Trae / Qoder)
asd ui        # start the background service (MCP Server + Dashboard) — IDE and MCP tools require this
```

## Using in Your IDE

`asd setup` takes care of everything. Open your IDE's **Agent Mode** (Cursor Composer / VS Code Copilot Chat / Trae) and start talking.

> **Tip:** The stronger your IDE Agent model, the better the results. Choose Claude Opus 4 / Sonnet 4, GPT-5, or Gemini 3 Pro in Cursor / Copilot for more accurate patterns and fewer false positives.

### Cold Start: Build the project knowledge base

> 💬 *"Run a cold start, build the project knowledge base"*

The agent scans the entire project and extracts your team's coding patterns, architecture conventions, and call idioms, generating a project Wiki along the way. You only need to do this once, then it's daily use from here.

### Daily: just say what you need

| You say | You get |
|---------|---------|
| ① *"How do we write API endpoints in this project?"* | Code that matches your project's style, not generic examples |
| ② *"Write a user registration endpoint"* | Generated code automatically follows the API conventions you just looked up |
| ③ *"Check if this file follows the project conventions"* | Pre-commit convention check — fewer round-trips in Code Review |
| ④ *"Save this error handling as a project convention"* | One save, and everyone's AI writes it this way from now on |

After the Agent writes code, the Guard compliance engine automatically checks the diff — violations are self-repaired without you lifting a finger.

### It gets better over time

Review candidates in Dashboard (`asd ui`) → approve as **Recipe** → AI follows your conventions → you spot a good new pattern → save it → AI gets even better at writing code your team's way. Recipes are local Markdown files, tracked by git, never lost between conversations. AI queries them on demand without filling the context window — your knowledge base can grow without slowing AI down.

## More Capabilities

### Guard Compliance Engine

Beyond the Agent's automatic checks, Guard also plugs into your engineering workflow:

```bash
asd guard src/            # Check a directory
asd guard:staged          # Pre-commit: only staged files
asd guard:ci --threshold 90  # CI quality gate
```

Built-in multi-language compliance rules (regex + AST) checking naming, deprecated APIs, thread safety, and more — each violation comes with a fix example.

### Call Graph

Want to know the blast radius before refactoring a function? Static call graph analysis across 8 languages — query any function's callers, callees, and impact radius via MCP tools `call_graph` and `call_context`.

### Semantic Search

Keyword search only finds literal matches. With an LLM API Key, search upgrades to vector + BM25 hybrid retrieval — asking "how to manage memory" finds Recipes about garbage collection, semantically similar results rank first.

### Knowledge Graph

Recipes have relationships. Query impact paths, dependency depth, and related Recipes for any module — once you've accumulated enough knowledge, it helps you see the structure behind it.

### TaskGraph Orchestration

Break a large task into steps, declare dependencies between them, and each step auto-injects relevant Recipes as context. Team decisions (rationale, confidence) persist alongside tasks — they don't vanish with the conversation.

### Self-Cycling Signal Mechanism

AutoSnippet quietly collects your coding habit signals in the background (Guard violations, conversation topics, Recipe usage, candidate backlog, operation logs, git diff), and AI mines patterns to recommend Skills. Don't like one? Delete it — zero commitment. But if a recommendation happens to nail a team habit you never wrote down — that's a freebie. Your adopt/dismiss actions feed back into the algorithm, making recommendations more precise over time.

### Lark Remote Programming

Send a message on Lark (Feishu) from your phone — intent recognition auto-routes it to your local IDE, Copilot Agent Mode executes, results sent back to Lark. Refactor, screenshot, look up conventions — you don't need to be near your computer, as long as it's not asleep.

### Recipe Remote Repository

`asd remote <url>` converts your knowledge base directory into an independent git sub-repository. Share Recipes across projects with separate access control, unified management, and version tracking.

> Semantic search, signal recommendations, Lark remote, and other AI-driven features require an LLM API Key. Set it up in the Dashboard's LLM Config panel, or add it to your `.env` — supports Google / OpenAI / Claude / DeepSeek / Ollama, with auto-fallback.

## Dashboard

Run `asd ui` to manage everything in one place:

<div align="center">
<img src="docs/images/dashboard-help-en.png" alt="Dashboard Help" width="800" />
</div>

## IDE Support

| IDE | Integration | How it connects |
|-----|-------------|----------------|
| **VS Code** | Extension + MCP | `#asd` in Agent Mode; search, directives, CodeLens, Guard |
| **Cursor** | MCP + Rules | `.cursor/mcp.json` + `.cursor/rules/` |
| **Claude Code** | MCP + CLAUDE.md | `CLAUDE.md` + MCP tools; supports hooks |
| **Trae / Qoder** | MCP | Auto-generated by `asd setup` |
| **Xcode** | File watcher | `asd watch` + file directives + snippet sync |
| **Lark (Feishu)** | Bot + WebSocket | Send commands from phone → IDE executes via Copilot Agent Mode |

All configs generated by `asd setup`. Run `asd upgrade` to refresh after updates.

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

## Configuration Details

See [Configuration Guide](docs/configuration.en.md) for more LLM configuration options.

## Architecture

See [Architecture Documentation](docs/architecture.en.md) for the full system design.

## Requirements

- Node.js ≥ 22
- macOS recommended (Xcode features need it; everything else is cross-platform)
- better-sqlite3 (bundled)

## Contributing

1. `npm test` before submitting
2. Follow existing patterns (ESM, domain-driven structure)

## License

[MIT](LICENSE) © gaoxuefeng
