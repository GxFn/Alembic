# Agent Architecture

The Alembic Agent layer (`lib/agent/`, path alias `#agent/*`) is an independent intelligence layer responsible for all AI Agent runtime capabilities. It was extracted from the Service layer to become a top-level architecture module parallel to Service.

---

## Architecture Position

```
Entry Points → Bootstrap → DI Container → [HTTP | MCP | CLI | Dashboard]
                                                    ↓
                                            ┌── Agent Layer ──┐
                                            │  ReAct Runtime   │
                                            │  Memory System   │
                                            │  54 Built-in Tools│
                                            └───────┬──────────┘
                                                    ↓
                                            Service Layer (15 domains)
                                                    ↓
                                         Core + Domain Layer
                                                    ↓
                                         Infrastructure Layer
                                                    ↓
                                           External Layer
```

The Agent layer sits between the DI Container and Service layer, serving as the intelligent hub connecting external requests to internal business logic.

---

## Why Independent

| Dimension | Rationale |
|-----------|-----------|
| **Scale** | 40+ files, 5 sub-modules — was the largest sub-domain in Service |
| **Autonomy** | Has its own core/, domain/, memory/, context/, tools/ internal layering |
| **Cross-layer** | Consumed by HTTP routes, MCP Handlers, CLI, DI modules |
| **Evolution** | Agent intelligence (memory, reasoning, tools) evolves independently from business services |
| **Path alias** | Uses `#agent/*` independent alias, decoupled from `#service/*` |

---

## Directory Structure

```
lib/agent/
├── index.ts                    # Unified export module
│
├── AgentFactory.ts             # Factory — creates Runtime per Preset
├── AgentRuntime.ts             # ReAct reasoning loop core engine
├── AgentRuntimeTypes.ts        # Shared types: AgentResult, RuntimeConfig
├── AgentRouter.ts              # Intent → Preset routing
├── AgentMessage.ts             # Unified message format
├── AgentEventBus.ts            # Agent event bus
├── AgentState.ts               # Agent state management (phase FSM)
├── IntentClassifier.ts         # Intent classification (keyword + LLM)
├── LarkTransport.ts            # Lark ↔ Agent bridge
├── PipelineStrategy.ts         # Pipeline strategy
├── ConversationStore.ts        # Conversation storage (disk-persisted)
├── capabilities.ts             # Capability declarations
├── policies.ts                 # Budget / Safety / QualityGate
├── presets.ts                  # Named configs (insight/chat/lark/scan)
├── strategies.ts               # Run strategies (Single/FanOut/Adaptive)
├── forced-summary.ts           # Forced summary mechanism
│
├── core/                       # ── Core Runtime ──
│   ├── ChatAgentPrompts.ts     # Prompt template library
│   ├── SystemPromptBuilder.ts  # Dynamic system prompt builder
│   ├── ToolExecutionPipeline.ts # Tool execution + safety
│   ├── MessageAdapter.ts       # Message format adapter
│   ├── LoopContext.ts          # ReAct loop context
│   └── LLMResultType.ts       # LLM result type enum
│
├── memory/                     # ── Multi-layer Memory ──
│   ├── MemoryCoordinator.ts    # Orchestrates all memory layers
│   ├── MemoryRetriever.ts      # Retrieval (vector + keyword)
│   ├── MemoryStore.ts          # Persistent storage
│   ├── MemoryConsolidator.ts   # Short-term → long-term
│   ├── ActiveContext.ts        # Active context window
│   ├── PersistentMemory.ts     # Cross-session memory
│   ├── SessionStore.ts         # Session-scoped memory
│   └── index.ts                # Memory module export
│
├── context/                    # ── Context Management ──
│   ├── ContextWindow.ts        # Token window + auto-truncation
│   ├── ExplorationTracker.ts   # Exploration progress tracking
│   └── exploration/            # Exploration subsystem
│       ├── ExplorationStrategies.ts
│       ├── NudgeGenerator.ts
│       ├── PlanTracker.ts
│       └── SignalDetector.ts
│
├── domain/                     # ── Agent Domain Logic ──
│   ├── ChatAgentTasks.ts       # Predefined tasks
│   ├── EpisodicConsolidator.ts # Episode consolidation
│   ├── EvidenceCollector.ts    # Evidence collector
│   ├── insight-analyst.ts      # Insight analysis
│   ├── insight-gate.ts         # Insight quality gate
│   ├── insight-producer.ts     # Insight production
│   └── scan-prompts.ts         # Scan task prompts
│
└── tools/                      # ── 54 Built-in Tools ──
    ├── ToolRegistry.ts         # Tool registration center
    ├── _shared.ts              # Shared types and utilities
    ├── index.ts                # Unified tool registration
    ├── ai-analysis.ts          # AI-driven analysis
    ├── ast-graph.ts            # AST/code graph
    ├── composite.ts            # Multi-step composite ops
    ├── guard.ts                # Rule checks
    ├── infrastructure.ts       # File ops, config, skills
    ├── knowledge-graph.ts      # Knowledge queries
    ├── lifecycle.ts            # Entry lifecycle
    ├── project-access.ts       # File read, directory walk
    ├── query.ts                # Search, retrieval
    ├── scan-recipe.ts          # Scan & recipe tools
    └── system-interaction.ts   # Command exec, clipboard
```

