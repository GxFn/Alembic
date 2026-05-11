# lib/engineering 独立模块设计

## 方向

`lib/engineering` 是新的工程理解主模块。它先作为完全隔离模块建设，不依赖 `lib/mainline/engineering`，也不考虑 agent tool、cold-start runner、plugin 或旧主线接入。接入会在模块内部边界稳定后再做。

设计原则：

1. 自底向上：先 foundation/language/workspace/graph，再 code/entity/panorama，最后 workflow。
2. 功能不丢：legacy 已验证能力先迁成模块内能力，再考虑删冗余。
3. 接口干净：模块输入输出只用 `lib/engineering` 自己的类型。
4. 旧实现不直连：不把旧 DB、repository、DI、HTTP、dashboard 依赖揉进新模块。

## 当前结构

### foundation

路径：`lib/engineering/foundation`

职责：

- 工程发现、target、file、dependency graph、relationship graph 的基础类型。
- dependency node 规范化。
- 外部依赖节点判断。

### language

路径：`lib/engineering/language`

职责：

- 语言规范化。
- source extension 和 skip dir。
- language family。
- import pattern。
- superclass/protocol role。
- import role pattern。
- known libraries、vendor dirs、artifact suffixes。
- config layer 到 module role 的映射。

这层吸收 legacy `LanguageService` 与 `LanguageProfiles` 的核心职责，是 panorama、module discoverer、tech stack、tool 过滤的共同底座。

### workspace

路径：`lib/engineering/workspace`

职责：

- absolute path 到 project-relative path。
- file path 到 module name。
- source/test/third-party path 判断。

### graph

路径：`lib/engineering/graph`

职责：

- 加权边合并。
- Tarjan SCC 循环检测。
- fan-in/fan-out 与 weighted fan-in/out。

### code

路径：`lib/engineering/code`

当前职责：

- 定义 `EngineeringCodeGraphReader`。
- 定义 code graph 对 panorama 所需的最低读取接口。

后续职责：

- 迁入 ProjectGraph 风格 class/protocol/category/method/file 查询。
- 补齐继承链、conformance、category extension、method override、incremental update。

### panorama

路径：`lib/engineering/panorama`

当前职责：

- 独立 `EngineeringPanoramaTypes`。
- 独立 `EngineeringPanoramaRefiner`。
- 加权 coupling。
- external dependency fan-in。
- config-first layer inference。
- topology fallback layer inference。
- layer violation。
- AST/call/data-flow/topology/config/regex 多信号 role refinement。

当前已做到：

- 不依赖旧主线类型。
- 不依赖旧 DB/repository。
- 不依赖插件入口。
- 只依赖 `lib/engineering` 内部 foundation/language/workspace/graph/code。

## 下一步层级

1. `code`
   - 把当前 active `EngineeringCodeGraph` 迁入 `lib/engineering/code`。
   - 输入改为独立 AST summary 类型。
   - 输出保留 ProjectGraph 成熟查询能力。

2. `entity`
   - 把当前 active `EngineeringEntityGraph` 迁入 `lib/engineering/entity`。
   - 增加 path、impact radius、topology、agent context 查询。

3. `discovery`
   - 把成熟 discoverer 栈迁入 `lib/engineering/discovery`。
   - discovery 输出只使用 foundation 类型。

4. `panorama`
   - 继续迁入 TechStackProfiler、DimensionAnalyzer、PanoramaAggregator 的非 DB 核心逻辑。
   - 用新 `entity` 和 `code` 读模型替换任何临时输入。

5. `workflow`
   - 新建冷启动前工程 pipeline。
   - 对齐 legacy Phase 1 → Phase 2.2。
   - 再接增量 planner 和 snapshot store。

## 不做

- 不在这个阶段接 agent tool。
- 不在这个阶段接 cold-start runner。
- 不在这个阶段桥接旧主线入口。
- 不迁旧 UI/HTTP/DI。
- 不删除 raw legacy source，直到新模块同等能力被测试覆盖。
