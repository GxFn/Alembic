# Dashboard

> Alembic 的可视化管理界面。通过 `asd ui` 启动。
>
> [English](dashboard.en.md)

## 技术栈

- React 19.2 + TypeScript 5.9
- Vite 7.3
- Tailwind CSS 4.2 + Radix UI
- Socket.IO 4.8（实时通信）
- Mermaid 11.12（图表渲染）

## 功能视图

| 视图 | 功能 |
|------|------|
| **Recipes** | 浏览 / 编辑 / 删除，排序（名称 / 权威度 / 使用量 / 日期），Markdown 编辑器 + frontmatter 可视化 |
| **Candidates** | 按维度分组审核，AI 精炼预览 / 应用，批量发布，冷启动 |
| **Knowledge** | 完整 6 态生命周期管理，批量操作，质量审计 |
| **Guard** | 规则库（内置 + 自定义），违规追踪，ReverseGuard，合规报告，从 Recipe 导入规则 |
| **Panorama** | 分层架构可视化，模块依赖图，覆盖率热力图，11 维健康雷达，环检测，知识缺口 |
| **Modules** | 多语言构建目标浏览，模块依赖 DAG 图 |
| **Skills** | 内置 + 项目级 Skill 管理，AI 自动推荐 |
| **Wiki** | 全量 / 增量 Wiki 生成，流式进度，Markdown 预览 |
| **Signals** | 信号 trace 查询（类型 / 时间 / 来源），报告分类（治理 / 合规 / 度量） |
| **Knowledge Graph** | Recipe 关系图可视化（Mermaid 渲染） |
| **AI Chat** | 内置 AI 对话，SSE 流式响应 |
| **LLM 配置** | 多 Provider（OpenAI / Claude / Gemini / DeepSeek / Ollama），API Key 管理，连接测试 |

## 全局功能

- **全局搜索** — Cmd+K 打开，快速跳转到任意视图
- **命令面板** — 快捷操作入口
- **审计日志面板** — 查看系统操作记录
- **WebSocket 实时通信** — 冷启动进度、Guard 结果等实时推送

## 统计数据

- 19 个页面视图 + 4 个 Modal
- 22 个路由文件，142 个 HTTP API 端点