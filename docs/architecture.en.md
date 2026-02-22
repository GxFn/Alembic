# Architecture

AutoSnippet uses a Layered Domain-Driven Design (DDD) architecture. Its core purpose is to extract code patterns into structured knowledge and deliver them to AI coding assistants through multiple channels.

---

## Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Entry Points                         │
│  bin/cli.js (asd)   bin/mcp-server.js   bin/api-server  │
└──────────┬─────────────────┬──────────────┬─────────────┘
           │                 │              │
┌──────────▼─────────────────▼──────────────▼─────────────┐
│              lib/bootstrap.js                            │
│  .env → Config → Logger → DB → Constitution → Gateway   │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│          lib/injection/ServiceContainer.js               │
│  DI Container (Lazy Singleton) — 40+ service bindings   │
└──────┬──────────┬──────────┬──────────┬─────────────────┘
       │          │          │          │
┌──────▼──┐ ┌────▼────┐ ┌───▼───┐ ┌───▼──────────┐
│ HTTP    │ │  MCP    │ │  CLI  │ │  Dashboard   │
│ Express │ │ stdio   │ │ cmdr  │ │ React+Vite   │
│ 17 routes│ │ 16 tools│ │14 cmds│ │ 17 views     │
└──────┬──┘ └────┬────┘ └───┬───┘ └──────────────┘
       │         │          │
┌──────▼─────────▼──────────▼─────────────────────────────┐
│                   Service Layer                          │
│  ChatAgent · Knowledge · Guard · Search · Bootstrap     │
│  Cursor · Quality · Recipe · Skills · Wiki · Automation │
│  Snippet · Module                                        │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                Core + Domain Layer                        │
│  Gateway (validate→guard→route→audit)                    │
│  Constitution (RBAC) · AST (11 langs) · Discovery (11)  │
│  Enhancement (17 frameworks) · KnowledgeEntry (entity)   │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│               Infrastructure Layer                       │
│  SQLite · VectorStore · Cache · EventBus · Logger       │
│  AuditStore · Realtime(Socket.IO) · PerformanceMonitor  │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                 External Layer                            │
│  AI: OpenAI / Gemini / Claude / DeepSeek / Ollama       │
│  MCP: 12 agent + 4 admin tools                           │
│  Native: Xcode / Clipboard / Browser                     │
└─────────────────────────────────────────────────────────┘
```

---

## Layer Details

### 1. Entry Points

| Entry | File | Purpose |
|-------|------|---------|
| CLI | `bin/cli.js` | `asd` command-line tool, built on commander, 14 subcommands |
| MCP Server | `bin/mcp-server.js` | MCP stdio server for Cursor / VS Code / Claude Code |
| API Server | `bin/api-server.js` | HTTP REST API server for Dashboard and external integrations |

All entry points share the same initialization flow: `Bootstrap.initialize()` → `ServiceContainer.initialize()`.

### 2. Bootstrap

`lib/bootstrap.js` handles the application startup sequence:

1. **loadDotEnv** — Walks up the directory tree to find `.env`
2. **loadConfig** — `ConfigLoader` loads `config/default.json` + env overrides
3. **initializeLogger** — Winston logger instantiation
4. **initializeDatabase** — SQLite connection + auto-migration
5. **loadConstitution** — Load permission constitution `constitution.yaml`
6. **initializeCoreComponents** — ConstitutionValidator, PermissionManager, AuditStore, SkillHooks
7. **initializeGateway** — Gateway pipeline injection (validate → guard → route → audit)

### 3. DI Container

`lib/injection/ServiceContainer.js` is the global singleton DI container using a **lazy factory registration** pattern:

- 40+ services registered via factory functions, instantiated and cached on first `get()`
- Supports AI Provider hot-reload (`reloadAiProvider()`), automatically clears cached singletons in the dependency chain
- Registration in three phases: `_registerInfrastructure()` → `_registerRepositories()` → `_registerServices()`

### 4. Service Layer

The thickest layer of the project, containing 15 sub-domain services:

| Sub-domain | Core Class | Responsibility |
|------------|-----------|----------------|
| **chat** | `ChatAgent` (2291 lines) | ReAct reasoning loop + DAG task pipeline, 54 built-in tools |
| **knowledge** | `KnowledgeService` | Knowledge entry CRUD, graph, entity graph, confidence routing |
| **guard** | `GuardService` / `GuardCheckEngine` | 50+ built-in rule engine (regex + AST semantic) |
| **search** | `SearchEngine` / `RetrievalFunnel` | 4-stage retrieval funnel (keyword → semantic → fusion → rerank) |
| **bootstrap** | `BootstrapTaskManager` | Coldstart async task orchestration, 14 analysis dimensions |
| **cursor** | `CursorDeliveryPipeline` | 4-channel delivery (Rules + Skills + Token Budget + Topic Classification) |
| **automation** | `AutomationOrchestrator` | File watching, directive detection (`as:s` / `as:c` / `as:a`), processing pipeline |
| **quality** | `QualityScorer` | Knowledge entry quality scoring + feedback collection |
| **recipe** | `RecipeParser` | Recipe Markdown parsing and candidate validation |
| **skills** | `SkillAdvisor` / `SkillHooks` | Skill recommendations, lifecycle hooks, background signal analysis |
| **snippet** | `SnippetFactory` | IDE-agnostic code snippet factory (Xcode / VS Code Codec) |
| **wiki** | `WikiGenerator` | Auto-generated project Wiki |
| **module** | `ModuleService` | Multi-language module structure scanning |
| **candidate** | `SimilarityService` | Candidate deduplication, similarity detection |
| **context** | `RecipeExtractor` | Recipe content extraction and context collection |

### 5. Core + Domain Layer

#### Gateway

Unified request processing pipeline in 4 steps:
1. **Validate** — Parameter validation
2. **Guard** — Permission + constitution rule checks
3. **Route** — `GatewayActionRegistry` routes to specific Service methods
4. **Audit** — `AuditLogger` records operation logs

#### AST Analysis (11 Languages)

Multi-language AST parser based on `web-tree-sitter` (WASM):
JavaScript, TypeScript, Python, Swift, Dart, Go, Java, Kotlin, Objective-C, Rust + Generic

Each language has its own extractor (`lang-*.js`), producing structured classes, methods, imports, and dependency relationships.

#### Project Discovery (11 Discoverers)

`DiscovererRegistry` auto-detects project types by characteristics:
Node, Python, Dart, Go, JVM (Java/Kotlin), Rust, SPM (Swift), Generic, etc.

#### Framework Enhancement (17 Enhancement Packs)

Injects additional analysis logic for detected frameworks:
React, Vue, Next.js, Node Server, Django, FastAPI, Spring, Android, Go Web, Go gRPC, Rust Web, Rust Tokio, LangChain, ML, etc.

#### Domain Entities

- `KnowledgeEntry` — V3 unified knowledge entry with value objects: Content, Constraints, Quality, Reasoning, Relations, Stats
- `Lifecycle` — Knowledge entry state machine: `draft → pending → approved → active → deprecated`
- `Snippet` — Code snippet entity

### 6. Infrastructure Layer

| Module | Responsibility |
|--------|---------------|
| `DatabaseConnection` | SQLite connection management + auto-migration |
| `VectorStore` / `JsonVectorAdapter` | Vector storage (local JSON or Milvus) |
| `IndexingPipeline` / `Chunker` | Vector indexing pipeline + text chunking |
| `CacheService` / `GraphCache` | In-memory cache + AST graph cache |
| `EventBus` | In-process event bus |
| `RealtimeService` | Socket.IO real-time push (coldstart progress, etc.) |
| `AuditStore` / `AuditLogger` | Operation audit log persistence |
| `Logger` | Winston structured logging |
| `ErrorTracker` / `PerformanceMonitor` | Error tracking + performance monitoring |
| `PathGuard` | Path security guard, prevents file write escapes |

### 7. External Layer

#### AI Provider

`AiFactory` auto-detects available Providers with hot-switching support:

| Provider | Environment Variable |
|----------|---------------------|
| Google Gemini | `ASD_GOOGLE_API_KEY` |
| OpenAI | `ASD_OPENAI_API_KEY` |
| Claude | `ASD_CLAUDE_API_KEY` |
| DeepSeek | `ASD_DEEPSEEK_API_KEY` |
| Ollama (local) | `ASD_AI_PROVIDER=ollama` |

When multiple API Keys are present, automatic fallback is applied.

#### MCP Server

16 tools split into 12 Agent Tier (IDE AI accessible) + 4 Admin Tier (admin/CI), communicating with IDEs via stdio protocol.

---

## Data Flow

### Knowledge Extraction Flow

```
Source Code → AST Parsing → Discovery (project type) → Enhancement (framework)
           → Bootstrap (14 dimension analysis) → AI Extraction → Candidates (drafts)
           → Dashboard Review → Recipes (approved) → Search Index + Guard Rules
