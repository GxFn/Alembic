# Engineering Code Module

`lib/engineering/code` 是 Alembic 的源码理解底座。它只负责把源码文件转成稳定的语言、AST、import、symbol、call/data-flow 和 code graph 事实；上层的 entity graph、panorama、workflow、agent tool 只能消费这些事实，不能把自己的状态或流程逻辑沉进这里。

## 边界

应该放在这里：

- 语言识别、源码扫描、路径别名解析和轻量 import/symbol/call 解析。
- tree-sitter runtime、多语言 walker、AST facts normalization。
- 调用边、数据流边、符号表、导入解析和 code graph 查询。
- mainline/agent tool 需要复用的纯源码事实 API。

不应该放在这里：

- workflow/cold-start 调度、缓存策略、snapshot 保存。
- entity/panorama 级别的模块角色、业务维度、知识缺口和 Guard 判断。
- daemon、IDE、Codex 协议、数据库 repository 或外部进程生命周期。

## 公共入口

外部模块统一从 `lib/engineering/code/index.ts` 引用 code 能力。不要从 `mainline/*`、`analysis/*`、`ast/*`、`tree-sitter/*` 等内部路径穿透引用；这些文件可以继续重排，但 `index.ts` 才是 code 模块对外的稳定边界。

```ts
import {
  EngineeringCodeGraph,
  TreeSitterMainlineAstParser,
  defaultMainlineLanguageCatalog,
} from "../engineering/code/index.js";
```

`mainline/` 是当前 mainline 与 agent tool 复用的 port/adapter 层，保留 `Mainline*` public 类型名，但不再散落在 code 根目录。`analysis/graph-normalization.ts` 和 `analysis/graph-query.ts` 是 `graph.ts` 的内部 helper。`tree-sitter/ast/*` 是多语言 walker，`tree-sitter/analysis/import-record.ts` 是迁入 walker 共享的结构化 import 记录，`parser-init.ts`、`registry.ts` 是 parser runtime 的内部实现；除非要扩展解析引擎，否则不要直接依赖。

## 分层

从底层到上层：

1. `mainline/language-catalog.ts`、`mainline/language-service.ts`、`mainline/source-scanner.ts`：语言 profile、源码文件筛选、测试/第三方路径识别。
2. `tree-sitter/`：web-tree-sitter runtime、多语言 walker、调用点/import/metrics 抽取；语言插件统一放在 `tree-sitter/ast/`，runtime 聚合、registry、parser init 和 agent/project 投影留在 tree-sitter 根层。
3. `ast/`：把 tree-sitter 或外部 AST 摘要归一化成 `EngineeringCodeAst*` facts。
4. `mainline/ast-port.ts`、`mainline/tree-sitter-parser.ts`：给 mainline 和 agent tool 使用的 AST parser port。
5. `mainline/import-parser.ts`、`mainline/import-path-resolver.ts`、`mainline/symbol-table.ts`、`mainline/call-site-extractor.ts`：轻量解析与路径/符号辅助能力。
6. `analysis/`：成熟分析器，包含 call graph、call edge resolve、data-flow、symbol table 和 import path analysis。
7. `graph.ts`、`types.ts`：源码事实的 code graph 聚合、查询、序列化和增量清理。

## 主链路

```text
source files
  -> language service / source scanner
  -> tree-sitter runtime
  -> AST facts normalizer
  -> import / symbol / call / data-flow analysis
  -> EngineeringCodeGraph
```

## 当前状态

- `tree-sitter` 多语言 walker 和 `ast/normalizer.ts` 保留成熟实现，不把它们简化成浅 parser。
- `mainline/` 已成为独立 adapter/port 层，code 根目录不再混放 Mainline parser、scanner、resolver 文件。
- `tree-sitter/` 已继续整理为 code 内部层：语言插件归位到 `tree-sitter/ast/`，共享 `ImportRecord` 改为短横线命名，agent context 与 project summary 从 runtime 入口拆出。
- `graph.ts` 已把 AST summary normalization 与 query helper 拆到 `analysis/graph-normalization.ts`、`analysis/graph-query.ts`。
- `Mainline*` 命名仍是当前 mainline 调用方使用的 public port/type 名；这是 API 稳定问题，不代表这里保留旧路径兼容层。
- 后续整理优先级：继续拆 `ast/normalizer.ts` 的解析策略 helper、压缩 `tree-sitter/index.ts` 的 analyze runtime 编排、把语言 walker 的共享节点工具收敛到 tree-sitter 内部公共 helper。
