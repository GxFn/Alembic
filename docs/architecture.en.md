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
│ 17 routes│ │ 20 tools│ │14 cmds│ │ 17 views     │
└──────┬──┘ └────┬────┘ └───┬───┘ └──────────────┘
       │         │          │
┌──────▼─────────▼──────────▼─────────────────────────────┐
│                   Agent Layer                            │
│  AgentRuntime (ReAct) · Memory · Context · Tools (54)   │
│  IntentClassifier · Router · Presets · Strategies        │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                   Service Layer                          │
│  Knowledge · Guard · Search · Bootstrap                  │
│  Cursor · Quality · Recipe · Skills · Wiki · Automation │
│  Snippet · Module · Task · Vector · Candidate            │
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
│  MCP: 16 agent + 4 admin tools                           │
│  Lark: LarkTransport for Lark/Feishu messaging           │
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

### 4. Agent Layer

The independent Agent architecture layer (`lib/agent/`, path alias `#agent/*`) contains 40+ files across 5 sub-modules:

| Sub-module | Core Class | Responsibility |
|------------|-----------|----------------|
| **root** | `AgentRuntime` | ReAct reasoning loop engine, ONE Runtime multi-config architecture |
| **root** | `AgentFactory` | Agent factory, creates different Runtime configs per Preset |
| **root** | `AgentRouter` | Intent → Preset routing dispatch |
| **root** | `IntentClassifier` | Intent classification (keyword + LLM hybrid) |
| **core/** | `ToolExecutionPipeline` | ReAct loop core: Prompt building + tool execution pipeline |
| **memory/** | `MemoryCoordinator` | Multi-layer memory: Session / Active / Persistent / Episodic |
| **context/** | `ContextWindow` / `ExplorationTracker` | Token window management + exploration strategies |
| **domain/** | `EpisodicConsolidator` / `InsightProducer` | Agent domain logic: insight analysis, evidence collection, scan tasks |
| **tools/** | `ToolRegistry` + 14 files | 54 built-in tools (knowledge, AST, Guard, search, system, etc.) |
| **forge/** | `ToolForge` / `SandboxRunner` / `DynamicComposer` | Dynamic tool forging: reuse/compose/generate three modes, sandbox validation + TTL temporary registration |

### 5. Service Layer

Business service layer containing 15 sub-domain services:

| Sub-domain | Core Class | Responsibility |
|------------|-----------|----------------|
| **knowledge** | `KnowledgeService` | Knowledge entry CRUD, graph, entity graph, confidence routing |
| **guard** | `GuardService` / `GuardCheckEngine` | 50+ built-in rule engine (regex + AST semantic), 3-state output (pass / violation / uncertain), 3-dimensional report (compliance + coverage + confidence) |
| **search** | `SearchEngine` / `MultiSignalRanker` | FieldWeighted + vector hybrid retrieval, 7-signal weighted ranking |
| **task** | `IntentExtractor` / `PrimeSearchPipeline` | Intent-aware multi-query search: Q1 synonym enrichment + Q2 tech terms + Q3 file context + Q4 focused query, 3-layer quality filter (absolute threshold + relative-to-best + score gap detection) |
| **bootstrap** | `BootstrapTaskManager` | Coldstart async task orchestration, 14 analysis dimensions |
| **delivery** | `CursorDeliveryPipeline` | 4-channel delivery (Rules + Skills + Token Budget + Topic Classification) |
| **automation** | `AutomationOrchestrator` | File watching, directive detection (`as:s` / `as:c` / `as:a`), processing pipeline |
| **quality** | `QualityScorer` | Knowledge entry quality scoring + feedback collection |
| **recipe** | `RecipeParser` | Recipe Markdown parsing and candidate validation |
| **skills** | `SkillAdvisor` / `SkillHooks` | Skill recommendations, lifecycle hooks, background signal analysis |
| **snippet** | `SnippetFactory` | IDE-agnostic code snippet factory (Xcode / VS Code Codec) |
| **wiki** | `WikiGenerator` | Auto-generated project Wiki |
| **module** | `ModuleService` | Multi-language module structure scanning |
| **candidate** | `SimilarityService` | Candidate deduplication, similarity detection |
| **evolution** | `KnowledgeMetabolism` / `DecayDetector` / `ContradictionDetector` / `RedundancyAnalyzer` | Knowledge governance: contradiction detection, redundancy analysis, decay scoring, evolution proposals |
| **signal** | `HitRecorder` | Batch usage signal collection + 30s buffer flush |


### 6. Core + Domain Layer

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
- `Lifecycle` — Knowledge entry six-state lifecycle: `pending → staging → active → evolving/decaying → deprecated`. staging (auto-publish grace period), evolving (evolution proposal attached), decaying (decay observation period) are system-driven intermediate states
- `Snippet` — Code snippet entity

### 7. Infrastructure Layer

| Module | Responsibility |
|--------|---------------|
| `DatabaseConnection` | SQLite connection management + auto-migration |
| `VectorStore` / `JsonVectorAdapter` | Vector storage (local JSON or Milvus) |
| `IndexingPipeline` / `Chunker` | Vector indexing pipeline + text chunking |
| `CacheService` / `GraphCache` | In-memory cache + AST graph cache |
| `SignalBus` | Unified signal bus (typed pub-sub), 9 signal types, exact/wildcard subscription |
| `EventBus` | In-process event bus |
| `RealtimeService` | Socket.IO real-time push (coldstart progress, etc.) |
| `AuditStore` / `AuditLogger` | Operation audit log persistence |
| `Logger` | Winston structured logging |
| `ErrorTracker` / `PerformanceMonitor` | Error tracking + performance monitoring |
| `PathGuard` | Path security guard, prevents file write escapes |

### 8. External Layer

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

20 tools split into 16 Agent Tier (IDE AI accessible) + 4 Admin Tier (admin/CI), communicating with IDEs via stdio protocol.

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
             → IntentExtractor (intent extraction: synonym expansion + tech terms + scenario classification)
             → PrimeSearchPipeline (multi-query parallel search + RRF fusion + 3-layer quality filter)
             → KnowledgeCompressor (token budget)
             → Return Recipes + Guard Rules + sourceRefs
```

### Guard Check Flow

```
Source File → SourceFileCollector → GuardCheckEngine
           → Regex Rules (50+) + AST Semantic Rules + Cross-file Rules
           → 3-state output: pass / violation / uncertain
           → ComplianceReporter → 3-dimensional report (compliance + coverage + confidence)
           → ReverseGuard → Recipe↔Code reverse validation (API symbol liveness check)
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

1. **ESM Only** — The entire project uses ES Modules, Node.js ≥ 22
2. **SQLite as Cache** — Markdown files are the Source of Truth; SQLite is a read cache; `asd sync` can rebuild it
3. **No Build Step** — Pure JavaScript, no TypeScript compilation needed (except Dashboard)
4. **DI without Framework** — Lightweight self-implemented DI container, no external DI framework dependency
5. **WASM AST** — `web-tree-sitter` replaces native `tree-sitter`, eliminating C++ compilation dependency
6. **Convention over Configuration** — Project structure conventions (`AutoSnippet/recipes/`, `AutoSnippet/candidates/`), minimal configuration
