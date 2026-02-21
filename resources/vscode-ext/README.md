# AutoSnippet VSCode Extension

Knowledge-driven code snippets — search, insert, create, and audit directly in your editor.

## Features

- **`// as:s <query>`** — Search knowledge base, pick result via QuickPick, insert code at trigger line
- **`// as:c`** — Create candidate from selection or clipboard
- **`// as:a`** — Audit current file with Guard rules
- **CodeLens** — Clickable action buttons above directives
- **Status Bar** — API Server connection indicator

## Requirements

AutoSnippet CLI must be installed and the API server running:

```bash
npm install -g autosnippet
cd your-project
asd ui   # starts API server + dashboard
```

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `autosnippet.serverPort` | `3000` | API server port |
| `autosnippet.serverHost` | `localhost` | API server host |
| `autosnippet.enableDirectiveDetection` | `true` | Auto-detect directives on save |
| `autosnippet.enableCodeLens` | `true` | Show CodeLens above directives |
| `autosnippet.insertHighlightDuration` | `2000` | Highlight duration (ms) |
