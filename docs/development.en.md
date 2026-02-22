# Development Guide

Developer guide for AutoSnippet. Covers environment setup, project structure, coding standards, testing, and release workflow.

---

## Requirements

- **Node.js** ≥ 20
- **macOS** recommended (Xcode automation features require it; everything else is cross-platform)
- **Git**

## Quick Start

```bash
git clone https://github.com/GxFn/AutoSnippet.git
cd AutoSnippet
npm install

# Global-link development version
npm run dev:link

# Verify installation
npm run dev:verify    # → which asd && asd -v
```

---

## Project Structure

```
AutoSnippet/
├── bin/                    # Entry scripts
│   ├── cli.js              # CLI entry (asd command)
│   ├── mcp-server.js       # MCP stdio server
│   └── api-server.js       # HTTP API server
├── lib/                    # Core source (layered architecture)
│   ├── bootstrap.js        # Initialization bootstrap
│   ├── injection/          # DI container
│   ├── core/               # Core layer (AST/Gateway/Discovery/Enhancement/Constitution)
│   ├── domain/             # Domain layer (entities/value objects)
│   ├── repository/         # Repository layer (SQLite implementation)
│   ├── service/            # Service layer (15 sub-domains)
│   ├── infrastructure/     # Infrastructure layer (DB/Cache/Event/Log/Vector)
│   ├── external/           # External integrations (AI Provider/MCP Server)
│   ├── http/               # HTTP API layer (Express/routes/middleware)
│   ├── cli/                # CLI services (Setup/Sync/Scan/Upgrade)
│   ├── platform/           # Platform-specific (iOS/Xcode/SPM)
│   └── shared/             # Shared utilities (constants/errors/utils)
├── config/                 # Configuration files
├── dashboard/              # Frontend (React + TypeScript + Vite)
├── skills/                 # Agent Skill packages (20)
├── templates/              # Initialization templates
├── scripts/                # Development/deployment scripts
├── test/                   # Tests
├── resources/              # Resources (WASM grammars/native UI/VS Code extension)
├── docs/                   # Formal documentation (git-tracked)
├── docs/copilot/           # Dev temp docs (not git-tracked)
├── scratch/                # Temp test scripts (not git-tracked)
└── logs/                   # Runtime logs (not git-tracked)
```

### Layer Dependency Rules

```
Entry Points → Bootstrap → DI Container
                                ↓
              HTTP / MCP / CLI / Dashboard
                                ↓
                          Service Layer
                                ↓
                      Core + Domain Layer
                                ↓
                      Infrastructure Layer
                                ↓
                        External Layer
```

**Strict rule:** Upper layers can depend on lower layers, but not vice versa. Services cannot directly depend on HTTP; Core cannot depend on Services.

---

## Coding Standards

### Module System

- **ESM Only** — The entire project uses ES Modules (`import` / `export`)
- File extension `.js` (not `.mjs`)
- `package.json` is set to `"type": "module"`

### Code Style

