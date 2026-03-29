# Configuration

AutoSnippet configuration is organized in three tiers: project-level `.env` file, global `config/default.json`, and permission `constitution.yaml`.

---

## Environment Variables (.env)

The `.env` file in the project root is the most common configuration method. `asd setup` generates a template.

### AI Provider

Configure at least one API Key. When multiple Keys are present, automatic fallback is applied.

```env
# Google Gemini (recommended, supports embedding)
ASD_GOOGLE_API_KEY=AIza...

# OpenAI
ASD_OPENAI_API_KEY=sk-...

# Claude
ASD_CLAUDE_API_KEY=sk-ant-...

# DeepSeek
ASD_DEEPSEEK_API_KEY=sk-...

# Local model (Ollama)
ASD_AI_PROVIDER=ollama
ASD_AI_MODEL=llama3
ASD_OLLAMA_HOST=http://127.0.0.1:11434
```

### Provider Selection Priority

When multiple API Keys are present, `AiFactory` auto-detects in this order:

1. `ASD_AI_PROVIDER` environment variable (if explicitly set)
2. Google Gemini (`ASD_GOOGLE_API_KEY`)
3. OpenAI (`ASD_OPENAI_API_KEY`)
4. Claude (`ASD_CLAUDE_API_KEY`)
5. DeepSeek (`ASD_DEEPSEEK_API_KEY`)
6. Ollama (checks local service availability)
7. MockProvider (no-AI mode, knowledge base still works)

### Embedding Provider

If the primary Provider doesn't support embedding (e.g., Claude), the system auto-creates a fallback embedding provider:
- Prefers Google Gemini embedding
- Then OpenAI embedding
- Falls back to local BM25 (no vector semantic search)

### Server

```env
ASD_PORT=3000
ASD_HOST=127.0.0.1
```

### Other

```env
# Log level
ASD_LOG_LEVEL=info          # debug / info / warn / error

# Project root (required in MCP mode)
ASD_PROJECT_ROOT=/path/to/your-project
```

---

## Global Configuration (config/default.json)

Framework-level defaults, typically no modification needed.

```json
{
  "database": {
    "type": "sqlite",
    "path": "./.autosnippet/autosnippet.db"
  },
  "server": {
    "port": 3000,
    "host": "localhost",
    "cors": {
      "enabled": true,
      "origin": "*"
    }
  },
  "cache": {
    "mode": "memory",
    "ttl": 300
  },
  "monitoring": {
    "enabled": true,
    "slowRequestThreshold": 1000
  },
  "logging": {
    "level": "info",
    "format": "json",
    "file": {
      "enabled": true,
      "path": "./.autosnippet/logs"
    }
  },
  "constitution": {
    "path": "./config/constitution.yaml",
    "strictMode": true
  },
  "features": {
    "USE_NEW_GATEWAY": true,
    "REASONING_QUALITY_SCORE": true
  },
  "ai": {
    "provider": "openai",
    "model": "gpt-4",
    "temperature": 0.7,
    "maxTokens": 2000
  },
  "vector": {
    "enabled": true,
    "dimensions": 1536,
    "indexPath": "./data/vector-index"
  },
  "qualityGate": {
    "maxErrors": 0,
    "maxWarnings": 20,
    "minScore": 70
  }
}
```

### Configuration Reference

| Path | Description |
|------|-------------|
| `database.type` | Database type, fixed as `sqlite` |
| `database.path` | SQLite file path (relative to project root) |
| `server.port` | API server port |
| `server.cors.origin` | CORS allowed origins |
| `cache.mode` | Cache mode: `memory` |
| `cache.ttl` | Cache TTL (seconds) |
| `monitoring.slowRequestThreshold` | Slow request threshold (milliseconds) |
| `logging.level` | Log level: `debug` / `info` / `warn` / `error` |
| `constitution.strictMode` | Strict constitution mode (true = unauthorized operations rejected) |
| `features.USE_NEW_GATEWAY` | Enable Gateway pipeline |
| `features.REASONING_QUALITY_SCORE` | Enable reasoning quality scoring |
| `ai.temperature` | AI generation temperature (0-1) |
| `ai.maxTokens` | AI max tokens per request |
| `vector.enabled` | Enable vector search |
| `vector.dimensions` | Vector dimensions (1536 for OpenAI, 768 for Gemini) |
| `qualityGate.maxErrors` | CI max errors (0 = zero tolerance) |
| `qualityGate.maxWarnings` | CI max warnings |
| `qualityGate.minScore` | Minimum compliance score (0-100) |

---

## Knowledge Base Configuration (config/knowledge-base.config.js)

Detailed configuration for vector storage and retrieval pipeline.

### Vector Database

```javascript
vectorDb: {
  type: 'milvus',
  dimension: 768,
  indexType: 'IVF_FLAT',
  metric: 'L2',
  nlist: 128
}
```

