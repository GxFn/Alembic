<div align="center">

# Alembic

Distill your codebase into a knowledge base that AI coding agents query while they work — so generated code actually follows your team's conventions.

[![npm version](https://img.shields.io/npm/v/alembic-ai.svg?style=flat-square)](https://www.npmjs.com/package/alembic-ai)
[![License](https://img.shields.io/npm/l/alembic-ai.svg?style=flat-square)](https://github.com/GxFn/Alembic/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen?style=flat-square)](https://nodejs.org)

[中文](README_CN.md)

</div>

---

- [Why](#why) · [Installation](#installation) · [Usage](#usage) · [What Is a Recipe](#what-is-a-recipe) · [The Knowledge Organism](#the-knowledge-organism) · [One Product, Five Repositories](#one-product-five-repositories) · [Engineering Capabilities](#engineering-capabilities) · [Dashboard](#dashboard) · [Project Layout](#project-layout) · [Requirements](#requirements) · [Deep Dive](#deep-dive)

## Why

Codex and Claude Code don't know how your team writes code. What they generate works, but doesn't look like yours — wrong naming, wrong patterns, wrong abstractions. You end up rewriting AI output or explaining the same conventions in every Code Review.

Alembic builds a layer of **localized project memory**. It distills your codebase into reviewed, source-anchored **Recipes** and serves them back to your coding agent on demand over [MCP](https://modelcontextprotocol.io/). Knowledge persists locally as Markdown, never consuming the LLM context window; every Recipe carries `sourceRefs` — evidence anchored to real files — so agents trust it without re-verifying. The more knowledge accumulates, the more generated code matches your conventions.

```
Your code  →  AI mines patterns  →  You review  →  Recipe knowledge base
                                                        ↓
                                       Codex / Claude Code, on demand
                                                        ↓
                                              AI generates your way
```

The **plugin is the entry point — and a complete experience on its own**: initialize, query structure, generate and use Recipes right inside Codex or Claude Code, no API key needed. **Full Alembic is an optional upgrade**: configure a provider such as DeepSeek, and a dedicated mining agent builds you a deeper, better knowledge base — with a Dashboard to review it. Both share the same deterministic knowledge contracts — two hosts, one source.

## Installation

### The plugin — Codex / Claude Code (the entry point)

```bash
# Codex
codex plugin marketplace add GxFn/AlembicCodex --ref main

# Claude Code
claude plugin marketplace add GxFn/AlembicClaudeCode
claude plugin install alembic@gxfn
```

The plugin alone is a complete experience: structure queries work out of the box (`alembic_graph` — no knowledge base, no AI required), and cold start, daily retrieval, and convention checks all happen in conversation. Ghost mode by default, zero files in your repository, no API key.

### Full Alembic — optional, for a better knowledge base

```bash
npm install -g alembic-ai

cd your-project
alembic setup --ghost
alembic start
```

The full install unlocks the dedicated mining agent, **AlembicAgent**: configure any provider — DeepSeek / OpenAI / Claude / Gemini / Ollama — and it mines autonomously in daemon jobs, through cold start, incremental rescan, deep-mining rounds, AI scans, and evolution checks. It doesn't occupy your coding agent, and it digs deeper. You also get the Dashboard for review and Guard for pre-commit / CI.

## Usage

Once installed, tell your agent:

> 💬 *"Cold start — build the project knowledge base."*

The plugin drafts a mining plan from real project facts and walks your agent through dimension-by-dimension distillation. With the full install, you can hand the same job to the dedicated mining agent from the Dashboard instead.

Daily use is conversation, not commands:

| You say | You get |
|---------|---------|
| ① *"How do we write API endpoints in this project?"* | Your project's actual conventions, with source evidence attached |
| ② *"Write a user registration endpoint"* | Code that follows the conventions just retrieved — primed before generation |
| ③ *"Check this file against our standards"* | A convention health-check: violations, honest uncertainties, fix suggestions |
| ④ *"Save this error-handling pattern as a convention"* | A grounded candidate that every teammate's AI will learn |

Behind these sentences sit four verbs — **prime** before writing, **search** on demand, **guard** at the finish, **capture** what's worth keeping. Structure questions ("what depends on this module?") ride the same conversation, answered from the project map instead of guesswork. And maintenance needs no scheduler: knowledge metabolism ticks on ordinary access — no cron, no background daemon.

### Gets Better Over Time

Review candidates in the Dashboard (`alembic start`) → they become **Recipes** → agents reference them when generating → you spot new good patterns → keep capturing. Knowledge is local Markdown, travels with git, never disappears with conversations, and doesn't consume context window — no matter how large the base grows.

---

## What Is a Recipe

A Recipe is Alembic's unit of knowledge — the **integrated abstraction** of project fundamentals, design patterns, architecture conventions, and team SOPs. Each Recipe binds three layers together:

| Layer | What's inside |
|-------|---------------|
| **Pattern & convention text** | The rule in natural language — when it applies, what to do, what to avoid. Readable by humans and AI alike |
| **Code paradigm & real pointers** | An exemplar snippet plus `sourceRefs` pointing at real files in your repo — evidence you can re-check, with verbatim probes keeping snippet and source in sync |
| **Operational data** | Lifecycle state, confidence and authority, usage and freshness records — updated, decayed, or deprecated as the code evolves |

So a Recipe is not a doc excerpt, not a code comment, not a static encyclopedia entry. It is a **living unit of knowledge** — retrievable, injectable, cited by convention checks, metabolized over time — stored as Markdown, traveling with git.

---

## The Knowledge Organism

Alembic isn't a static knowledge tool — it's a **knowledge organism**. Recipes are its cells; the coding agent is the external driving force; each interaction triggers coordinated responses from the organs inside.

```
        AI Coding Agent (Codex / Claude Code)          Dashboard (you)
                  │                                        │
                  │  Capture · Write · Search ·            │  review · approve
                  │  Finish · Evolve                       │  evolve · deprecate
                  │                                        │
  ════════════════▼════════════════════════════════════════▼══════════
  ║                   Alembic Knowledge Organism                     ║
  ║                                                                  ║
  ║  ┌─ Panorama (Skeleton) ──── ProjectContext ─────────────────┐  ║
  ║  │                                                            │  ║
  ║  │     Signal (Nerves)   ◄────►   Governance (Digest)         │  ║
  ║  │         ↕                          ↕                       │  ║
  ║  │              ┌────────────────────────┐                    │  ║
  ║  │              │      Recipe cells      │                    │  ║
  ║  │              │ grounded by sourceRefs │                    │  ║
  ║  │              └────────────────────────┘                    │  ║
  ║  │         ↕                          ↕                       │  ║
  ║  │     Guard (Immunity)  ◄────►   Agent Runtime (Hands)       │  ║
  ║  │                                                            │  ║
  ║  └────────────────────────────────────────────────────────────┘  ║
  ══════════════════════════════════════════════════════════════════
```

### Agent Actions × Organism Responses

| Agent Action | Organism Response | Organs Involved |
|-------------|------------------|-----------------|
| **Capture knowledge** — submit a pattern | Authoring gates validate structure and evidence → confidence routing → staging observation → evolves or decays. You retain full intervention rights | Digest |
| **Write code** — prime before coding | Trust-labeled Recipes injected with source evidence, so the agent builds on verified ground | Nerves → Recipe |
| **Search knowledge** — ask a question | Hybrid retrieval, fusion ranking, scenario-weighted signals | Nerves → Recipe |
| **Finish a task** — convention check | The immune system checks the diff against published Recipes; violations return together with the Recipes needed to fix them | Immunity → Recipe |
| **Decide evolution** — drift discovered | Batch per-Recipe decisions: propose evolution, confirm deprecation, or refresh verification | Digest → Immunity |
| **Mine autonomously** — in-process jobs | The embedded agent runs plan-selected dimensions under budget and safety policies, inside a sandbox | Hands |

### Five Organs

**Skeleton — Panorama (ProjectContext)**

The organism's structural awareness. Multi-language AST over 11 bundled tree-sitter grammars, a five-stage call-graph pipeline, Tarjan SCC coupling detection, dependency-depth layering, architecture-style inference — exposed as a space → repo → module → file query ladder with freshness annotations. All organs, and both hosts, share this one map.

**Digest — Governance (Lifecycle)**

The metabolic engine for new knowledge. Every submission passes authoring gates, then ConfidenceRouter routes numerically — high confidence auto-approves into fast-track staging with grace windows, low confidence is rejected outright. A six-state lifecycle — `pending → staging → active → evolving/decaying → deprecated` — is guarded by a single state machine; DecayDetector scores decay across freshness, usage, quality, and authority; RedundancyAnalyzer flags duplication; proposals distill into *update* or *deprecate*. Metabolism is **tick-on-access**: capped sweeps ride inside ordinary calls, no scheduler required.

**Nerves — Signal**

The sensing layer. A unified SignalBus carries twelve signal families — guard, search, usage, lifecycle, quality, exploration, panorama, decay and more — feeding lifecycle and ranking decisions. Retrieval ranks with seven signals (relevance, authority, recency, popularity, difficulty, context-match, vector), re-weighted per scenario: linting, generating, searching, learning.

**Immunity — Guard**

The convention immune system. Four detection layers — regex → code-level → tree-sitter AST → cross-file — with built-in rules for ten languages, reporting violations *and* honest uncertainties. A learner tracks precision and recall for tuning; an exclusion manager absorbs false positives. Freshness immunity runs the other direction: source-reference reconciliation verifies that Recipe-cited code still exists, feeding stale references straight into decay.

**Hands — Agent Runtime**

The motor system: one ReAct (Thought → Action → Observation) kernel with profile presets, orchestration strategies, and hard policies for budget, safety, and quality. Its tools cover code, terminal, knowledge, graph, and memory; terminal execution sits behind a read-only allowlist plus a macOS Seatbelt sandbox with audited degradation, and writes are gated by read-before-write freshness. Three-tier memory and staged context compression keep long runs honest.

### Design Philosophy

1. **AI at compile time, engineering at runtime** — the LLM thinks only at generation; what runs is a deterministic artifact
2. **Deterministic marking + probabilistic resolution** — every layer does what it can decide, and hands structured uncertainty up to AI
3. **Probabilistic core, deterministic shell** — the agent thinks freely inside guardrails cast in engineering; failure never throws, it degrades into a structured result
4. **Grounded or rejected** — every piece of knowledge anchors to real source; beyond evidence, everything is hearsay
5. **Four doors, four moments** — prime before writing, search along the way, map by place, guard at the finish; knowledge arrives on time, never floods the context
6. **Files are the truth** — Markdown is the single truth; the database is merely its shadow
7. **Access is metabolism** — no clock, no background job; every use is an act of metabolism
8. **Defense in depth** — five gates stand between submission and residency; trust is earned, and it can be revoked

---

## One Product, Five Repositories

Alembic is developed as five repositories with a one-way dependency spine — a deterministic kernel at the bottom, host experiences at the edge.

```
                       ┌─────────────────────────────┐
                       │       @alembic/core         │  deterministic kernel
                       │ lifecycle · guard · search  │
                       │ AST/graph · plan · coverage │
                       └─────────────▲───────────────┘
             ┌───────────────────────┼───────────────────────┐
  ┌──────────┴──────────┐  ┌─────────┴─────────┐  ┌──────────┴──────────┐
  │   @alembic/agent    │  │    alembic-ai     │  │    AlembicPlugin    │
  │  ReAct runtime      │◄─┤    (main body)    │  │  Codex + Claude     │
  │  provider stack     │  │ CLI · daemon      │  │  Code plugins       │
  │  tool system        │  │ HTTP · Dashboard  │  │  one MCP surface    │
  │  memory · policies  │  │ sandbox · DI      │  │  daemon-less        │
  └─────────────────────┘  └─────────▲─────────┘  └─────────────────────┘
                                     │ serves dashboard/dist
                           ┌─────────┴─────────┐
                           │ alembic-dashboard │  React SPA
                           │  review · realtime │
                           └───────────────────┘
```

| Repository | Package | Role |
|-----------|---------|------|
| **Alembic** (main body) | `alembic-ai` | The user-runnable host: CLI, per-project daemon with mining jobs and file monitoring, HTTP API with realtime delivery, Dashboard hosting, dependency injection, the macOS Seatbelt sandbox, workspace and Ghost management |
| **AlembicCore** | `@alembic/core` | The shared deterministic kernel: knowledge lifecycle, Guard engine, hybrid search and vectors, project intelligence, plan facts, coverage ledger, file-first persistence. No agent, no UI, no provider — enforced by boundary tests |
| **AlembicAgent** | `@alembic/agent` | The embedded intelligence: one ReAct execution engine, an AI provider stack for five vendors with reliability control, a contract-first tool system, layered memory |
| **AlembicDashboard** | `alembic-dashboard` | The review surface: a React SPA with nine views, command palette, bilingual UI, realtime progress — built and shipped inside `alembic-ai` |
| **AlembicPlugin** | `@gxfn/alembic-runtime` | The agent-native delivery: click-install plugin shells for Codex and Claude Code, one identical MCP tool surface on both hosts, built-in skills, Ghost-first, daemon-less |

The knowledge store is **file-first**: Markdown Recipes are the source of truth, SQLite is a rebuildable read cache (`alembic sync`), and divergence surfaces as a typed error with a documented reconcile path.

---

## Engineering Capabilities

### Guard CLI

```bash
alembic guard src/file.ts        # Check a file against published Recipes
alembic guard:staged             # pre-commit: staged files only
alembic guard:ci --min-score 90  # CI quality gate
```

### Multi-Language Project Intelligence

Eleven bundled tree-sitter grammars: TypeScript · TSX · JavaScript · Swift · Objective-C · Kotlin · Java · Dart · Python · Go · Rust. Five-stage incremental call-graph analysis, coupling detection, dependency layering, architecture-style inference — queryable by agents directly, without consuming a single Recipe.

### Plan-Driven Mining & Coverage

Twenty-five mining dimensions — thirteen universal (architecture, coding standards, design patterns, error resilience, concurrency, data flow, networking, UI, testing, security, performance, observability, agent guidelines), plus language- and framework-specific ones. Planning collects bounded project facts and lets the agent confirm a selection — stateless, never persisted. A per-module × per-dimension **coverage ledger** records what's been mined; a convergence advisor recommends when another round is worth it — advisory, never a gate.

### Hybrid Search

Vector index plus field-weighted keywords, fused and ranked by scenario-weighted signals. The semantic layer is optional: without an embedding model, search degrades gracefully to keyword baseline.

### Grounded Knowledge

Recipes carry `sourceRefs` — anchored evidence agents trust without re-verification. A single-source authoring spec drives both validation and the guidance agents see: evidence gates requiring multiple distinct files, verbatim snippet probes, an actionability whitelist, and a deterministic depth-and-grounding judge before anything reaches production.

### Project Skills

Completing a dimension synthesizes **project Skills** — instruction files agents load on demand. Plugins project them into the agent's skill directory; the Dashboard manages them, including AI-generating one from a prompt.

### Sandboxed Execution

Agent terminal tools run behind a read-only command allowlist and, on macOS, a Seatbelt profile with a network proxy and violation parsing. Degradation is never silent — unsandboxed runs are annotated and audited.

### AI Providers

In-process mining supports **Google Gemini / OpenAI / Claude / DeepSeek / Ollama** with automatic fallback, hot-reload on config change, and parameter guarding. The plugin path needs none of this — your coding agent's own model does the work.

```bash
alembic start                    # configure in the Dashboard, or:
printf %s "$OPENAI_API_KEY" | alembic ai configure --provider openai --model gpt-5.5 --key-stdin
alembic ai status                # inspect the effective configuration
```

Explicit environment variables still work for one-off runs and override workspace settings without being persisted. When handing an API key to an agent, provide the raw key only — no labels, no wrappers.

---

## Dashboard

`alembic start` serves the review surface — nine views over the live runtime:

| View | What you do there |
|------|-------------------|
| **Recipes** | Browse by authority, edit, review evolution proposals per Recipe |
| **Candidates** | Audit and promote submissions; launch cold start or rescan; watch dimension progress and the three-round AI review live |
| **Knowledge** | Batch-manage entries across the six lifecycle states |
| **Module Explorer** | Discovered targets and custom folders; AI-scan a target, a folder, or the whole project |
| **Project Pyramid** | The module dependency graph, level by level |
| **Guard** | Rules, violations, and a write-action audit trail |
| **Skills** | View, edit, create — or AI-generate a skill from a prompt |
| **Jobs** | The daemon queue with live process events and full LLM I/O snapshots |
| **Help** | Quick start, tool reference, token usage |

Plus a ⌘K command palette, bilingual interface, dark/light themes, and an optional login gate.

## Project Layout

After `alembic setup` (standard mode), your project gains:

```
your-project/
├── Alembic/                # Knowledge data (git-tracked; `alembic remote <url>` can split it into a shared repo)
│   ├── constitution.yaml   # Entry safety policy
│   ├── recipes/            # Reviewed patterns (Markdown — the source of truth)
│   ├── candidates/         # Pending review
│   └── skills/             # Project skills
└── .asd/                   # Runtime cache (gitignored)
    ├── alembic.db          # SQLite — read cache; `alembic sync` rebuilds it
    └── context/            # Vector index
```

With `--ghost` (or the plugin, where Ghost is the default), **all of the above** lives in `~/.asd/workspaces/<projectId>/` instead — zero Alembic files inside your repository.

## Requirements

- Node.js ≥ 22
- macOS recommended (the Seatbelt sandbox for agent terminal tools is macOS-only; everything else is cross-platform)
- better-sqlite3 (bundled)

### Recommended: Local Embedding for Semantic Search

Hybrid search works out of the box on weighted keywords. A local embedding model unlocks the semantic layer — concept-level matching that finds relevant Recipes even when exact keywords don't:

```bash
brew install ollama && ollama serve
ollama pull qwen3-embedding:0.6b

alembic ai configure --embed-provider ollama --embed-model qwen3-embedding:0.6b
alembic embed
```

Local inference, no API calls, no data leaves your machine.

## Deep Dive

> **[Visual Tour — understand the entire system in 5 minutes](https://docs.gaoxuefeng.com/visual-tour)** · hand-drawn architecture diagrams from workflow to agent loop

Each repository ships its own architecture README: `AlembicCore` (kernel layers, API boundary, quality gates), `AlembicAgent` (ReAct runtime, provider stack, tool safety), the `AlembicPlugin` shells ([Codex](https://github.com/GxFn/AlembicCodex), [Claude Code](https://github.com/GxFn/AlembicClaudeCode)), and `AlembicDashboard`.

## Contributing

1. Run `npm test` before submitting
2. Follow existing code patterns (ESM, domain-driven structure); `npm run check` runs the full gate chain

## License

[MIT](LICENSE) © gaoxuefeng
