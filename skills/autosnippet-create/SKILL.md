---
name: autosnippet-create
description: Guides the agent to submit module usage code (designed/written with Cursor) to the AutoSnippet web (Dashboard) so it is added to the knowledge base (Recipes). Use when the user or Cursor has finished writing usage code and wants to "提交到 web" or "加入知识库".
---

# AutoSnippet Create — Submit to Web, Add to AutoSnippet

> Self-check & Fallback: MCP 工具返回统一 JSON Envelope（{ success, errorCode?, message?, data?, meta }）。重操作前调用 `autosnippet_health`；失败时不在同一轮重试，转用静态上下文或缩小范围后再试。

This skill tells the agent how to **submit module usage code** (that Cursor has designed or the user has written) to the **AutoSnippet web (Dashboard)** so it is **added to the knowledge base (Recipes)**. For concepts (knowledge base, Recipe), use **autosnippet-concepts**. For looking up existing Recipes, use **autosnippet-recipes**.

## Instructions for the agent (read this first)

1. **Goal**: When you (Cursor) have **finished writing or refining** module usage code, or the user says "把这段提交到 web / 加入知识库", guide them to **submit that code to the Dashboard** so it becomes a **Recipe** in `AutoSnippet/recipes/`.
2. **Draft workflow**: Prefer **creating a draft folder** (e.g. `.autosnippet-drafts`), **one .md file per Recipe**, multiple draft files—**do not use one big file**. Call MCP **`autosnippet_submit_knowledge_batch`** with filePaths (the .md files in the draft folder) to submit to Candidates. **After submit, delete the draft folder** (use `deleteAfterSubmit: true` or run `rm -rf .autosnippet-drafts`). Single-item flow can use `_draft_recipe.md` and watch will auto-add to Candidates.
3. **When user asks for "candidates"**: Use MCP **`autosnippet_submit_knowledge_batch`** for structured items (title/summary/trigger/code/usageGuide); use **`autosnippet_submit_knowledge_batch`** for Markdown draft files (prefer draft folder + multiple files; delete draft folder after submit).
4. **One Recipe = one scenario**: If you are drafting content, **split** into multiple Recipes by scenario. Never combine multiple usage patterns into one Recipe file or one candidate.
5. **Recipe candidates can be intro-only**: Intro-only docs (no code block) can be submitted as candidates; after approval they become Recipes and **do not generate a Snippet**—used only for search and Guard context.
6. **MUST follow standard Recipe format**: Use the complete template from **autosnippet-concepts** skill. Include all required fields: frontmatter with `title`, `trigger`, `category` (one of 8 standard values), `language` (must be `swift` or `objectivec`), `summary_cn`, `summary_en`, `headers` (complete import statements), plus `## Snippet / Code Reference` and `## AI Context / Usage Guide` section.
   - **MCP 不再使用项目内 AI**: 外部 Agent 必须自行填写所有字段，包括 summary_en、usageGuide_en、headers 等。提交后检查返回值中的 `recipeReadyHints`，缺失字段需补全后重新提交。
   - **双语建议 (RECOMMENDED)**: 同时提供中英文版本——`summary_cn` + `summary_en` + `usageGuide` + `usageGuide_en`。英文提升检索、AI 理解和团队复用（token 增加仅约20-30%，收益高）。纯中文也可接受。
   - **Placeholders**: Prefer Xcode placeholders in snippets (e.g. `<#URL#>`, `<#Token#>`) and explain each placeholder in the Usage Guide.
   - **Usage Guide structure (强制格式要求)**: 
   * **MUST use structured format with clear section headings** (### heading name)：**NEVER put all content in one continuous line**
   * **MUST use newlines (`\n`) to separate sections and bullet points** — at least 2-3 newlines between major sections
   * **MUST use bullet lists (`-` or `*`)** for multi-item sections; avoid long paragraphs
   * Recommended sections (按需包含):
     - **什么时候用** (必填)：3～5 条适用场景，用 `-` 列表，每行一条
     - **何时不用** (推荐)：排除场景、易误用情况，用 `-` 列表
     - **使用步骤** (推荐)：1～3 步操作手册，用 `1.` `2.` `3.` 列表
     - **关键点** (推荐)：易错点、约束条件、版本限制，用 `-` 列表
     - **依赖与前置条件** (推荐)：模块、权限、最低版本，用 `-` 列表
     - **错误处理** (推荐)：常见失败场景、重试/降级策略
     - **性能与资源** (可选)：缓存、线程安全、内存
     - **安全与合规** (可选)：敏感信息、日志脱敏
     - **常见误用** (可选)：反例（❌）与规避方式（✅）
     - **最佳实践** (可选)：推荐做法、设计模式
     - **替代方案** (可选)：其他 Recipe 或方案对比
     - **相关 Recipe** (推荐)：关联 trigger 或补充模式
   * **BAD Example** (❌ 禁止这样写，AI生成会导致格式混乱)：`何时用：在需要…时；与…配合；或…时。关键点：…内部…；…支持…；…需…。`
   * **GOOD Example** (✅ 应该这样写，清晰的多行结构)：
     ```
     ### 何时用
     - App 启动时需持续监测网络状态
     - 在应用生命周期管理类中统一启停
     
     ### 关键点
     - 单例 sharedMonitor，线程安全
     - startMonitoring 开始，stopMonitoring 停止
     - 后台自动停止，前台自动恢复
     ```
   - See [templates/recipes-setup/README.md](../../templates/recipes-setup/README.md) for detailed format guide & examples.
7. **Auto-fill headers from project context**: Before submitting, **check `references/project-recipes-context.md`** (轻量索引) to find similar Recipes by title/trigger/category, then call MCP **`autosnippet_knowledge(operation=get, id)`** to get full content including headers. Copy the exact import format for `headers` field. If needed, call MCP **`autosnippet_search(mode=context)`** with the module name to find similar Recipes and extract their header patterns. This ensures consistency and correctness.
8. **Primary flow (MCP preferred)**: Code is ready → Agent writes to `_draft_recipe.md` or calls `autosnippet_submit_knowledge_batch` / `autosnippet_submit_knowledge_batch` → candidates appear in Dashboard Candidates → user reviews and approves → Recipe is added to the knowledge base.
9. **Alternative (Dashboard browser)**: Code is ready → user opens Dashboard (`asd ui` running) → **New Recipe** → **Use Copied Code** (paste the code) → AI fills title/summary/trigger/headers → **user reviews and approves** → saved to knowledge base.
10. **Alternative (in editor)**: User adds **`// as:create`** in the source file, copies the code, saves → **watch** (from `asd watch` or `asd ui`) auto-adds to Candidates → user opens Dashboard **Candidates** to review and save.
9. **Draft & clipboard auto-add**: When you write to **`_draft_recipe.md`** (project root) or user uses **`// as:create`** with clipboard content, **watch** automatically reads the draft/clipboard, adds it to **Candidates** (target `_draft` or `_watch`), and shows a **friendly prompt** (e.g. "已创建候选「xxx」，请在 Candidates 页审核" in notification and console). User only needs to open Dashboard **Candidates** to review and save — no manual copy-paste required.
10. **Multiple recipes**: Prefer **one .md file per Recipe** in a draft folder (e.g. `.autosnippet-drafts/`), call **`autosnippet_submit_knowledge_batch`** with the list of file paths, then **delete the draft folder** after submit. Do not use one big file for many Recipes.
11. **Project root** = directory with `AutoSnippet/AutoSnippet.boxspec.json`. All commands run from the project root.

---

## Submit to web (提交到 web) — main flow

**Scenario**: Cursor has just written or refined **module usage code** (e.g. how to use a network API, how to load WebView). The user wants to add it to the **knowledge base** via the **web (Dashboard)**.

### Step 1: Content is ready

- **Code scenario**: Usage code is in current file or clipboard. If not copied, prompt user to copy the code block you provide.
...rated a full Recipe (frontmatter, Snippet, Usage Guide), **prefer writing to draft file** `_draft_recipe.md` at project root. On save, **watch automatically reads the draft**, adds it to **Candidates** (target `_draft`), and shows a **friendly prompt** ("已创建候选「xxx」，请在 Candidates 页审核"). User opens Dashboard **Candidates** to review and save — no manual copy needed. Or output in copyable format in chat and guide user to copy → Dashboard → Use Copied Code → paste → review → save. **Do not write to `AutoSnippet/recipes/` or `AutoSnippet/snippets/`.**
- **Candidate output rule**: When the user asks for candidates, **do not create files under `AutoSnippet/`**. Use **`autosnippet_submit_knowledge_batch`** for structured items; use **`autosnippet_submit_knowledge_batch`** for draft .md files (prefer draft folder + multiple files; delete draft folder after submit).

### Step 2: Open the web (Dashboard) in browser

- **Preferred**: Run in terminal: `open "http://localhost:3000/?action=create&source=clipboard"` (macOS). This opens the browser to the New Recipe page.
- **Manual fallback**: User opens **`http://localhost:3000`** in browser (Dashboard 需已运行；若未运行，先执行 `asd ui`).

### Step 3: Submit via Dashboard

1. **Browser**: Run terminal command `open "http://localhost:3000/?action=create&source=clipboard"` (macOS) to open the browser.
2. **Draft file (preferred for Agent)**: Write full Recipe MD to `_draft_recipe.md` at project root → watch auto-adds to Candidates. Or call MCP **`autosnippet_submit_knowledge_batch`** with draft file paths.
3. **Manual fallback**: User opens **`http://localhost:3000`** in browser → **New Recipe** → **Use Copied Code** → paste.
3. Pasted code: **Full Recipe MD** (with `---` frontmatter, `## Snippet / Code Reference`, `## AI Context / Usage Guide`) is parsed directly, **no AI rewrite**. Plain code still goes through AI analysis and fill.
4. **User reviews and approves** — 人工审核 title/summary/category/trigger 及内容，确认无误后再保存。
5. User **saves** → Recipe is written to **`AutoSnippet/recipes/`** — i.e. **added to the knowledge base**.

### Step 4: Optional — refresh Cursor's project context

- After saving, the user can run **`asd install:cursor-skill`** in the project root to regenerate `references/project-recipes-context.md`（轻量索引）so Cursor's recipes skill has the latest index. This is optional and can be done later.

---

## Alternative: Copy then jump to Web (Xcode and Cursor)

**Option A — MCP Submit (Cursor 首选)**: After user confirms code, Agent calls **`autosnippet_submit_knowledge_batch`** (for .md drafts) or **`autosnippet_submit_knowledge_batch`** (for structured items) to submit directly to Candidates. User reviews in Dashboard.

**Option B — Browser (Dashboard)**: Run `open "http://localhost:3000/?action=create&source=clipboard"` to open Dashboard New Recipe page; page reads clipboard and fills.

**Option B — // as:create (Xcode / in-editor)**: User adds **`// as:create`**, copies code, saves file. Requires **`asd watch`** or **`asd ui`** running. If clipboard has content, watch **automatically adds to Candidates** and shows a **friendly prompt** ("已创建候选「xxx」，请在 Candidates 页审核"); user opens Dashboard **Candidates** to review and save. If no clipboard, watch opens Dashboard with path for manual paste.

---

## Other ways to add to knowledge base (via web)

| Way | When to use |
|-----|-------------|
| **New Recipe → Scan File** | Code is already in a project file; user enters relative path (e.g. `Sources/MyMod/Foo.m`) → Scan File → AI extracts → save in Dashboard. |
| **SPM Explorer** | Mine usage from an SPM Target: select Target → scan → review in Dashboard → save as Recipe (or Snippet + Recipe). |
| **Candidates** | Batch: run **`asd ais <Target>`** or **`asd ais --all`** → open Dashboard **Candidates** → approve items → saved to knowledge base. |

All of these **submit through the web (Dashboard)** and result in content in **`AutoSnippet/recipes/`** (and optionally Snippet). The main flow above (Use Copied Code) is for **code that Cursor has just written**.

**Friendly prompt (友好提示)**: When draft file or `// as:create` with clipboard is used, the system adds content to **Candidates** and shows: ① Console message "已创建候选「xxx」，请在 Candidates 页审核"; ② On macOS, a notification "已创建候选「xxx」，请在 Candidates 页审核". Tell the user: "内容已加入候选池，请打开 Dashboard 的 **Candidates** 页审核并保存即可。"

**When generating content**: If Agent has drafted Recipe or Snippet content, prefer writing to `_draft_recipe.md` so watch can auto-add to Candidates with friendly prompt. Or pass the full content to user for Dashboard submission.

**When full copy is difficult**: Long content in chat is hard to copy fully. Agent should **write to draft file** at project root: `_draft_recipe.md` (or `_draft_snippet.md`), outside AutoSnippet/. **Watch automatically reads the draft on save** and adds it to **Candidates** (target `_draft`), then shows a **friendly prompt** ("已创建候选「xxx」，请在 Candidates 页审核"). User opens Dashboard **Candidates** → review and save — no manual copy or Scan File needed. Optional: add `_draft_*.md` to `.gitignore`. Delete draft after save if desired.

**Multiple recipes in one draft**: To submit **several Recipes at once**, write them in one `_draft_recipe.md`. Each Recipe is a **complete block** starting with `---` (frontmatter). **Separate blocks with a blank line, then the next block starts with `---`**. Example structure:
```
---
title: Recipe A
trigger: @foo
...
---

## Snippet / Code Reference
```objc
code A
```

## AI Context / Usage Guide
usage A

---
title: Recipe B
...
---

## Snippet / Code Reference
...
```
Watch parses all such blocks and adds each as a separate candidate; prompt may say "已创建 N 条候选".

---

## Quick reference

| User / Cursor situation | Action |
|-------------------------|--------|
| "把这段提交到 web / 加入知识库" (code just written) | 1) 提示用户复制代码；2) 写入 `_draft_recipe.md` 或调用 **`autosnippet_submit_knowledge_batch`**；3) 若需 Dashboard，运行 `open "http://localhost:3000/?action=create&source=clipboard"`；4) 用户粘贴并保存。 |
| Agent 起草了 Recipe/Snippet 内容 | **Prefer**: Write to `_draft_recipe.md` (project root) → save → **watch 自动读取并加入候选池**，并给出友好提示 → 用户打开 Dashboard **Candidates** 审核并保存。无需手动复制。 |
| Code in current file, want to submit from editor | **MCP**：`autosnippet_submit_knowledge_batch`（写草稿 .md 后提交）。或 Add **`// as:create`**, copy, save；确保 **`asd watch`** / **`asd ui`** 运行；有剪贴板时自动加入候选并友好提示。 |
| Code already in a file (path known) | 打开 **`http://localhost:3000`** → New Recipe → enter path → **Scan File** → review → save. |
| Agent 起草内容无法完整复制 | Write to `_draft_recipe.md` → save → **watch 自动读取草稿、加入候选并友好提示** → 用户打开 **Candidates** 审核保存。 |
| Batch from Target | **`asd ais <Target>`** → 打开 **`http://localhost:3000`** → **Candidates** → approve. |

