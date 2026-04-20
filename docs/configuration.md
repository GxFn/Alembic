# 配置指南

Alembic 的配置分为三层：项目级 `.env` 文件、全局 `config/default.json`、权限 `constitution.yaml`。

---

## 环境变量（.env）

项目根目录的 `.env` 文件是最常用的配置方式。`alembic setup` 会生成模板。

### AI Provider

至少配置一个 API Key。多个 Key 同时存在时自动 fallback。

```env
# Google Gemini（推荐，支持 embedding）
ALEMBIC_GOOGLE_API_KEY=AIza...

# OpenAI
ALEMBIC_OPENAI_API_KEY=sk-...

# Claude
ALEMBIC_CLAUDE_API_KEY=sk-ant-...

# DeepSeek
ALEMBIC_DEEPSEEK_API_KEY=sk-...

# 本地模型（Ollama）
ALEMBIC_AI_PROVIDER=ollama
ALEMBIC_AI_MODEL=llama3
ALEMBIC_OLLAMA_HOST=http://127.0.0.1:11434
```

### Provider 选择优先级

当多个 API Key 存在时，`AiFactory` 按以下顺序自动探测：

1. `ALEMBIC_AI_PROVIDER` 环境变量（如果明确指定）
2. Google Gemini（`ALEMBIC_GOOGLE_API_KEY`）
3. OpenAI（`ALEMBIC_OPENAI_API_KEY`）
4. Claude（`ALEMBIC_CLAUDE_API_KEY`）
5. DeepSeek（`ALEMBIC_DEEPSEEK_API_KEY`）
6. Ollama（检测本地服务可用性）
7. MockProvider（无 AI 模式，知识库仍可工作）

### Embedding Provider

如果主 Provider 不支持 embedding（如 Claude），系统自动创建 fallback embedding provider：
- 优先使用 Google Gemini embedding
- 其次 OpenAI embedding
- 最后 fallback 到本地 FieldWeighted 搜索（无向量语义搜索）

### 服务器

```env
ALEMBIC_PORT=3000
ALEMBIC_HOST=127.0.0.1
```

### 其他

```env
# 日志级别
ALEMBIC_LOG_LEVEL=info          # debug / info / warn / error

# 项目根目录（MCP 模式下必需）
ALEMBIC_PROJECT_ROOT=/path/to/your-project
```

---

## 全局配置（config/default.json）

框架级默认配置，通常不需要修改。

```json
{
  "database": {
    "type": "sqlite",
    "path": "./.asd/alembic.db"
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
      "path": "./.asd/logs"
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

### 配置项说明

| 路径 | 说明 |
|------|------|
| `database.type` | 数据库类型，固定 `sqlite` |
| `database.path` | SQLite 文件路径（相对于项目根目录） |
| `server.port` | API 服务器端口 |
| `server.cors.origin` | CORS 允许的源 |
| `cache.mode` | 缓存模式：`memory`（内存） |
| `cache.ttl` | 缓存 TTL（秒） |
| `monitoring.slowRequestThreshold` | 慢请求阈值（毫秒） |
| `logging.level` | 日志级别：`debug` / `info` / `warn` / `error` |
| `constitution.strictMode` | 严格宪法模式（true = 未授权操作直接拒绝） |
| `features.USE_NEW_GATEWAY` | 启用 Gateway 管线 |
| `features.REASONING_QUALITY_SCORE` | 启用推理质量评分 |
| `ai.temperature` | AI 生成温度（0-1） |
| `ai.maxTokens` | AI 单次最大 token 数 |
| `vector.enabled` | 启用向量搜索 |
| `vector.dimensions` | 向量维度（1536 for OpenAI, 768 for Gemini） |
| `qualityGate.maxErrors` | CI 最大 error 数（0 = 零容忍） |
| `qualityGate.maxWarnings` | CI 最大 warning 数 |
| `qualityGate.minScore` | 最低合规分数（0-100） |

---

## 知识库配置（config/knowledge-base.config.js）

向量存储和检索管线的详细配置。

### 向量数据库

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
  cacheTTL: 604800,     // 7 天
  maxCacheSize: 500
}
```

