# Technical Reference

> Detailed implementation of Alembic's five organs, engineering metrics, and defense chain. For overview, see [README](../README.md).
>
> [中文](technical-reference.md)

---

## Five Organs

### Skeleton — Panorama (2,965 lines, 9 files)

The organism's structural perception. Infers module roles via AST + call graphs — four-signal fusion (AST structure 30% + call behavior 30% + data flow 15% + entity topology 10% + regex baseline 15%), recognizes 13 role types across 7 language families (apple / jvm / dart / python / web / go / rust). Tarjan SCC computes module coupling (cycle detection, fan-in/fan-out metrics), Kahn longest-path topological sort infers layering (L0-Ln auto-layering + role-voting names). DimensionAnalyzer generates 11-dimension knowledge health radar (architecture / coding-standards / error-handling / concurrency / data-management / networking / ui-patterns / testing / security / performance / observability), outputting coverage heatmaps and prioritized gap reports.

### Metabolism — Governance (3,658 lines, 10 files)

The core engine of knowledge metabolism. ContradictionDetector finds conflicts (4-dimension evidence), RedundancyAnalyzer flags duplication (4-dimension weights), DecayDetector scores decay (6 strategies: no_recent_usage / high_false_positive / symbol_drift / source_ref_stale / superseded / contradiction + 4-dimension scoring: freshness 30% + usage 30% + quality 20% + authority 20%, 5-level health grades 0~100). ProposalExecutor auto-executes evolution proposals on expiry (7 proposal types: merge / supersede / enhance / deprecate / reorganize / contradiction / correction, 5 states + type-specific observation windows 24h~7d). ConfidenceRouter 6-stage numerical routing — confidence ≥ 0.85 auto-publishes (≥ 0.90 → 24h Grace, 0.85~0.89 → 72h Grace), < 0.2 rejects outright, trusted-source threshold relaxed to 0.70. ConsolidationAdvisor pre-submit merge advisor, StagingManager tiered Grace Period management, EnhancementSuggester 4 enhancement strategies.

### Nerves — Signal + Intent (682-line SignalBus + IntentClassifier)

The organism's perception and intent hub. 12 signal types unified on SignalBus (guard / search / usage / lifecycle / quality / exploration / panorama / decay / forge / intent / anomaly / guard_blind_spot). HitRecorder batches usage events in a 30s buffer, SignalTraceWriter persists to trace logs, SignalAggregator provides async aggregation. IntentClassifier analyzes Agent intent and routes to optimal Preset; IntentExtractor extracts terms, infers language and module. Organs subscribe to signals of interest — not "scan every 24 hours" but "trigger when signals saturate." When the Agent shifts intent, the nervous system records drift signals and coordinates the immune system to reverse-check Recipe validity.

### Immune — Guard (5,726 lines, 14 files)

Bidirectional immune system. Guard audits code compliance forward (four layers: regex line-by-line → code-level multi-line → tree-sitter AST → cross-file analysis); ReverseGuard verifies backward that Recipe-referenced API symbols still exist (5 drift types → three-level recommendations healthy / investigate / decay). Three-state output (pass / violation / uncertain) — UncertaintyCollector captures capability boundaries and reports honestly. Three-dimensional reports: compliance + coverage + confidence, Quality Gate three-state verdict (PASS / WARN / FAIL). RuleLearner tracks TP/FP/FN → P/R/F1 per rule; FP > 40% auto-triggers decay review. ExclusionManager 3-tier exclusions (path / rule+file / global disable), GuardFeedbackLoop detects fixed violations and auto-confirms Recipe usage, CoverageAnalyzer module-level rule coverage matrix.

### Creation — Tool Forge (1,280 lines, 5 files)

Creativity at the capability boundary. Three progressive modes — Reuse (0ms) → Compose (10ms, DynamicComposer via sequential/parallel strategies) → Generate (~5s, LLM writes code → SandboxRunner vm-isolated validation: 5s timeout + 18 security rules banning require/eval → TemporaryToolRegistry 30min TTL, 60s auto-reclaim cycle). ToolRequirementAnalyzer auto-recommends optimal forging strategy.

