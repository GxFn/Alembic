# Engineering Module

`lib/engineering` 是 Alembic 的工程理解底座。它负责把一个真实项目从文件、语言、构建配置、AST、调用关系、实体关系、模块全景到增量快照整理成稳定事实，供 mainline、agent tools、Guard、冷启动和增量 workflow 复用。

这个模块不绑定 Codex、VS Code、daemon、HTTP 或数据库副作用。外层可以接入它，但不能反过来定义它的核心模型。

## 设计原则

- 底层优先：先保源码扫描、语言解析、依赖解析、AST、调用图、实体图，再向 workflow 和 agent context 汇总。
- 少层级：目录表达领域，文件名只表达职责，例如 `code/graph.ts`、`entity/graph.ts`、`workflow/runner.ts`。
- 类型稳定：当前保留 `Engineering*` 类型名，避免文件整理时制造 API 震荡；文件名和目录先变清晰。
- 功能不丢：成熟实现默认迁入。删除旧实现前要确认能力已进入 engineering，并能被测试覆盖。
- 接入分离：`mainline`、agent tool、workflow 只作为 adapter 使用 engineering，不在外层继续沉淀工程核心能力。

## 分层

从底层到上层的推荐阅读顺序：

1. `foundation/`：跨模块共享的工程文件、target、依赖图等基础类型。
2. `language/`：语言、扩展名、测试文件、第三方路径、角色 profile。
3. `discovery/`：项目发现器和配置解析器，识别 Node、SPM、Python、Go、Rust、Dart、JVM、自定义工程等入口。
4. `workspace/`：workspace root、ghost/standard 数据根、project registry、写入边界。
5. `code/`：源码解析底座，包括 AST facts、tree-sitter runtime、多语言 walker、import/call/symbol/data-flow 分析和 code graph。
6. `entity/`：把文件、target、module、class、method、recipe、pattern、call/data-flow 统一成可查询实体图。
7. `panorama/`：模块发现、角色精化、技术栈、健康度、知识缺口和项目全景快照。
8. `dimension/` 与 `enhancement/`：工程维度、SOP、增强包和可选分析信号。
9. `snapshot/`：工程 artifact 的持久化投影、响应投影和 session cache 投影。
10. `workflow/`：冷启动前工程流水线，串联 discovery、cache、facts、graphs、panorama、optional stage 和 snapshot。
11. `graph/`：面向外部 agent/tool 的统一查询 provider。

## 关键链路

冷启动前工程链路：

```text
workspace/discovery
  -> code AST and analysis
  -> code graph
  -> entity graph
  -> panorama
  -> optional dimensions and enhancements
  -> snapshot/projection
  -> graph query provider
```

增量链路：

```text
snapshot-store
  -> diff-planner
  -> incremental planner
  -> targeted/full/skip workflow mode
  -> refreshed snapshot
```

## 命名规则

- 文件名使用短职责名：`graph.ts`、`types.ts`、`runner.ts`、`registry.ts`、`service.ts`。
- 目录已经提供上下文，不在文件名重复 `Engineering`、`Code`、`Workflow` 等长前缀。
- 测试文件跟随被测职责：`graph.test.ts`、`registry.test.ts`、`tree-sitter-runtime.test.ts`。
- public 类型名暂时保留完整语义，例如 `EngineeringCodeGraph`、`EngineeringWorkflowResult`。后续只有在外部接入稳定后，再考虑类型别名或渐进改名。

## 边界

应该放在这里：

- 纯工程事实解析、聚合、查询、投影。
- 可复用的项目发现、语言解析、模块关系、调用图、增量扫描算法。
- agent 内部工具需要消费的稳定工程 API。

不应该放在这里：

- IDE 插件 UI。
- daemon 生命周期、HTTP server、数据库 repository。
- Codex 专属协议或外部权限交互。
- 只服务某一个接入层的临时 glue。

## 当前整理状态

- `lib/mainline/code` 已迁入 `code/` 并删除旧目录。
- `code/tree-sitter` 持有成熟多语言 runtime 和 walker。
- `workflow/runner.ts` 是当前冷启动前工程流水线入口，cache/incremental 评估、optional phase、snapshot run 和 workflow status 已拆到同目录短职责文件。
- `code/graph.ts` 保留公开图接口和索引状态，AST summary 归一化与图查询 helper 已拆到 `code/analysis/graph-normalization.ts`、`code/analysis/graph-query.ts`。
- `panorama/module-discoverer.ts` 保留模块发现编排，模块发现类型、规则和 import fallback 推断已拆出。
- `panorama/refiner.ts` 保留全景精化编排，层级推断和角色精化已拆出。
- `dimension/sop.ts` 保留查询 API，大段 SOP 数据、类型和构建器已拆出。
- `graph/query-provider.ts` 是 agent/tool 侧查询入口。
- `enhancement/` 已迁入 Alembic-legacy 的 14 个成熟 Enhancement Pack，实现 per-pack class、维度追加、Guard 规则、AST pattern 检测和 Vue SFC 预处理；workflow optional 阶段通过 registry 消费这些真实 pack，不再依赖浅 catalog。
- 仍需继续整理 `entity/graph.ts`、`code/ast/normalizer.ts`、`discovery` parser 规则和 `graph/query-provider.ts`，但不应引入额外抽象层。

## 全量扫描结论

本模块当前约 4.8 万行 TypeScript。整理优先级不按“看起来像旧名”判断，而按真实职责密度、依赖密度和工程链路位置判断：

- `workflow/runner.ts`：冷启动前流水线入口已拆出 cache/incremental、optional stage、snapshot 保存和 status helper，后续只继续收敛 stage 函数边界。
- `code/graph.ts` 与 `entity/graph.ts`：保存成熟图查询能力；`code/graph.ts` 已拆出 normalization/query helper，`entity/graph.ts` 仍待拆 topology 与 cleanup helper。
- `code/ast/normalizer.ts` 与 `code/tree-sitter/ast/*`：保留成熟多语言 AST 能力；整理时只清边界，不把语言 walker 简化成浅实现。
- `panorama/module-discoverer.ts` 与 `panorama/refiner.ts`：模块发现、import fallback、拓扑分层、角色推断都属于主线能力；规则/类型/推断 helper 已拆出，不删信号。
- `dimension/sop.ts`：SOP 数据体积大但属于稳定知识资产，当前已拆成数据、类型、构建器和查询 API。

## 执行切分

并行整理按文件所有权推进，避免多个窗口互相覆盖：

1. `workflow` 窗口：拆 `runner.ts` 的 cache/incremental 评估、optional stage phase、snapshot 保存与阶段执行函数。
2. `code/entity` 窗口：拆 code graph、entity graph 的纯 helper、normalization、query/topology 逻辑，保持 public 类稳定。
3. `discovery/panorama/dimension` 窗口：拆 discovery parser 规则、panorama 模块发现/精化规则、dimension SOP 数据与查询函数。
4. 总控窗口：只处理 README、根出口、交叉 import、typecheck/test 和最终验收，不抢子窗口文件。

## 验收标准

- `lib/engineering` 内成熟功能不因整理丢失，测试仍覆盖 AST、模块发现、图查询、增量计划和 workflow。
- 文件名短而语义明确，目录承担上下文，避免重复 `Engineering*` 文件前缀。
- 主入口类只保留编排和状态，数据转换、规则表、纯 helper 移入同目录短职责文件。
- 不新增兼容层，不为旧路径做双轨分叉；确实需要保留旧行为时，用稳定 public 类型或测试说明原因。
