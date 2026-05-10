# Alembic Route Skill

当用户正在修改代码，并且需要项目专属上下文时，使用这条 route。

1. 从当前任务、变更文件、symbol、diff 和错误构造 `ActiveWorkContext`。
2. 向 Alembic 请求 `ContextBundle`。
3. 在编辑代码前应用这个 bundle。
4. 对相关 diff 运行前向 Guard。
5. 把新的发现转换为 `CaptureDraft` 或 `RescanRequest`。

不要从这条 route 触发 Wiki generation、Tool Forge、ReverseGuard 或全项目 rescan。