> **Auxiliary Engine**: Built-in Agent Runtime (1,099 lines) provides background ReAct governance when the IDE Agent is not involved — Perceive → Working Memory → Reason (LLM) → Act (Tools) → Reflect (Policy). 3-level context compression, phase machine (EXPLORE→PRODUCE→SUMMARIZE), contradiction detection and dedup. 6-layer Memory system (Store / Retriever / Coordinator / Consolidator / PersistentMemory / ActiveContext). 16 MCP tools exposed to IDE Agent, 50+ internal tools for background operations.

---

## Defense in Depth

Six-layer defense chain, each independently effective:

| Layer | Component | Responsibility |
|-------|-----------|---------------|
| 1 | **Constitution** | Constitutional rules: 5-role permission matrix (developer / external_agent / chat_agent / contributor / visitor) + capability probing (git_write) |
| 2 | **Gateway** | Unified request pipeline: validate → guard → route → audit, EventEmitter async observation |
| 3 | **Permission** | 3-tuple enforcement: actor + action + resource → allowed/denied, wildcard admin |
| 4 | **SafetyPolicy** | Agent constraints: Budget / QualityGate / behavior policies |
| 5 | **PathGuard** | Dual-layer path safety: Layer 1 blocks writes outside project; Layer 2 constrains to whitelisted directories (.asd / .cursor / .vscode / .github) |
| 6 | **ConfidenceRouter** | Numerical routing: confidence + source reputation + content length + reasoning validity → 6-stage auto-review |

---

## Engineering Metrics

