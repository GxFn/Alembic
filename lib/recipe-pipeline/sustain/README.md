# sustain — 维护环(重扫+进化)

- `KnowledgeRescanWorkflow.ts` — 差距重扫:gap 分析(Core KnowledgeRescanPlanBuilder)
  →per-dimension createBudget→复用 Generate 环执行;cleanupPolicy(rescan-clean/force-rescan)
  与 miningMode 是两个独立字段(历史双义已在 S4 澄清)
- `ProduceSessionRoute.ts` — 生产会话路由
- `evolution/` — 文件变更→进化信号侧:DaemonFileChangeCollector/InProcessFileChangeHandler
  /EvolutionMaintenanceSweep(daemon-less 有界 tick 的编排面)
- 状态机与提案(在 Core,不在此):LifecycleStateMachine.transition 唯一权威/DecayDetector
  (6 信号)/ProposalExecutor(SignalBus 驱动)/ProposalGateway(提案分发)
- lifecycle 6 状态值与 proposal.status 5 值是 wire 冻结(wire-contract.md)