### Embedding

```javascript
embedding: {
  model: 'text-embedding-3-small',
  dimension: 768,
  cacheTTL: 604800,     // 7 days
  maxCacheSize: 500
}
```

### Retrieval Funnel

4-stage funnel with progressive refinement:

```javascript
retrievalFunnel: {
  keyword:  { limit: 100 },   // Stage 1: keyword rough filter
  semantic: { limit: 50 },    // Stage 2: semantic matching
  fusion:   { limit: 20 },    // Stage 3: fusion ranking
  final:    { limit: 10 }     // Stage 4: final rerank
}
```

### Ranking Signal Weights

6 core signals:

| Signal | Weight | Description |
|--------|--------|-------------|
| `relevance` | 0.35 | Query relevance |
| `authority` | 0.20 | Knowledge entry authority |
| `recency` | 0.15 | Time freshness |
| `popularity` | 0.15 | Usage frequency |
| `difficulty` | 0.10 | Implementation difficulty |
| `seasonality` | 0.05 | Seasonality/periodicity |

### Scenario-based Weights

Different scenarios have differentiated weight distributions:

| Scenario | Focus |
|----------|-------|
| `lint` | authority + relevance |
| `generate` | relevance + recency |
| `search` | balanced |
| `learning` | difficulty + authority |

### Memory System

```javascript
memory: {
  episodic: {
    storage: 'json',
    maxSessions: 100,
    ttl: 172800           // 48 hours
  },
  conversation: {
    maxRounds: 5
  },
  semantic: {
    cacheTTL: 86400       // 24 hours
  }
}
```

### Token Budget

```javascript
tokenBudget: {
  maxTokens: 4000,
  allocation: {
    systemPrompt: 300,
    history: 1200,
    recipes: 800,
    userInput: 300,
    buffer: 400
  }
}
```

---

## Constitution Configuration (constitution.yaml)

Core configuration for permissions and governance rules. Three-tier architecture.

### Capability Tier

```yaml
capabilities:
  git_write:
    probe: "git push --dry-run"
    description: "Git write permission probe"
```

### Role Tier

```yaml
roles:
  external_agent:
    description: "IDE AI Agent (Cursor/Copilot/Claude Code)"
    permissions:
      - read:recipes
      - read:guard_rules
      - create:candidates
      - submit:knowledge
      - knowledge:bootstrap
      - create:skills
      - update:skills
      - delete:skills
    constraints:
      - "Cannot modify Recipes"
      - "Cannot modify Guard rules"
      - "Cannot delete knowledge entries"

  chat_agent:
    description: "Built-in AI Agent (Dashboard)"
    permissions:
      - read:recipes
      - read:candidates
      - create:candidates
    constraints:
      - "Creating candidates must include reasoning"
      - "Cannot bypass Guard checks"

  developer:
    description: "Project owner"
    permissions:
      - "*"
    requires:
      - git_write
```

### Governance Rules

```yaml
rules:
  destructive_confirm:
    description: "Delete operations require confirmation"
    trigger: "delete:*"

  content_required:
    description: "Create operations must include content"
    trigger: "create:*"

  ai_no_direct_recipe:
    description: "AI cannot directly approve Recipes"
    trigger: "approve:recipe"
    deny: ["external_agent", "chat_agent"]

  batch_authorized:
    description: "Batch operations require authorization"
    trigger: "batch:*"
    require: ["developer"]
```

---

## Dashboard LLM Configuration

Through the Dashboard UI (`asd ui` → LLM Config), you can switch AI Provider and model at runtime without restarting the service.

Configurable options:
- Provider selection (Gemini / OpenAI / Claude / DeepSeek / Ollama)
- API Key
- Model name
- Temperature
- Max Tokens

Changes are applied via `ServiceContainer.reloadAiProvider()` hot-reload, automatically clearing dependency caches.

---

## Project Directory Structure

Standard directory structure created by `asd setup`:

```
your-project/
├── .env                       # AI Provider configuration
├── AutoSnippet/               # Knowledge data (git-tracked)
│   ├── recipes/               # Approved patterns (Markdown)
│   ├── candidates/            # Pending review candidates
│   └── skills/                # Project-level Agent instructions
├── .autosnippet/              # Runtime cache (gitignored)
│   ├── autosnippet.db         # SQLite database
│   └── context/               # Vector index
├── .cursor/mcp.json           # Cursor MCP config
├── .vscode/mcp.json           # VS Code MCP config
└── .github/copilot-instructions.md  # Copilot instructions
```

**Key principles:**
- Markdown files are the Source of Truth
- SQLite is a read cache; `asd sync` can rebuild it
- `AutoSnippet/` directory is tracked by Git
- `.autosnippet/` directory is in `.gitignore`
