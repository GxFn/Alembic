# Dashboard

> AutoSnippet's visual management interface. Start with `asd ui`.
>
> [中文](dashboard.md)

## Tech Stack

- React 19.2 + TypeScript 5.9
- Vite 7.3
- Tailwind CSS 4.2 + Radix UI
- Socket.IO 4.8 (real-time communication)
- Mermaid 11.12 (chart rendering)

## Views

| View | Features |
|------|----------|
| **Recipes** | Browse / edit / delete, sort (name / authority / usage / date), Markdown editor + frontmatter visualization |
| **Candidates** | Dimension-grouped review, AI refinement preview/apply, batch publish, cold start |
| **Knowledge** | Full 6-state lifecycle management, batch operations, quality audit |
| **Guard** | Rule library (built-in + custom), violation tracking, ReverseGuard, compliance reports, import rules from Recipes |
| **Panorama** | Layer architecture visualization, module dependency graph, coverage heatmap, 11-dimension health radar, cycle detection, knowledge gaps |
| **Modules** | Multi-language build target browser, module dependency DAG |
| **Skills** | Built-in + project-level Skill management, AI auto-suggest |
| **Wiki** | Full/incremental Wiki generation, streaming progress, Markdown preview |
| **Signals** | Signal trace queries (type / time / source), report categories (governance / compliance / metrics) |
| **Knowledge Graph** | Recipe relationship graph visualization (Mermaid rendering) |
| **AI Chat** | Built-in AI conversation, SSE streaming |
| **LLM Config** | Multi-provider (OpenAI / Claude / Gemini / DeepSeek / Ollama), API key management, connection test |

## Global Features

- **Global Search** — Cmd+K to open, quick jump to any view
- **Command Palette** — Quick action entry point
- **Audit Log Panel** — View system operation records
- **WebSocket Real-time** — Cold start progress, Guard results and more pushed in real time

## Stats

- 19 page views + 4 modals
- 22 route files, 142 HTTP API endpoints