---

## MCP Tools (when Dashboard is running)

| Tool | Use |
|------|-----|
| `autosnippet_search(mode=context)` | On-demand semantic search of knowledge base; pass `query`, `limit?` |
| `autosnippet_submit_knowledge_batch` | Submit draft .md as candidates: prefer draft folder + multiple files (not one big file); supports intro-only docs (no code—no Snippet). Pass `filePaths`, optional `targetName`, `deleteAfterSubmit`. **Delete the draft folder after submit** (e.g. `deleteAfterSubmit: true` or `rm -rf .autosnippet-drafts`). |
| `autosnippet_submit_knowledge_batch` | Submit structured items (title, summary, trigger, language, code, usageGuide) for batch scan, etc. |
| `autosnippet_submit_knowledge` | Submit single structured candidate with full V3 fields. **严格前置校验**——缺少必要字段（title, language, content, kind, doClause, category, trigger, description, headers, usageGuide, knowledgeType, content.rationale）的提交将被直接拒绝，不入库。必须一次性提供所有字段。 |
| `autosnippet_save_document` | Save a development document (design doc, debug report, ADR) — only needs title + markdown. See **autosnippet-devdocs** skill. |

**Fallback when Dashboard not open**: Agent can always use `autosnippet_submit_knowledge_batch` or `autosnippet_submit_knowledge_batch` directly via MCP — no browser needed.

---

## Relation to other skills

- **autosnippet-concepts**: What the knowledge base and Recipe are; where they live.
- **autosnippet-recipes**: Read or search existing Recipe content; get project context.
- **autosnippet-structure**: Dependency structure (unrelated to submit flow).

```