### 检索漏斗

4 层漏斗，逐步精选：

```javascript
retrievalFunnel: {
  keyword:  { limit: 100 },   // 第1层：关键词粗筛
  semantic: { limit: 50 },    // 第2层：语义匹配
  fusion:   { limit: 20 },    // 第3层：融合排序
  final:    { limit: 10 }     // 第4层：精排输出
}
```

### 排序信号权重

6 个核心信号：

| 信号 | 权重 | 说明 |
|------|------|------|
| `relevance` | 0.35 | 查询相关度 |
| `authority` | 0.20 | 知识条目权威性 |
| `recency` | 0.15 | 时间新鲜度 |
| `popularity` | 0.15 | 使用频次 |
| `difficulty` | 0.10 | 实现难度 |
| `seasonality` | 0.05 | 季节性/周期性 |

### 场景化权重

不同使用场景有差异化的权重分配：

| 场景 | 侧重 |
|------|------|
| `lint` | authority + relevance |
| `generate` | relevance + recency |
| `search` | 均衡 |
| `learning` | difficulty + authority |

### 记忆系统

```javascript
memory: {
  episodic: {
    storage: 'json',
    maxSessions: 100,
    ttl: 172800           // 48 小时
  },
  conversation: {
    maxRounds: 5
  },
  semantic: {
    cacheTTL: 86400       // 24 小时
  }
}
```

### Token 预算

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

## 宪法配置（constitution.yaml）

权限和治理规则的核心配置。三层架构。

### 能力层

```yaml
capabilities:
  git_write:
    probe: "git push --dry-run"
    description: "Git 写权限探测"
```

### 角色层

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
      - "不能修改 Recipe"
      - "不能修改 Guard 规则"
      - "不能删除知识条目"

  chat_agent:
    description: "内置 AI Agent (Dashboard)"
    permissions:
      - read:recipes
      - read:candidates
      - create:candidates
    constraints:
      - "创建候选必须包含 reasoning"
      - "不能绕过 Guard 检查"

  developer:
    description: "项目所有者"
    permissions:
      - "*"
    requires:
      - git_write
```

### 治理规则

```yaml
rules:
  destructive_confirm:
    description: "删除操作需要确认"
    trigger: "delete:*"

  content_required:
    description: "创建操作必须包含内容"
    trigger: "create:*"

  ai_no_direct_recipe:
    description: "AI 不能直接批准 Recipe"
    trigger: "approve:recipe"
    deny: ["external_agent", "chat_agent"]

  batch_authorized:
    description: "批量操作需要授权"
    trigger: "batch:*"
    require: ["developer"]
```

---

## Dashboard LLM 配置

通过 Dashboard UI（`alembic ui` → LLM Config）可以在运行时切换 AI Provider 和模型，无需重启服务。

支持配置：
- Provider 选择（Gemini / OpenAI / Claude / DeepSeek / Ollama）
- API Key
- 模型名称
- Temperature
- Max Tokens

修改后通过 `ServiceContainer.reloadAiProvider()` 热重载，自动清除依赖缓存。

---

## 项目目录结构

`alembic setup` 创建的标准目录结构：

```
your-project/
├── .env                       # AI Provider 配置
├── Alembic/               # 知识数据（git-tracked）
│   ├── recipes/               # 已批准的模式 (Markdown)
│   ├── candidates/            # 待审核的候选
│   └── skills/                # 项目级 Agent 指令
├── .asd/              # 运行时缓存（gitignored）
│   ├── alembic.db         # SQLite 数据库
│   └── context/               # 向量索引
├── .cursor/mcp.json           # Cursor MCP 配置
├── .vscode/mcp.json           # VS Code MCP 配置
└── .github/copilot-instructions.md  # Copilot 指令
```

**重要原则：**
- Markdown 文件是 Source of Truth
- SQLite 是读缓存，`alembic sync` 可重建
- `Alembic/` 目录跟随 Git
- `.asd/` 目录列入 `.gitignore`
