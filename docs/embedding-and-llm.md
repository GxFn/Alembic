# Embedding 与 LLM 独立运行

生成服务用于分析、生成和工具调用，可独立热切换。生产向量服务通过 Core EmbeddingPort 使用固定的 Ollama/Qwen embedding；不从当前 LLM 获取向量，也不会在向量服务不可用时切换到其他生成厂商。

## 配置

独立环境变量优先于工作区 vector.localEmbedding：

```json
{
  "vector": {
    "localEmbedding": {
      "enabled": true,
      "model": "qwen3-embedding:0.6b",
      "endpoint": "http://127.0.0.1:11434",
      "timeoutMs": 30000,
      "maxInFlightEmbeddings": 2
    }
  }
}
```

也可设置 ALEMBIC_EMBED_PROVIDER=ollama、ALEMBIC_EMBED_MODEL 与 ALEMBIC_EMBED_BASE_URL。显式空 provider 表示禁用；未配置且没有启用 localEmbedding 时保持词法检索。这里不会自动安装 Ollama 或下载模型。兼容旧 /v1 endpoint 配置时，只移除末尾 /v1 并记录诊断，真实请求使用原生 /api/embed。API key 仅来自独立 ALEMBIC_EMBED_API_KEY，支持受认证代理；不读取 LLM 的 key。

支持明确的模型标签：qwen3-embedding:0.6b（默认，1024维）、qwen3-embedding:4b（2560维）、qwen3-embedding:8b（4096维）。维度来自[Qwen 官方模型卡](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B#qwen3-embedding-series-model-list)，每个响应仍校验实际维度、有限值和非零向量；不使用通用 vector.dimensions 猜测模型，不请求 MRL 截断。未知标签、非 embedding 模型或不支持的 provider 明确拒绝。模型标签是配置身份，本实现不拉取或验证服务器权重摘要。

Core adapter 保留 Qwen 的非对称格式：查询使用指令，文档不添加查询指令。请求前取消不发 HTTP；总期限覆盖响应正文和验证，迟到结果不进入调用者。

## LLM 热切换

无 LLM 时已配置的 embedding 仍可使用。更换生成 provider/model 只重建 LLM 依赖；searchEngine、indexingPipeline、vectorService、recipeVectorGenerationRuntime 和 active generation 保留。上下文增强仍使用当前 LLM，但长期管线持有动态解析当前 enricher 的稳定委托。

POST /api/v1/commands/embed 按独立 embedding 能力检查重建条件，无需 LLM 就绪。独立 port 缺席或只有旧 LLM embed 方法时，入口返回错误，且在获取、清空或写入索引服务之前停止。

POST /api/v1/ai/env-config 可以更新 LLM 和独立 embedding 配置。embedding 字段先验证，再保存；保存不会替换运行中的固定实例：

- embeddingRestartRequired 表示连接或模型配置需重启才生效。
- embeddingRebuildRequired 表示模型空间有变化，重启后需要显式重建索引。
- 仅更换 embedding 凭据或 endpoint 需要重连，不改变声明的模型空间。
- LLM-only 更新不受旧无效 embedding 配置阻断；读取配置会给出 embeddingConfigurationError。

这些标记描述配置与运行实例的差异，不表示服务器已经探活或模型已经下载。

## 向量迁移

更换模型后按以下流程操作：保存配置，重启宿主，调用 POST /api/v1/commands/recipe-index-generation/dry-run 查看计划，再显式以 confirmed:true 调用对应 rebuild 接口。构建沿用 Core shadow/检查/CAS 流程。本文档只是操作说明，本次代码变更没有重建用户索引。

查询前会核对 active generation 的 provider、model、维度、格式和归一化方式；同维度不同模型也不允许混用。不匹配时停止 dense 读取，保留原索引、指针及管理/词法读取，自动维护只返回 planned。读写使用同一已验证 generation 快照，避免校验后另一次读取落到其他空间。

通用 base vectors 在新写入时记录模型空间元数据。历史无 profile 的向量不会混入新空间的 dense 查询；需显式全量重建通用索引。普通增量索引发现未知或不同 profile 时，在写入前返回 EMBEDDING_PROFILE_MIGRATION_REQUIRED；显式 force/clear 重建才交给 Core 重新嵌入，避免把复用的旧向量标成新模型。Core metadata filter 的保留 tag 在候选阶段限制 profile，业务 tag 条件继续保留。不会把本地 profile 不兼容计成远程 embedding 熔断失败。

增量门禁保守检查 base 中可见的通用向量。不属于文件管线的旧向量不会被 force 自动删除；需要其生产者完成迁移，或由调用者明确选择清空重建。没有承诺一次文件扫描能迁移其他生产者的数据。

Agent memory 的 query/document 用途与取消信号直接转发到该独立 port；可重建 sidecar 绑定 profile，模型空间改变时旧缓存不参与召回。

## 兼容与验证

主仓已移除 LLM→embedding fallback、按 LLM 重选 embedding 的初始化器，以及向量资源上的 aiDependent。Agent 的旧显式 SDK embed 方法仍作为兼容 API 存在，不参与生产装配。Core 实现与共享配置资产未修改。

测试使用真实 Core adapter/generation/临时 JSON 与 SQLite，以及受控 HTTP；没有真实模型请求或用户数据写入。覆盖独立启动、热切换、索引指针、query/document、取消/完整期限、配置反馈、profile 不匹配、并发激活和词法降级。
