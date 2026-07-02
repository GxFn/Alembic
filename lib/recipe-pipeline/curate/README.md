# curate — 甄选环(门禁→落库→晋级)【指针 README:主体侧薄环】

甄选的实现不在本目录——它们的单源与入口:

- 提交门禁(两宿主同源):Core `RecipeAuthoringSpec.validateAgainst`(gateRules 单表)
  +软规则申辩 `applyStyleWaiver`(styleWaiver.ts);in-process 接线在 AlembicAgent
  knowledge handler,宿主接线在 AlembicPlugin tool-router evidence gate
- candidate 落库(两宿主同终点):Core `KnowledgeService.create`
- 人工晋级:Dashboard 待审 → `PATCH /api/v1/knowledge/:id/publish`(lib/http/routes/knowledge.ts)
  → Core `KnowledgeService.publish`(lifecycle pending→active)
- 去重:Core aggregateCandidates(强制,无绕过参数)

本目录保留为四环完整性的结构占位;若未来主体侧新增甄选逻辑(批量审核/自动晋级策略),落在这里。
