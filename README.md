# Alembic

Alembic is the local knowledge system for a codebase. It scans source, builds a structured recipe knowledge base, runs Guard checks, serves a local Dashboard, and can use a configured AI provider for cold-start and rescan jobs.

This repository is the main `alembic-ai` package. It owns the CLI, daemon, HTTP API, Dashboard server, local runtime, package/release scripts, and Alembic internal AI flow.

Codex host-agent workflows live in `AlembicPlugin`. The main package does not install project editor files or maintain multi-host agent delivery paths.

## Install

```bash
npm install -g alembic-ai
```

For workspace development:

```bash
npm install
npm run build
npm run dev:link
```

`npm run dev:link` builds the local Core, Agent, Dashboard assets, and Alembic main package, then updates the global `alembic` command.

## Setup

Run setup from the project you want Alembic to manage:

```bash
alembic setup --ghost
```

`setup` initializes Alembic data and runtime state. It does not create or modify project editor configuration.

Useful next commands:

```bash
alembic ai status
alembic ai configure --provider openai --model gpt-5.4 --key-stdin
alembic coldstart --dir .
alembic rescan --dir .
alembic ui --dir .
```

## Two Lines

Alembic now has two explicit integration lines:

| Line | Owner | Purpose |
| --- | --- | --- |
| Codex host agent | `AlembicPlugin` | Codex reads briefing, analyzes the project, submits knowledge, and completes dimensions without requiring an Alembic AI provider first. |
| Alembic internal AI | `Alembic` + `AlembicAgent` | The installed `alembic` command uses a configured external AI provider to run cold-start, rescan, Guard, wiki, and knowledge management jobs. |

The two lines write into the same Alembic workspace data model, but their host responsibilities stay separate.

## Commands

```bash
alembic setup
alembic ai status
alembic ai configure
alembic daemon start
alembic daemon status
alembic coldstart
alembic rescan
alembic ais
alembic search
alembic guard
alembic guard:ci
alembic panorama
alembic server
alembic ui
alembic status
alembic health
alembic embed
alembic sync
```

## Runtime Layout

Standard mode stores data under the managed project:

```text
<project>/
├── .asd/
│   ├── config.json
│   ├── alembic.db
│   ├── context/
│   └── logs/
└── Alembic/
    ├── constitution.yaml
    ├── boxspec.json
    ├── recipes/
    ├── candidates/
    ├── skills/
    └── wiki/
```

Ghost mode stores the same data outside the project under the user-level Alembic workspace registry, keeping the managed project free of Alembic files.

## Development Checks

```bash
npm run build:check
npm run build
npm run dev:link -- --dry-run --verbose
npm run release:package-guard
npm run lint:agent-extraction-boundary
npm run lint:core-import-boundary
```

`npm run check` runs typecheck, lint, and boundary checks.
