# IDE Integration

AutoSnippet supports deep integration with multiple IDEs. The core protocol is MCP (Model Context Protocol), with additional VS Code extension and Xcode automation support.

---

## Supported IDEs

| IDE | Integration Method | Config File |
|-----|-------------------|-------------|
| **Cursor** | MCP Server + Cursor Rules + Agent Skills | `.cursor/mcp.json` + `.cursor/rules/` |
| **VS Code (Copilot)** | MCP Server + Copilot Instructions + Extension | `.vscode/mcp.json` + `.github/copilot-instructions.md` |
| **Trae** | MCP Server | MCP config |
| **Qoder** | MCP Server | MCP config |
| **Claude Code** | MCP Server | MCP config |
| **Xcode** | File Watcher + Snippet Sync | `asd watch` |

---

## One-Click Setup

```bash
asd setup          # Auto-detect installed IDEs, configure MCP
asd upgrade        # Update to the latest IDE configuration
```

`SetupService` auto-detects IDE installation paths:
- **macOS**: `/Applications/`, `~/Applications/`
- **Linux**: `/usr/share/code/`, `/usr/bin/`, `~/.local/bin/`
- **Windows**: `%LOCALAPPDATA%\Programs\*`

---

## Cursor Integration

### MCP Configuration

`asd setup` auto-generates `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "autosnippet": {
      "command": "node",
      "args": ["/usr/local/lib/node_modules/autosnippet/bin/mcp-server.js"],
      "env": {
        "ASD_PROJECT_ROOT": "/path/to/your-project"
      }
    }
  }
}
```

### Cursor Rules

`asd cursor-rules` generates 4-channel delivery materials:

1. **Rules Files** — Rule files under `.cursor/rules/`, containing Recipe summaries
2. **Agent Skills** — Project-level Skill definitions guiding AI behavior
3. **Token Budget** — Per-scenario token allocation (systemPrompt / history / recipes / userInput / buffer)
4. **Topic Clustering** — Automatically clusters Recipes by topic

### Skills Installation

```bash
npm run install:cursor-skill           # Install Skills
npm run install:cursor-skill:mcp       # Install Skills (MCP mode)
```

Skills directory structure:

```
skills/
├── autosnippet-create/       # Knowledge creation & submission
├── autosnippet-guard/        # Guard rule auditing
├── autosnippet-recipes/      # Recipe context retrieval
├── autosnippet-structure/    # Structure exploration & knowledge graph
├── autosnippet-devdocs/      # Developer documentation
└── [project-level skills]    # Project-level custom Skills
```

---

## VS Code (Copilot) Integration

### MCP Configuration

`asd setup` auto-generates `.vscode/mcp.json`:

```json
{
  "servers": {
    "autosnippet": {
      "command": "node",
      "args": ["/usr/local/lib/node_modules/autosnippet/bin/mcp-server.js"],
      "env": {
        "ASD_PROJECT_ROOT": "/path/to/your-project"
      }
    }
  }
}
```

### Copilot Instructions

`asd setup` and `asd upgrade` auto-generate `.github/copilot-instructions.md`, which includes:

- Project overview
- Knowledge base structure description
- Knowledge trichotomy (rule / pattern / fact)
- 6 mandatory rules
- 12 MCP tool quick reference
- Recipe structure highlights
- Recommended workflow

Installation command:

```bash
npm run install:vscode-copilot     # Generate Copilot Instructions
```

### VS Code Extension

`resources/vscode-ext/` contains VS Code extension source code, providing:

| Feature | Description |
|---------|-------------|
| **Status Bar** | Shows AutoSnippet connection status and knowledge base stats |
| **CodeLens** | Displays matching Recipes above code lines |
| **Directive Detection** | Auto-detects `as:s` / `as:c` / `as:a` directives on save |
| **Search Panel** | Quick search the knowledge base |
| **Guard on Save** | Auto-runs Guard checks on save |

**Project Scope**: The extension activates only when the workspace contains an AutoSnippet project (detects `AutoSnippet/` or `.autosnippet/` directory).

---

## Xcode Integration

### File Watcher

```bash
asd watch -d /path/to/ios-project --ext swift,m,h
```

Monitors Swift / ObjC file changes and automatically:
- Detects file directives (`// as:s` / `// as:c` / `// as:a`)
- Runs Guard rule checks
- Syncs code snippets to Xcode Snippets Library

### Snippet Sync

Generates Xcode code snippets from Recipes:

```
macOS: ~/Library/Developer/Xcode/UserData/CodeSnippets/
```

`SnippetFactory` generates `.codesnippet` files via `XcodeCodec`, including:
- Completion prefix
- Placeholders (`<#placeholder#>` format)
- Scope (class method / function body / top level)
- Language tag

### SPM Integration

`SpmService` and `ModuleService` support Swift Package Manager project structure analysis:
- Package.swift parsing
- Target / dependency graph
- Module boundary detection

---

## File Directives

Write directives in any source file; IDE extensions or `asd watch` process them automatically:

### as:s — Search and Insert

```javascript
// as:s network timeout handling
```

Searches the knowledge base for "network timeout handling" related Recipes and inserts the best matching code snippet below the directive.

### as:c — Create Candidate

```javascript
// as:c
function retryWithBackoff(fn, maxRetries = 3) {
  // ... valuable code pattern
}
```

Extracts the code block below the directive as a Candidate draft, pending review.

### as:a — Guard Audit

```javascript
// as:a
```

Runs Guard rule checks on the current file, displaying results in the IDE.

---

## MCP Diagnostics

If the IDE cannot connect to the MCP server:

```bash
# Diagnose MCP connection
npm run diagnose:mcp

# Manually test MCP server
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node bin/mcp-server.js
```

Common issues:

| Problem | Solution |
|---------|----------|
| MCP server fails to start | Verify Node.js ≥ 22, run `asd status` |
| Cannot find mcp-server.js | Run `npm install -g autosnippet` to reinstall |
| Permission error | Check API Key configuration in `.env` |
| IDE not detecting tools | Restart IDE, verify MCP config file path |
| Knowledge base is empty | Run `asd coldstart` to generate initial knowledge |

---

## Full Installation

Install all IDE integrations at once:

```bash
npm run install:full
```

Equivalent to:
1. `setup-mcp-config.js --editor vscode`
2. `setup-mcp-config.js --editor cursor`
3. `install-cursor-skill.js`
4. `install-vscode-copilot.js`

---

## Upgrading

```bash
# Update npm package
npm update -g autosnippet

# Update IDE configuration
asd upgrade

# Update Skills only
asd upgrade --skills-only

# Update MCP configuration only
asd upgrade --mcp-only
```
