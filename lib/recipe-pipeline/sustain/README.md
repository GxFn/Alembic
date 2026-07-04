# sustain — 维护环(进化+gap-fill 计划)

- 差距重扫编排已随 W3 归位 generate 环:本体在 `generate/incremental/IncrementalRescanWorkflow.ts`
  (它是 GenerateWorkflow mode='incremental' 的实现;cleanupPolicy 与 miningMode
  是两个独立字段,历史双义已在 S4 澄清)。`KnowledgeRescanWorkflow.ts` 仅剩兼容 re-export 壳,
  不再承载注册副作用,一个波次后评估退役。
- `ProduceSessionPlan.ts` — 生产会话 gap-fill 投影/计划构建器(W3 名实修正,更名自
  ProduceSessionRoute.ts)
- `evolution/` — 文件变更→进化信号侧:DaemonFileChangeCollector/InProcessFileChangeHandler
  /EvolutionMaintenanceSweep(daemon-less 有界 tick 的编排面)
- 状态机与提案(在 Core,不在此):LifecycleStateMachine.transition 唯一权威/DecayDetector
  (6 信号)/ProposalExecutor(SignalBus 驱动)/ProposalGateway(提案分发)
- lifecycle 6 状态值与 proposal.status 5 值是 wire 冻结(wire-contract.md)