- Uses [Biome](https://biomejs.dev/) for formatting and linting
- Config file: `biome.json`
- Run: `npx biome check .`

### Naming Conventions

| Type | Convention | Example |
|------|-----------|---------|
| File names | PascalCase | `KnowledgeService.js` |
| Class names | PascalCase | `class KnowledgeService` |
| Method names | camelCase | `findByQuery()` |
| Private methods | _ prefix | `_buildCommentMask()` |
| Constants | UPPER_SNAKE | `MAX_FILES` |
| Config keys | camelCase | `qualityGate.maxErrors` |

### DI Pattern

All services are registered and retrieved via `ServiceContainer`, never directly `new`'d:

```javascript
// Registration (in ServiceContainer.js)
this.register('knowledgeService', () => {
  return new KnowledgeService(
    this.get('knowledgeRepository'),
    this.get('auditLogger')
  );
});

// Usage
const service = container.get('knowledgeService');
```

### Error Handling

Extend `BaseError`:

```javascript
import { BaseError } from '../shared/errors/index.js';

class KnowledgeNotFound extends BaseError {
  constructor(id) {
    super(`Knowledge entry not found: ${id}`, 'KNOWLEDGE_NOT_FOUND', 404);
  }
}
```

---

## Testing

### Test Framework

- **Jest** (ESM mode, `--experimental-vm-modules`)
- Config file: `jest.config.js`

### Running Tests

```bash
npm test                    # Full suite
npm run test:unit           # Unit tests
npm run test:integration    # Integration tests
npm run test:coverage       # With coverage
```

### Test Structure

```
test/
├── setup.js                # Global test setup
├── fixtures/               # Test fixtures
│   ├── factory.js          # Test data factory
│   ├── real-project-bench.json
│   └── real-project-stats.json
├── unit/                   # Unit tests (20)
│   ├── AgentV8Enhancements.test.js
│   ├── AiProviderExtractJSON.test.js
│   ├── AuditLogger.test.js
│   ├── ConfigLoader.test.js
│   ├── Constitution.test.js
│   ├── ConstitutionValidator.test.js
│   ├── CursorDeliveryPipeline.test.js
│   ├── Errors.test.js
│   ├── Gateway.test.js
│   ├── KnowledgeAPI.test.js
│   ├── KnowledgeEntry.test.js
│   ├── KnowledgeFileWriter.test.js
│   ├── KnowledgeService.test.js
│   ├── PathGuard.test.js
│   ├── PermissionManager.test.js
│   ├── ProjectDataTools.test.js
│   ├── ReasoningLayer.test.js
│   ├── SearchEngine.test.js
│   ├── V10DomainBrain.test.js
│   └── VectorPipeline.test.js
└── integration/            # Integration tests (17)
    ├── DirectiveDetector.test.js
    ├── FullFlow.test.js
    ├── GatewayChain.test.js
    ├── GoSupport.test.js
    ├── GuardCheck.test.js
    ├── HttpApi.test.js
    ├── I18nLang.test.js
    ├── KnowledgeCRUD.test.js
    ├── ProbeResolver.test.js
    ├── RealProjectAst.test.js
    ├── RealProjectBootstrap.test.js
    ├── RealProjectDiscovery.test.js
    ├── RealProjectEnhancement.test.js
    ├── RealProjectLanguage.test.js
    ├── SearchPipeline.test.js
    ├── api-endpoints.test.js
    └── http-server.test.js
```

### Writing Tests

```javascript
import { jest } from '@jest/globals';
import { KnowledgeEntry } from '../../lib/domain/knowledge/KnowledgeEntry.js';

describe('KnowledgeEntry', () => {
  test('should create from valid data', () => {
    const entry = KnowledgeEntry.create({ title: 'Test', language: 'javascript' });
    expect(entry.title).toBe('Test');
  });
});
```

### Test Data Factory

`test/fixtures/factory.js` provides standardized test data generation:

```javascript
import { createTestKnowledge, createTestCandidate } from '../fixtures/factory.js';

const knowledge = createTestKnowledge({ title: 'Custom Title' });
```

---

## Dashboard Development

### Tech Stack

- React 18 + TypeScript
- Vite build
- Tailwind CSS
- Socket.IO (real-time communication)
- Dark mode support

### Development

```bash
cd dashboard
npm install
npm run dev           # Vite dev server (HMR)
```

### Build

```bash
npm run build:dashboard    # Or: cd dashboard && npm run build
```

Build output goes to `dashboard/dist/`, served as static files by `asd ui`'s Express server.

### Directory Structure

```
dashboard/src/
├── App.tsx                 # Main application
├── main.tsx
├── api.ts                  # API client
├── types.ts                # TypeScript types
├── components/
│   ├── Layout/             # Sidebar + Header
│   ├── Views/              # 17 page views
│   ├── Modals/             # Modal components
│   ├── Shared/             # Shared components (ChatPanel/CodeBlock/Markdown)
│   └── Charts/             # Chart components
├── hooks/                  # React Hooks
├── i18n/                   # Internationalization
├── lib/                    # Socket.IO client
├── theme/                  # Theme switching
└── styles/
```

---

## Script Utilities

The `scripts/` directory contains development and operations scripts:

| Script | Purpose |
|--------|---------|
| `postinstall-safe.js` | npm postinstall safe initialization |
| `build-native-ui.js` | macOS native UI compilation (Swift) |
| `setup-mcp-config.js` | Install MCP config to IDE |
| `install-cursor-skill.js` | Install Cursor Skills |
| `install-vscode-copilot.js` | Inject VS Code Copilot Instructions |
| `install-full.js` | Full installation (MCP + Skills + Copilot) |
| `init-db.js` | Initialize database |
| `diagnose-mcp.js` | MCP connection diagnostics |
| `release.js` | Release script (check / patch / minor / major) |
| `recipe-audit.js` | Recipe quality audit |
| `bench-real-projects.mjs` | Performance benchmarking |

---

## Release Workflow

### Version Check

```bash
npm run release:check      # Check release conditions
```

### Publish

```bash
npm run release:patch      # Patch version (x.x.+1)
npm run release:minor      # Minor version (x.+1.0)
npm run release:major      # Major version (+1.0.0)
```

`release.js` automatically:
1. Runs tests
2. Updates `package.json` version
3. Updates `CHANGELOG.md`
4. Git commit + tag
5. `npm publish`

### Dashboard Build

Dashboard must be built before publishing:

```bash
npm run build:dashboard    # Must run before npm publish
```

The `prepublishOnly` script auto-builds native UI (macOS), but Dashboard requires manual building.

---

## File Placement Conventions

| Directory | Purpose | Git Tracked |
|-----------|---------|-------------|
| `docs/` | Formal documentation | ✅ |
| `docs/copilot/` | Development temp docs | ❌ |
| `scratch/` | Temp test scripts | ❌ |
| `scripts/` | Formal scripts | ✅ |
| `logs/` | Runtime logs | ❌ |

---

## Important Development Notes

1. **Do not run asd user commands in this repo** (e.g., `asd setup`, `asd embed`) — this repo is AutoSnippet source code, not a user project
2. **To test asd commands** — first run `npm run dev:link` to deploy globally, then execute in a separate test project
3. **ESM compatibility** — All imports must include the `.js` extension
4. **DI registration** — New services must be registered in `ServiceContainer.js`
5. **Gateway Action** — New API operations must be registered in `GatewayActionRegistry`
6. **Testing** — Run `npm test` before committing
