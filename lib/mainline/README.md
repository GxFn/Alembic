# Mainline

`lib/mainline` 是 Alembic 的知识主线和运行时主线。它消费 `lib/engineering` 产出的工程事实，把源码事实、Recipe、SourceRef、搜索索引、运行期召回和 Agent 注入整理成稳定 read model。

Mainline 不再承载底层工程理解算法。AST、调用图、实体图、模块全景、冷启动前工程 workflow 和增量工程扫描属于 `lib/engineering`；mainline 只做编译期投影、知识资产治理、运行期召回和插件/agent 需要的稳定边界。

## 依赖方向

从底层到上层：

```text
core
  -> data
  -> knowledge / search / graph
  -> compile
  -> runtime
  -> agent
  -> surface
```

允许的外部依赖：

- `compile` 可以消费 `lib/engineering` 的工程事实接口。
- `agent`、`runtime`、`surface` 可以被 Codex tool、daemon、workflow 和 internal agent tool 消费。
- `ai` 是 mainline 内的 provider/model/guard 端口，供 agent runtime 和 codex adapter 使用。

不允许的反向依赖：

- mainline 不能依赖 `lib/codex`、`lib/daemon`、`lib/workflows`、`lib/agent/tools` 或 IDE 插件层。
- `runtime` 和 `agent` 不能触发 scan/compile/write，它们只读已编译 read model。
- `knowledge`、`search`、`data` 不应该引用 workflow、daemon 或 agent runtime。

## 子域

- `core/`：路径、写边界、文件系统、锁、调度、事件、能力注册和基础端口。
- `data/`：ContextIndex、ArtifactStore、JobLedger、JSON store 和 fingerprint snapshot。
- `knowledge/`：Recipe、SourceRef、GuardFinding、Markdown 存储、质量/相似度/提交闸门。
- `search/`：结构化搜索文档、sparse/vector/RRF 混合召回和索引持久化。
- `graph/`：ProjectIntelligence artifact/read model，把工程事实投影为 mainline 可序列化项目事实。
- `compile/`：冷启动/增量编译编排、content mining、project intelligence、SourceRef repair、Recipe impact 和 search materialize。
- `runtime/`：运行期只读召回、query planning、ranking、context bundle 和 token budget。
- `agent/`：prime/knowledge injection 的 agent-facing 编排与 Markdown 呈现。
- `ai/`：AI provider、embedding、model registry、任务计划和参数 guard。
- `surface/`：IDE/plugin/tool capability surface 的类型和投影。

## 当前整理规则

- public 类型和 barrel export 保持稳定，重构优先拆内部 helper，不做破坏性改名。
- `Mainline*` 命名保留在 public API 上，文件名只在新增内部 helper 时使用短职责名。
- mainline 子目录必须有 README，说明自身边界和禁止依赖。
- 重复实现先隔离并标注归属，再评估删除；不在结构整理中直接丢成熟行为。
