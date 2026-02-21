<div align="center">

# AutoSnippet

**Knowledge Engine for Code — Turn your team's patterns into AI-searchable recipes.**

Capture code patterns, best practices, and architecture decisions as a structured knowledge base.  
Then let Cursor, Copilot, Trae, Qoder, Xcode, and VS Code generate code that follows *your* standards.

[![npm version](https://img.shields.io/npm/v/autosnippet.svg?style=flat-square)](https://www.npmjs.com/package/autosnippet)
[![License](https://img.shields.io/npm/l/autosnippet.svg?style=flat-square)](https://github.com/GxFn/AutoSnippet/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen?style=flat-square)](https://nodejs.org)

[中文文档](README_CN.md)

</div>

---

## The Problem

AI coding assistants generate code in a vacuum — they don't know your team's conventions, architecture patterns, or coding standards. Every AI-generated PR becomes a review burden.

**AutoSnippet** bridges this gap by building a living knowledge base inside your project, making your team's expertise queryable by any AI tool.

```
Your Codebase  ──→  AI Scan & Extract  ──→  Human Review  ──→  Knowledge Base (Recipes)
                                                                       │
                 ┌─────────────────────────────────────────────────────┘
                 ↓
         Cursor / Copilot / Trae / Qoder / Xcode / VS Code
                 ↓
         Code generated following YOUR standards
```

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Recipe** | The atomic unit of knowledge — a code pattern + explanation + metadata. Stored as Markdown in `AutoSnippet/recipes/`, cached in SQLite for fast retrieval |
| **Candidate** | A pending knowledge entry awaiting human review — from AI scans, manual submission, or bootstrap. Promoted to Recipe after approval |
| **Guard** | Code compliance engine — checks source files against knowledge-derived rules at file, target, or project scope |
| **Skill** | Agent instruction sets (18 built-in) — guide AI agents to correctly invoke knowledge base operations |
| **Bootstrap** | Cold-start engine — 9-dimension heuristic scan + dual-agent AI analysis, generating dozens of candidates in one pass |

## Quick Start

```bash
# Install globally
npm install -g autosnippet

# Initialize in your project
cd /path/to/your-project
asd setup              # Creates workspace, DB, IDE integrations, installs VS Code extension

# Cold-start: scan your codebase and extract patterns
asd coldstart          # 9-dimension AI analysis → Candidates

# Launch Dashboard to review and manage knowledge
asd ui                 # Web dashboard + API server
```

> **Important**: Always run `asd` commands inside your project directory, not in the AutoSnippet source repo.

## How It Works

```
┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐
│  ① Setup   │──→ │ ② Cold     │──→ │ ③ Target   │──→ │ ④ Review   │──→ │ ⑤ IDE      │
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

1. **Setup** — `asd setup` creates the workspace structure, SQLite database, MCP configs for Cursor/VS Code/Qoder/Trae, and installs the VS Code extension
2. **Cold Start** — Bootstrap engine scans your codebase across 9 dimensions (architecture, naming, networking, data flow, error handling, etc.) using a dual-agent system (Analyst → Producer)
3. **Target Scan** — `asd ais <target>` performs focused extraction on specific modules
4. **Review** — Dashboard provides card-based review UI with AI confidence scoring, batch approve/reject, and inline editing
5. **IDE Delivery** — Recipes are delivered via MCP tools (real-time), Cursor Rules (`.cursor/rules/`), and Agent Skills
6. **AI Generation** — IDE AI assistants query the knowledge base and generate code following your team's patterns
7. **Continuous Capture** — File watchers detect new patterns, creating a feedback loop

## Features

### 🔍 Multi-Strategy Search Engine

4-layer retrieval funnel with 5 search modes:

| Layer | Strategy | Purpose |
|-------|----------|---------|
| L1 | Inverted Index + BM25 | Fast keyword recall with CJK support |
| L2 | Cross-Encoder Reranker | AI-powered semantic reranking |
| L2.5 | Coarse Ranker (E-E-A-T) | 5-dimension quality scoring |
| L3 | Multi-Signal Ranker | 6-signal weighted ranking (relevance, authority, recency, popularity, difficulty, seasonality) |

### 🤖 AI Integration (6 Providers)

| Provider | Notes |
|----------|-------|
| Google Gemini | Native tool calling + structured output |
| OpenAI | GPT-4o, GPT-4, etc. |
| Claude (Anthropic) | Native tool calling |
| DeepSeek | OpenAI-compatible |
| Ollama | Local models, no API key needed |
| Mock | Auto-fallback when no AI configured |

Auto-detection, priority-based fallback, and context window adaptation.

### 🛡️ Guard — Code Compliance

- **Regex + AST semantic rules** (mustCallThrough, mustNotUseInContext, mustConformToProtocol)
- **3 scopes**: file / target / project
- **CI/CD ready**: `asd guard:ci` with Quality Gate, `asd guard:staged` for pre-commit hooks
- **Rule learning**: Auto-suggest rules from violation patterns (14-day effectiveness tracking)
- **Feedback loop**: Guard violations → Recipe usage confirmation

### 📊 Dashboard (18 Views)

Full-featured web UI launched with `asd ui`:

- **Knowledge Management** — Recipe browser, candidate review, batch operations
- **AI Chat** — ReAct-loop conversation with 54 internal tools
- **Knowledge Graph** — Visual relationship explorer
- **Guard Dashboard** — Rule management, violation tracking, compliance reports
- **SPM / Module Explorer** — Dependency analysis across language ecosystems
- **Wiki Generator** — Auto-generated project documentation with Mermaid diagrams
- **Bootstrap Progress** — Real-time 9-dimension progress with time estimates
- **Skills Manager** — Browse, create, and manage agent skills
- **LLM Config** — Visual AI provider/model/key configuration

### 🔌 IDE Integrations

#### MCP Server (16 Tools)

Works with any MCP-compatible IDE (Cursor, VS Code Copilot, Qoder, Trae):

```bash
# Automatically configured by asd setup
# Or manually: asd setup:mcp
```

12 Agent-tier tools (search, knowledge, structure, graph, guard, submit, skills, bootstrap, etc.) + 4 Admin tools.

#### VS Code Extension

Installed automatically by `asd setup`. Features:

- **Search & Insert** — `Cmd+Shift+F5` opens QuickPick with code preview, inserts at cursor
- **Directive Detection** — Auto-detects `// as:s`, `// as:c`, `// as:a` directives on save
- **CodeLens** — Inline action buttons above directives
- **Guard Audit** — Run compliance checks on files or entire project
- **Create Candidate** — Submit selected code as a knowledge candidate
- **Status Bar** — Real-time API server connection indicator

#### Xcode Integration

- **File Watcher** — `asd watch` monitors files for `// as:` directives
- **Auto-Insertion** — osascript-driven code insertion preserving Undo history
- **Header Management** — Automatic `#import`/`@import` deduplication with SPM-aware decisions
- **Snippet Sync** — Export recipes as native Xcode `.codesnippet` files

### 📝 File Directives

Write directives as comments in any source file:

```objc
// as:s network request timeout    → Search & insert matching recipe
// as:c                            → Create candidate from surrounding code
// as:c -c                         → Create candidate from clipboard
// as:a                            → Run Guard audit on this file
// as:include "MyHeader.h"         → ObjC header import
// as:import UIKit                 → Module import
```

### 🧬 AST Analysis (9 Languages)

Tree-sitter powered code intelligence:

| Language | Capabilities |
|----------|-------------|
| Objective-C, Swift | Full: classes, protocols, categories, extensions, design patterns |
| TypeScript, JavaScript, TSX | Classes, functions, React components, imports |
| Python | Classes, functions, decorators, imports |
| Java, Kotlin | Classes, interfaces, annotations |
| Go | Structs, interfaces, functions |

Plus 11 framework enhancement packs (React, Vue, Spring, Django, FastAPI, gRPC, Android, etc.).

### 🏛️ Constitution & Governance

Three-layer permission model:

1. **Capability Layer** — `git push --dry-run` probes write access (physical signal)
2. **Role Layer** — 3 roles (developer / external_agent / chat_agent) with permission matrix
3. **Governance Layer** — 4 inviolable rules enforced by Constitution engine

Every write operation passes through the Gateway: role check → constitution rules → audit log.

### 🧠 Agent Memory (4 Tiers)

| Tier | Scope | Persistent | Purpose |
|------|-------|-----------|---------|
| Working Memory | Session | No | Scratchpad + context compression |
| Episodic Memory | Cross-dimension | No | Discovery sharing between bootstrap dimensions |
| Project Semantic Memory | Project | SQLite | Permanent facts, insights, preferences (importance scoring + TTL) |
| Tool Result Cache | Cross-dimension | No | Deduplication of tool calls |

## CLI Reference

| Command | Description |
|---------|-------------|
| `asd setup` | Initialize workspace, DB, IDE configs, install VS Code extension |
| `asd coldstart` | Bootstrap knowledge base (9-dimension AI scan) |
| `asd ais [target]` | AI scan source files → extract and publish recipes |
| `asd ui` | Launch Dashboard + API server |
| `asd watch` | Start Xcode file watcher for directives |
| `asd search <query>` | Search knowledge base |
| `asd guard <file>` | Run Guard compliance check |
| `asd guard:ci` | CI/CD full-project Guard + Quality Gate |
| `asd guard:staged` | Check git staged files (pre-commit hook) |
| `asd sync` | Sync `recipes/*.md` → SQLite database |
| `asd upgrade` | Update IDE integrations (MCP, Skills, Rules) |
| `asd cursor-rules` | Generate Cursor 4-channel delivery artifacts |
| `asd server` | Start API server standalone |
| `asd status` | Check environment health |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      IDE Layer                          │
│  Cursor │ VS Code │ Trae │ Qoder │ Xcode │ Dashboard   │
└────────────────────────┬────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              │   MCP Server (16)   │──── HTTP API (REST + WebSocket)
              └──────────┬──────────┘
                         │
┌────────────────────────┴────────────────────────────────┐
│                   Service Layer                         │
│  SearchEngine │ KnowledgeService │ GuardEngine │ Chat   │
│  Bootstrap    │ WikiGenerator    │ Skills      │ SPM    │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────┐
│                    Core Layer                           │
│  AstAnalyzer (9 lang) │ KnowledgeGraph │ CodeEntityGraph│
│  RetrievalFunnel      │ QualityScorer  │ ConfidenceRouter│
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────┐
│                Infrastructure Layer                     │
│  SQLite │ VectorStore │ EventBus │ AuditLog │ Gateway   │
│  DI Container (40+ services) │ Constitution │ PathGuard │
└─────────────────────────────────────────────────────────┘
```

## Configuration

### AI Provider Setup

Create `.env` in your project root (or configure via Dashboard → LLM Config):

```env
# Pick one (or more for fallback)
ASD_GOOGLE_API_KEY=your-gemini-key
ASD_OPENAI_API_KEY=your-openai-key
ASD_CLAUDE_API_KEY=your-claude-key
ASD_DEEPSEEK_API_KEY=your-deepseek-key

# Or use local Ollama (no key needed)
ASD_AI_PROVIDER=ollama
ASD_AI_MODEL=llama3
```

### Project Structure After Setup

```
your-project/
├── AutoSnippet/           # Core data (git sub-repo = Source of Truth)
│   ├── constitution.yaml  # Permission rules
│   ├── recipes/           # Knowledge entries (Markdown)
│   ├── candidates/        # Pending entries
│   └── skills/            # Project-specific skills
├── .autosnippet/          # Runtime (gitignored)
│   ├── config.json        # Project config
│   ├── autosnippet.db     # SQLite cache
│   └── context/           # Vector index cache
├── .cursor/               # Cursor IDE integration
│   ├── mcp.json
│   ├── rules/
│   └── skills/
└── .vscode/               # VS Code integration
    └── settings.json      # MCP server config
```

## Security

- **PathGuard**: 2-layer boundary protection — blocks writes outside project root + whitelist-only allowed paths
- **Constitution**: 4 inviolable rules enforced on every write operation
- **Audit Trail**: Full audit logging with 90-day TTL auto-cleanup
- **No External Calls in postinstall**: Build scripts are purely local (macOS Swift compilation)
- **Gateway**: Every mutation goes through role verification → constitution check → audit log

## Requirements

- **Node.js** ≥ 20.0.0
- **macOS** recommended (required for Xcode integration; other platforms work without Xcode features)
- **SQLite** via better-sqlite3 (bundled)

## Contributing

Contributions are welcome. Please ensure:

1. Run `npm test` before submitting
2. Follow existing code patterns (ESM, domain-driven structure)
3. Guard rules and knowledge entries go through the standard review process

## License

[MIT](LICENSE) © gaoxuefeng
