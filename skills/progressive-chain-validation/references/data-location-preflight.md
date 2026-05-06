# Data Location Preflight

`N0-data-location` is mandatory before validating any chain that may read or write Alembic runtime data, knowledge directories, database files, candidates, wiki output, or project skills.

## Required Facts

Record these fields in `evidence/N0-data-location.json`:

```json
{
  "targetProjectRoot": "/absolute/path/to/target-project",
  "projectRealpath": "/absolute/realpath/to/target-project",
  "isAlembicDevRepo": false,
  "isExcludedProject": false,
  "registryPath": "/Users/example/.asd/projects.json",
  "registered": true,
  "mode": "ghost",
  "ghost": true,
  "projectId": "project-id",
  "expectedProjectId": "project-id",
  "dataRoot": "/Users/example/.asd/workspaces/project-id",
  "dataRootSource": "ghost-registry",
  "workspaceExists": true,
  "ghostMarker": {
    "kind": "project-registry",
    "registryPath": "/Users/example/.asd/projects.json",
    "projectRoot": "/absolute/realpath/to/target-project",
    "projectId": "project-id"
  },
  "runtimeDir": "/Users/example/.asd/workspaces/project-id/.asd",
  "databasePath": "/Users/example/.asd/workspaces/project-id/.asd/alembic.db",
  "knowledgeBaseDir": "Alembic",
  "knowledgeDir": "/Users/example/.asd/workspaces/project-id/Alembic",
  "recipesDir": "/Users/example/.asd/workspaces/project-id/Alembic/recipes",
  "skillsDir": "/Users/example/.asd/workspaces/project-id/Alembic/skills",
  "candidatesDir": "/Users/example/.asd/workspaces/project-id/Alembic/candidates",
  "wikiDir": "/Users/example/.asd/workspaces/project-id/Alembic/wiki",
  "writeMode": "ghost",
  "requiresUserConfirmation": true
}
```

## Rules

- Store expanded absolute paths in structured evidence.
- Do not store `~`, `$HOME`, or relative paths as evidence values.
- `projectRoot` is the real source project used for code analysis.
- `dataRoot` is the root for runtime data and knowledge writes.
- `mode`, `dataRootSource`, and `ghostMarker` must come from `ProjectRegistry.inspect()` / `WorkspaceResolver.toFacts()`, not from project file type guessing.
- In Ghost mode, `dataRoot` must not equal `projectRoot`.
- If `targetProjectRoot` is the Alembic development repository, block user-runtime writes.
- Continue only after the path facts are clear and the write boundary is acceptable.

## Source Checks

When validating Alembic itself, derive the dev-repo facts from source markers before planning any runtime writes:

- `package.json` name is `alembic-ai`.
- `lib/bootstrap.ts` exists.
- `SOUL.md` exists.
- `isExcludedProject` would be true for the source repository.

For external projects, record the realpath and whether Ghost mode maps runtime data to a separate `dataRoot`.

## N0 Decision

- Pass when every path is absolute or explicitly `n/a`, and the write boundary is safe.
- Block when `dataRoot` equals an Alembic source repository for user-runtime writes.
- Block when the external project path is unknown or not approved for mutation.
- Continue with read-only source analysis if the node does not need runtime writes.