| Metric | Value |
|--------|-------|
| Source files | 475 TypeScript files (lib 396 + Dashboard 76 + CLI 3) |
| Total source lines | 161,220 lines (lib 132,374 + Dashboard 27,068 + CLI 1,778) |
| Unit tests | 1,422 tests / 63 files |
| Integration tests | 1,125 tests / 44 files |
| DI service modules | 9 Modules, 67 singleton services |
| SQLite tables | 13 |
| MCP tools | 16 (14 Agent + 2 Admin) |
| HTTP API | 22 route files, 142 endpoints |
| Dashboard views | 19 pages + 4 modals |
| CLI commands | 20 |
| AST language plugins | 11 languages (11 WASM grammars) |
| Project Discoverers | 9 types (SPM / Node / JVM / Go / Python / Rust / Dart / C# / Generic) |
| Signal types | 12 |
| Knowledge relation types | 14 |
| Agent internal tools | 50+ (14 files) |

---

## Intent-Aware Search

IntentExtractor extracts technical terms, infers language and module, performs cross-language synonym expansion (inject↔注入, architecture↔架构, protocol↔协议…), and identifies 4 scenarios (lint / generate / search / learning). PrimeSearchPipeline executes parallel multi-query searches (raw query + term query + file context + focused synonyms), filtered through three quality layers (absolute threshold + relative-to-best ratio + score cliff cutoff).

The search engine supports 4 modes: keyword direct match, recall field-weighted scoring (FieldWeightedScorer: trigger 5.0 > title 3.0 > tags 2.0 > description 1.5 > content 1.0), semantic vector similarity, auto hybrid (RRF fusing dense and sparse results). MultiSignalRanker dynamically adjusts 7 signal weights per scenario (relevance / authority / recency / popularity / difficulty / contextMatch / vector).

### Semantic Search

With an LLM API Key configured, search upgrades to vector + field-weighted hybrid retrieval — HNSW-indexed vector nearest-neighbor search, AST-aware chunking, scalar quantization compression. RRF (k=60) fuses dense and sparse retrieval results. CrossEncoder is an optional module (requires separate AI Provider configuration); degrades to Jaccard similarity when unconfigured.

---

## Bootstrap Cold Start

6-phase analysis pipeline: file collection + language detection → AST analysis + CodeEntityGraph + CallGraph + Panorama → dependency graph → Guard audit → dimension conditional filtering → AI knowledge extraction + refinement. 10 analysis dimensions (code standards / design patterns / architecture / best practices / event & data flow / project profile / agent guidelines / ObjC·Swift deep scan / category method scan / module export scan), with language-family-specific analysis guidance.

---

## Six-State Knowledge Lifecycle

```
pending → staging → active → evolving → active (enhanced, returns)
                      ↓                    ↓
                   decaying → deprecated ←─┘ (confirmed decay → retired)
```

Three system-driven intermediate states — staging (confidence ≥ 0.90 → 24h / 0.85~0.89 → 72h grace, then auto-publish), evolving (evolution proposal attached, type-specific observation window 24h~7d then auto-apply), decaying (standard 30d + severe 15d observation, 3 confirmations before deprecation). Agents can only push into intermediate states; system rules complete final transitions; developers retain full intervention rights.

---

## Multi-Language Static Analysis

Tree-sitter AST analysis for 11 languages — Go, Python, Java, Kotlin, Swift, JavaScript, TypeScript, Rust, Objective-C, Dart, C# (11 WASM grammars). Extracts classes, methods, properties, protocols, inheritance chains, categories, design patterns (Singleton / Delegate / Factory / Observer).

5-stage CallGraph pipeline: call site extraction → global symbol table → import path resolution → call edge resolution → data flow inference. Supports incremental analysis (≤ 10 changed files re-analyze only affected scope, reducing processing time by 50~70%).

8 project types auto-detected (SPM / Node / Maven·Gradle / Go / Python / Rust / Dart / Generic), best Discoverer selected by confidence.

---

## 6-Channel IDE Delivery

Knowledge changes auto-deliver to IDE-consumable formats:

| Channel | Path | Content |
|---------|------|---------|
| **A** | `.cursor/rules/alembic-project-rules.mdc` | alwaysApply one-liner rules (≤ 80 rules, ≤ 8K tokens) |
| **B** | `.cursor/rules/alembic-patterns-{topic}.mdc` | When/Do/Don't themed smart rules + architecture layer rules |
| **C** | `.cursor/skills/` | Project Skills sync |
| **D** | `.cursor/skills/alembic-devdocs/` | Development docs |
| **F** | `AGENTS.md` / `CLAUDE.md` / `.github/copilot-instructions.md` | Agent instruction files |
| **Mirror** | `.qoder/` / `.trae/` | IDE tool mirrors |

KnowledgeCompressor compresses Recipes: Channel A one-liner `[lang] Do X. Do NOT Y.`; Channel B structured `@trigger + When/Do/Don't/Why + skeleton code ≤ 15 lines`. Total budget capped at 50KB.

---

## Knowledge Graph

Recipes have 14 relationship types (inherits / implements / calls / depends_on / data_flow / conflicts / extends / related / alternative / prerequisite / deprecated_by / solves / enforces / references). Query impact paths, dependency depth, and related Recipes — see the structure between knowledge.

---

## Recipe Source Evidence (sourceRefs)

Recipes carry project file paths analyzed during creation as evidence. 📍 sourceRefs in search results point to real project files — the Agent can trust and reference them without self-verification. Background monitors path validity; git renames auto-repair.

---

## Signal Loop

SignalBus unifies 12 signal types (guard / search / usage / lifecycle / quality / exploration / panorama / decay / forge / intent / anomaly / guard_blind_spot) into a standard model. HitRecorder batches usage events (30s buffer + flush). Organs subscribe to signals for coordinated decisions. AI mines patterns and recommends Skills.

---

## Lark Remote Coding

Send a message on Lark from your phone — intent recognition auto-routes to Bot Agent (server-side) or local IDE via Copilot Agent Mode, results return to Lark.

---

## Recipe Remote Repository

`asd remote <url>` converts the recipe directory to an independent git sub-repository. Share Recipes across projects with independent read/write control. Constitution probes write permission via `git push --dry-run`, 86400s cache TTL.

---

## AI Provider

Semantic search, signal recommendations, Lark remote and other AI-driven features require an LLM API Key. Configure in Dashboard's LLM settings or `.env` — supports Google / OpenAI / Claude / DeepSeek / Ollama with automatic fallback. AI Provider includes circuit breaker (CLOSED/OPEN/HALF_OPEN) + 429 rate limiting + concurrency slot management (default 4).