---

## Core Concepts

### ONE Runtime Architecture

The Agent system uses a **"one runtime, many configs"** architecture:

```
                    ┌─── insight (deep analysis)
                    ├─── chat    (conversational)
AgentFactory ───→ Preset ──→ AgentRuntime
                    ├─── lark    (Lark integration)
                    └─── scan    (batch scanning)
```

### ReAct Reasoning Loop

```
User Input → SystemPrompt → LLM Reasoning → Tool Call → Result Inject → LLM → ...
                ↑                              ↓
         ContextWindow                ToolExecutionPipeline
         (Token mgmt)               (Safety + Exec + Results)
```

### Multi-layer Memory

```
┌─────────────────────────────────────┐
│          MemoryCoordinator          │  ← Unified dispatch
├──────────┬──────────┬───────────────┤
│ Session  │ Active   │  Persistent   │
│ Store    │ Context  │  Memory       │
│(session) │(working) │ (cross-sess)  │
├──────────┴──────────┴───────────────┤
│       MemoryConsolidator            │  ← Short→Long-term
│       EpisodicConsolidator          │  ← Episodes→Structured
└─────────────────────────────────────┘
```

---

## Dependencies

### Agent → External Modules

```
Agent Layer
   ├──→ #infra/logging/Logger.js
   ├──→ #external/ai/AiProvider.js
   ├──→ #shared/similarity.js, token-utils.js, FieldSpec.js, ...
   ├──→ #service/candidate/*, knowledge/*, skills/*
   └──→ #external/mcp/handlers/*
```

### External → Agent Layer

| Consumer | What it imports |
|----------|----------------|
| `lib/injection/modules/AgentModule.ts` | `AgentFactory`, `ToolRegistry` |
| `lib/http/routes/ai.ts` | `AgentMessage`, `ConversationStore`, `PRESETS` |
| `lib/http/routes/remote.ts` | `LarkTransport` |
| `lib/external/mcp/handlers/bootstrap/pipeline/` | Memory, ExplorationTracker, PRESETS |
| `lib/service/skills/SignalCollector.ts` | `AgentMessage` (dynamic) |

---

## Path Alias

```json
"#agent/*": {
  "alembic-dev": "./lib/agent/*",
  "default": "./dist/lib/agent/*"
}
```

Usage:
```typescript
import { AgentFactory } from '#agent/AgentFactory.js';
import { MemoryCoordinator } from '#agent/memory/MemoryCoordinator.js';
import { ToolRegistry } from '#agent/tools/ToolRegistry.js';
```
