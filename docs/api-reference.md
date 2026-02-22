# HTTP API 参考

AutoSnippet 提供 RESTful API 供 Dashboard 和外部集成使用。

**启动方式：**

```bash
asd server -p 3000          # 仅 API
asd ui -p 3000              # API + Dashboard
```

**Base URL:** `http://127.0.0.1:3000/api/v1`

**OpenAPI Spec:** `GET /api-spec` 返回 OpenAPI 3.0 JSON 文档。

---

## 认证

默认本地运行不需要认证。通过 `constitution.yaml` 配置的角色系统控制权限：

| 角色 | 来源 | 权限范围 |
|------|------|---------|
| `developer` | 本地请求（默认） | 全部权限 |
| `external_agent` | MCP 通道 / API Key | 只读 + 创建候选 |
| `chat_agent` | Dashboard AI Chat | 只读 + 创建候选（需 reasoning） |

---

## 端点列表

### Health — 健康检查

#### `GET /health`

返回服务状态。

**响应：**
```json
{
  "success": true,
  "status": "ok",
  "timestamp": "2026-02-22T10:00:00.000Z",
  "uptime": 3600
}
```

#### `GET /health/ready`

就绪检查（数据库连接 + 服务初始化）。

---

### Auth — 认证

#### `GET /auth/probe`

返回当前请求的角色和权限信息。

**响应：**
```json
{
  "role": "developer",
  "user": "local",
  "mode": "standalone"
}
```

---

### Knowledge — 知识条目

#### `GET /knowledge`

获取知识条目列表。

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `page` | number | `1` | 页码 |
| `limit` | number | `20` | 每页数量 |
| `status` | string | — | 过滤状态：`draft` / `pending` / `approved` / `active` / `deprecated` |
| `type` | string | — | 知识类型过滤 |
| `language` | string | — | 语言过滤 |

#### `GET /knowledge/:id`

获取单个知识条目详情。

#### `POST /knowledge`

创建知识条目。

**请求体：**
```json
{
  "title": "错误处理模式",
  "language": "typescript",
  "content": "...",
  "kind": "pattern",
  "knowledgeType": "code-pattern",
  "category": "error-handling",
  "description": "...",
  "headers": { "do": "...", "trigger": "...", "usageGuide": "..." }
}
```

#### `PATCH /knowledge/:id`

更新知识条目。

#### `DELETE /knowledge/:id`

删除知识条目（需 developer 角色确认）。

#### `POST /knowledge/:id/lifecycle`

执行生命周期操作。

**请求体：**
```json
{
  "action": "approve"
}
```

**可用 action：** `submit` / `approve` / `reject` / `publish` / `deprecate` / `reactivate` / `to_draft` / `fast_track`

---

### Search — 搜索

#### `GET /search`

搜索知识库。

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `q` | string | — | 搜索查询（必填） |
| `mode` | string | `auto` | 搜索模式：`auto` / `keyword` / `bm25` / `semantic` / `context` |
| `type` | string | `all` | 类型过滤：`all` / `recipe` / `solution` / `rule` |
| `limit` | number | `10` | 最大结果数 |
| `language` | string | — | 语言过滤 |

**响应：**
```json
{
  "results": [
    {
      "id": "...",
      "title": "...",
      "score": 0.85,
      "snippet": "...",
      "knowledgeType": "code-pattern",
      "language": "typescript"
    }
  ],
  "total": 42,
  "mode": "bm25"
}
```

---

### Candidates — 候选条目

#### `GET /candidates`

获取候选条目列表。

#### `GET /candidates/:id`

获取候选详情。

#### `POST /candidates`

创建候选条目。

#### `PATCH /candidates/:id`

更新候选条目。

#### `DELETE /candidates/:id`

删除候选条目。

#### `POST /candidates/:id/approve`

批准候选 → 转为 Recipe。

#### `POST /candidates/:id/reject`

拒绝候选。

---

### Recipes — Recipes

#### `GET /recipes`

获取 Recipe 列表。

#### `GET /recipes/:id`

获取 Recipe 详情。

#### `POST /recipes/:id/relations`

发现相关 Recipes（基于知识图谱）。

---

### Guard Rules — Guard 规则

#### `GET /rules`

获取所有 Guard 规则（内置 + 自定义）。