```

### IDE Delivery Flow

```
IDE AI Request → MCP Server → Gateway (permission check)
             → SearchEngine (4-stage retrieval funnel)
             → KnowledgeCompressor (token budget)
             → Return Recipes + Guard Rules
```

### Guard Check Flow

```
Source File → SourceFileCollector → GuardCheckEngine
           → Regex Rules (50+) + AST Semantic Rules + Cross-file Rules
           → ComplianceReporter → Report (JSON/Text/Markdown)
```

---

## Constitution System (RBAC)

Three-tier permission architecture:

| Tier | Description |
|------|-------------|
| **Capability** | Runtime capability probing (e.g., `git_write`) |
| **Role** | 3 roles: `external_agent` (IDE AI), `chat_agent` (built-in AI), `developer` |
| **Governance** | 4 hard rules: delete requires confirmation, create requires content, AI cannot publish directly, batch requires authorization |

---

## Key Design Decisions

1. **ESM Only** — The entire project uses ES Modules, Node.js ≥ 20
2. **SQLite as Cache** — Markdown files are the Source of Truth; SQLite is a read cache; `asd sync` can rebuild it
3. **No Build Step** — Pure JavaScript, no TypeScript compilation needed (except Dashboard)
4. **DI without Framework** — Lightweight self-implemented DI container, no external DI framework dependency
5. **WASM AST** — `web-tree-sitter` replaces native `tree-sitter`, eliminating C++ compilation dependency
6. **Convention over Configuration** — Project structure conventions (`AutoSnippet/recipes/`, `AutoSnippet/candidates/`), minimal configuration
