# CLI Reference

AutoSnippet's command-line tool is called `asd`, built on [commander](https://github.com/tj/commander.js).

```bash
npm install -g autosnippet
asd --help
```

---

## Command Overview

| Command | Description |
|---------|-------------|
| [`asd setup`](#asd-setup) | Initialize project workspace |
| [`asd coldstart`](#asd-coldstart) | Coldstart knowledge base |
| [`asd ais`](#asd-ais-target) | AI scan a target module |
| [`asd search`](#asd-search-query) | Search knowledge base |
| [`asd guard`](#asd-guard-file) | Run Guard rule checks |
| [`asd guard:ci`](#asd-guardci-path) | CI mode Guard check |
| [`asd guard:staged`](#asd-guardstaged) | Pre-commit Guard check |
| [`asd watch`](#asd-watch) | File watcher |
| [`asd server`](#asd-server) | Start API server |
| [`asd ui`](#asd-ui) | Start Dashboard |
| [`asd status`](#asd-status) | Check environment status |
| [`asd upgrade`](#asd-upgrade) | Upgrade IDE integrations |
| [`asd cursor-rules`](#asd-cursor-rules) | Generate Cursor delivery artifacts |
| [`asd sync`](#asd-sync) | Sync Markdown ↔ DB |

---

## asd setup

Initialize the project workspace. Creates directory structure, SQLite database, IDE integration configs (Cursor / VS Code / Trae / Qoder MCP configs), and template files.

```bash
asd setup [options]
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `-d, --dir <path>` | `.` | Project root directory |
| `--force` | `false` | Force re-initialization (overwrite existing configs) |
| `--seed` | `false` | Inject seed Recipes (quickstart examples) |

**Directory structure created:**

```
your-project/
├── AutoSnippet/
│   ├── recipes/         # Approved knowledge entries (Markdown)
│   ├── candidates/      # Pending review candidates
│   └── skills/          # Project-level Agent instructions
├── .autosnippet/
│   ├── autosnippet.db   # SQLite database
│   └── context/         # Vector index
├── .cursor/mcp.json     # Cursor MCP config
├── .vscode/mcp.json     # VS Code MCP config
└── .env                 # AI Provider config (template created if not exists)
```

---

## asd coldstart

Coldstart the knowledge base. Performs multi-dimensional analysis of project source code, uses AI to extract code patterns, and generates Candidate drafts for review.

```bash
asd coldstart [options]
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `-d, --dir <path>` | `.` | Project root directory |
| `-m, --max-files <n>` | `500` | Maximum files to scan |
| `--skip-guard` | `false` | Skip Guard rule generation |
| `--no-skills` | `false` | Don't generate Project Skills |
| `--wait` | `false` | Wait for all async tasks to complete before exiting |
| `--json` | `false` | JSON output format |

**Analysis dimensions (14 total, auto-activated by project language):**

Universal dimensions (all projects):
1. Code standards (code-standard)
2. Design patterns & code conventions (code-pattern)
3. Architecture patterns (architecture)
4. Best practices (best-practice)
5. Events & data flow (event-and-data-flow)
6. Project profile (project-profile)
7. Agent development guidelines (agent-guidelines)

Conditional dimensions (activated by language/framework):
8. ObjC/Swift deep scan (objc-deep-scan)
9. ObjC/Swift base class category methods (category-scan)
10. JS/TS module export analysis (module-export-scan)
11. JS/TS framework conventions (framework-convention-scan)
12. Python package structure (python-package-scan)
13. Java/Kotlin annotation scan (jvm-annotation-scan)
14. Go module structure (go-module-scan)

---

## asd ais [target]

AI scan a specific target (module/directory/file), extract code patterns, and generate Recipes.

```bash
asd ais [target] [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `target` | Target path (module directory or file), interactive selection if omitted |

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `-d, --dir <path>` | `.` | Project root directory |
| `-m, --max-files <n>` | `200` | Maximum files to scan |
| `--dry-run` | `false` | Analyze only, don't create Candidates |
| `--json` | `false` | JSON output format |

---

## asd search \<query\>

Search for Recipes and knowledge entries in the knowledge base.

```bash
asd search <query> [options]
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `-t, --type <type>` | `all` | Search type: `all` / `recipe` / `solution` / `rule` |
| `-m, --mode <mode>` | `keyword` | Search mode: `keyword` / `bm25` / `semantic` |
| `-l, --limit <n>` | `10` | Number of results to return |

**Search modes:**

| Mode | Mechanism | Use Case |
|------|-----------|----------|
| `keyword` | Exact keyword matching | Known exact terms |
| `bm25` | TF-IDF scoring | General text search |
| `semantic` | Vector semantic similarity | Fuzzy/conceptual queries |

---

## asd guard \<file\>

Run Guard rule checks on a file.

```bash
asd guard <file> [options]
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `-s, --scope <scope>` | `file` | Check scope: `file` / `target` / `project` |
| `--json` | `false` | JSON output format |

---

## asd guard:ci [path]

CI/CD mode full-project Guard check, designed for continuous integration pipelines.

```bash
asd guard:ci [path] [options]
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `--fail-on-error` | `true` | Non-zero exit code on error-level violations |
| `--fail-on-warning` | `false` | Non-zero exit code on warning-level violations |
| `--max-warnings <n>` | `20` | Maximum allowed warnings |
| `--report <format>` | `text` | Report format: `json` / `text` / `markdown` |
| `--output <file>` | — | Report output file path |
| `--min-score <n>` | `70` | Minimum compliance score (0-100) |
| `--max-files <n>` | `500` | Maximum files to check |

**Exit codes:**

| Code | Meaning |
|------|---------|
| `0` | Passed |
| `1` | Violations exceeded threshold |

---

## asd guard:staged

Check git staged files, suitable as a pre-commit hook.

```bash
asd guard:staged [options]
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `--fail-on-error` | `true` | Block commit on error-level violations |
| `--json` | `false` | JSON output format |

**Pre-commit setup:**

```bash
# .git/hooks/pre-commit
#!/bin/sh
asd guard:staged --fail-on-error
```

Or use the provided template: `templates/pre-commit-guard.sh`

---

## asd watch

Start file watcher mode. Automatically detects file changes, runs Guard rule checks, and processes directives.

```bash
asd watch [options]
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `-d, --dir <path>` | `.` | Project root directory |
| `-e, --ext <exts>` | — | File extensions to watch (comma-separated) |
| `--guard` | `true` | Enable real-time Guard checks |

**File directives detected:**

| Directive | Action |
|-----------|--------|
| `// as:s <query>` | Search knowledge base and insert matching Recipe |
| `// as:c` | Create a Candidate from surrounding code |
| `// as:a` | Run Guard audit on current file |

---

## asd server

Start the HTTP API server (without Dashboard frontend).

```bash
asd server [options]
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `-p, --port <port>` | `3000` | Listen port |
| `-H, --host <host>` | `127.0.0.1` | Listen address |

---

## asd ui

Start the Dashboard UI, including both API server and frontend.

```bash
asd ui [options]
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `-p, --port <port>` | `3000` | Listen port |
| `-b, --browser` | — | Specify browser to open |
| `--no-open` | `false` | Don't auto-open browser |
| `-d, --dir <directory>` | `.` | Project root directory |
| `--api-only` | `false` | Start API only, no frontend |

---

## asd status

Check current environment status, including AI configuration, database connection, dependencies, etc.

```bash
asd status
```

Output includes:
- AI Provider status (configured / available models)
- Database connection status
- Knowledge base statistics (Recipes / Candidates count)
- IDE integration status

---

## asd upgrade

Upgrade IDE integration configs. Updates MCP configs, Skills, Cursor Rules, and Copilot Instructions to the latest version.

```bash
asd upgrade [options]
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `-d, --dir <path>` | `.` | Project root directory |
| `--skills-only` | `false` | Update Skills only |
| `--mcp-only` | `false` | Update MCP configs only |

---

## asd cursor-rules

Generate Cursor 4-channel delivery artifacts (Rules files, Skills definitions, Token budget planning, Topic classification).

```bash
asd cursor-rules [options]
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `-d, --dir <path>` | `.` | Project root directory |
| `--verbose` | `false` | Verbose output |

---

## asd sync

Incrementally sync `AutoSnippet/recipes/*.md` and `AutoSnippet/candidates/*.md` to the SQLite database.

```bash
asd sync [options]
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `-d, --dir <path>` | `.` | Project root directory |
| `--dry-run` | `false` | Check only, don't execute sync |
| `--force` | `false` | Force full sync (ignore incremental detection) |

**Use cases:**

- Syncing to DB after manually editing Recipe Markdown files
- Rebuilding after database corruption
- Syncing after pulling new Recipe files from Git

---

## Environment Variables

CLI commands read environment variables from the `.env` file in the project root:

```env
# AI Provider (configure at least one; multiple keys enable auto-fallback)
ASD_GOOGLE_API_KEY=...
ASD_OPENAI_API_KEY=...
ASD_CLAUDE_API_KEY=...
ASD_DEEPSEEK_API_KEY=...

# Local model
ASD_AI_PROVIDER=ollama
ASD_AI_MODEL=llama3

# Server
ASD_PORT=3000
ASD_HOST=127.0.0.1
```

---

## npm Scripts

Developers can invoke CLI via npm scripts:

```bash
npm run cli -- <command>        # Equivalent to asd <command>
npm run dashboard               # Equivalent to asd ui
npm run mcp                     # Start MCP server
npm run dev:link                # Global-link development version
npm run dev:verify              # Verify global installation
npm run test                    # Run tests
npm run test:unit               # Unit tests only
npm run test:integration        # Integration tests only
npm run test:coverage           # Tests with coverage
```