**响应：**
```json
{
  "rules": [
    {
      "id": "js-no-eval",
      "title": "禁止 eval()",
      "description": "eval() 存在安全和性能问题",
      "severity": "error",
      "languages": ["javascript", "typescript"],
      "category": "safety",
      "enabled": true
    }
  ]
}
```

#### `POST /rules`

创建自定义 Guard 规则。

**请求体：**
```json
{
  "name": "no-console-error",
  "pattern": "console\\.error",
  "action": "warn",
  "description": "避免直接使用 console.error",
  "languages": ["javascript", "typescript"]
}
```

#### `GET /rules/:id`

获取规则详情。

#### `PATCH /rules/:id/enable`

启用规则。

#### `PATCH /rules/:id/disable`

禁用规则。

---

### Violations — 违规记录

#### `GET /violations`

获取 Guard 违规记录列表。

**查询参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `ruleId` | string | 按规则 ID 过滤 |
| `severity` | string | 按严重级别过滤 |
| `file` | string | 按文件路径过滤 |

---

### Modules — 模块扫描

#### `GET /modules`

获取项目模块结构。

#### `GET /modules/project-info`

获取项目基本信息（根路径、项目名、检测到的语言/框架）。

---

### Skills — Skill 管理

#### `GET /skills`

获取所有 Skills 列表。

#### `GET /skills/:name`

加载指定 Skill 内容。

#### `POST /skills`

创建新 Skill。

#### `PUT /skills/:name`

更新 Skill。

#### `DELETE /skills/:name`

删除 Skill。

---

### Snippets — 代码片段

#### `GET /snippets`

获取代码片段列表。

#### `POST /snippets/install`

安装代码片段到 IDE（Xcode / VS Code）。

---

### AI — AI 路由

#### `POST /ai/chat`

AI 对话（ChatAgent）。

**请求体：**
```json
{
  "message": "分析 src/utils 的代码模式",
  "conversationId": "optional-id"
}
```

支持 SSE 流式响应。

#### `GET /ai/status`

AI Provider 状态。

#### `POST /ai/reload`

热重载 AI Provider（切换模型/Key）。

---

### Extract — 提取

#### `POST /extract`

从源代码提取知识候选。

---

### Commands — 命令

#### `POST /commands/:command`

通过 API 执行 CLI 命令（`setup` / `sync` / `coldstart` 等）。

---

### Wiki — Wiki

#### `GET /wiki`

获取项目 Wiki。

#### `POST /wiki/generate`

AI 生成项目 Wiki。

---

### Monitoring — 监控

#### `GET /monitoring/metrics`

性能指标。

#### `GET /monitoring/errors`

错误日志。

---

## WebSocket（实时推送）

通过 Socket.IO 连接 `ws://127.0.0.1:3000`，接收实时事件：

| 事件 | 数据 | 说明 |
|------|------|------|
| `bootstrap:progress` | `{ phase, dimension, progress, total }` | 冷启动进度 |
| `bootstrap:complete` | `{ stats }` | 冷启动完成 |
| `refine:progress` | `{ step, progress }` | 润色进度 |
| `skill:suggestion` | `{ skill, reason }` | Skill 推荐 |
| `guard:violation` | `{ file, rule, severity }` | 实时 Guard 违规 |

---

## 错误响应

所有 API 使用统一的错误格式：

```json
{
  "success": false,
  "error": {
    "code": "KNOWLEDGE_NOT_FOUND",
    "message": "Knowledge entry not found",
    "details": {}
  }
}
```

**HTTP 状态码：**

| 码 | 含义 |
|----|------|
| `200` | 成功 |
| `201` | 创建成功 |
| `400` | 请求参数错误 |
| `401` | 未认证 |
| `403` | 权限不足 |
| `404` | 资源不存在 |
| `429` | 请求频率超限 |
| `500` | 服务器内部错误 |

---

## 中间件

API 请求经过以下中间件：

1. **CORS** — 跨域配置（默认允许所有源）
2. **Helmet** — HTTP 安全头
3. **RequestLogger** — 请求日志
4. **RoleResolver** — 角色解析
5. **GatewayMiddleware** — Gateway 权限校验
6. **RateLimiter** — 请求频率限制
7. **ErrorHandler** — 统一错误处理
