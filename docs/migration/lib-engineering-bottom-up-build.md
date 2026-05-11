# lib/engineering 自底向上建设记录

## 目标

新的工程能力不再继续堆在旧工程目录下，而是在 `lib/engineering` 建成独立模块。当前阶段不考虑外部接入，先保证模块内部自底向上完整、隔离、可测试。

隔离设计见 `docs/migration/lib-engineering-isolated-design.md`。

## 当前分层

1. `foundation`
   - 领域基础类型：target、file、dependency graph、relationship graph、discoverer。
   - 通用节点规范化与外部依赖判断。

2. `language`
   - `EngineeringLanguageService`：语言规范化、扩展名、测试文件、跳过目录。
   - `EngineeringLanguageProfiles`：语言族、import pattern、role pattern、superclass/protocol role、known libraries、vendor dirs、artifact suffixes。

3. `graph`
   - 加权边合并。
   - Tarjan SCC 循环检测。
   - fan-in/fan-out 与 weighted fan-in/out。

4. `workspace`
   - project-relative path。
   - module name from path。
   - source/test/third-party path 判断。

5. `code`
   - `EngineeringCodeGraphReader`：为上层定义 code graph 读取口，不依赖旧主线实现。

6. `panorama`
   - `EngineeringPanoramaTypes`：独立全景输入输出类型。
   - `EngineeringPanoramaRefiner`：独立全景精化实现，只依赖 `lib/engineering` 内部 foundation/language/workspace/graph/code。

## 当前验证

- `lib/engineering/engineering-foundation.test.ts` 覆盖 language、graph、workspace 底层。
- `lib/engineering/panorama/engineering-panorama-refiner.test.ts` 覆盖 panorama refiner 的加权耦合、配置层级、外部依赖、角色信号。

## 下一层建设顺序

1. 新建 `lib/engineering/code` 完整实现，吸收 `EngineeringCodeGraph` 与 ProjectGraph 查询能力。
2. 新建 `lib/engineering/entity`，吸收 `EngineeringEntityGraph` 与 CodeEntityGraph 查询能力。
3. 新建 `lib/engineering/discovery`，把成熟 discoverer 栈迁入独立模块。
4. 完善 `lib/engineering/panorama`，继续迁入 TechStackProfiler、DimensionAnalyzer、PanoramaAggregator。
5. 最后新建 `lib/engineering/workflow`，承接冷启动前 Phase runner 和增量 planner。
