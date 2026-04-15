# Alembic VSCode Extension

Knowledge-driven code snippets — search, insert, create, and audit directly in your editor.

## Features

- **`// as:s <query>`** — Search knowledge base, pick result via QuickPick, insert code at trigger line
- **`// as:c`** — Create candidate from selection or clipboard
- **`// as:a`** — Audit current file with Guard rules
- **CodeLens** — Clickable action buttons above directives
- **Status Bar** — API Server connection indicator

## Requirements

Alembic CLI must be installed and the API server running:

```bash
npm install -g alembic-ai
cd your-project
asd ui   # starts API server + dashboard
```

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `asd.serverPort` | `3000` | API server port |
| `asd.serverHost` | `localhost` | API server host |
| `asd.enableDirectiveDetection` | `true` | Auto-detect directives on save |
| `asd.enableCodeLens` | `true` | Show CodeLens above directives |
| `asd.insertHighlightDuration` | `2000` | Highlight duration (ms) |
