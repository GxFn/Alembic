# recipe-pipeline — Recipe 生成维护全链(四环)

Recipe 的完整生命周期按四环组织,目录即功能边界(S4 批4,2026-07-02):

| 环 | 目录 | 职责 | 主入口 |
|---|---|---|---|
| Plan(规划) | `plan/` | 项目情报投影→维度与规模决策(内部 LLM) | `PlanSelectionGate.ts` |
| Generate(生成) | `generate/` | 三 stage 执行:coldStart 全量首扫 / deepMining 差距多轮 / moduleMining 模块定向 | `ColdStartWorkflow.ts` → `GenerateWorkflow.ts` |
| Curate(甄选) | `curate/` | 提交门禁→candidate 落库→人工晋级(主体侧薄环,见其 README 指针) | — |
| Sustain(维护) | `sustain/` | 差距重扫+decay/proposal/evolution 编排 | `KnowledgeRescanWorkflow.ts` |

共用事实层(不属于任一环,保持原位):
- `../project-facts/` — Phase1-4 项目情报采集,Plan 与 Generate 共同消费
- Core 共享内核经 `@alembic/core`:planFacts 投影 / planIntent 契约 / RecipeAuthoringSpec 门禁 / DIMENSION_COMPLETION_FLOOR / RECIPE_PIPELINE_EVENTS

Wire 契约(改名冻结名单):`AlembicCore/docs/wire-contract.md`。
两宿主分叉:本目录是主体 in-process(daemon+内部 LLM)执行皮;宿主 Agent 皮在 `AlembicPlugin/lib/recipe-generation/`,共享 Core 内核,差异明细见 workspace `Design/docs/current/alembic-recipe-pipeline-unification-2026-07-02.md` §3.5。
