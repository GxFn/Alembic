# Dashboard Release Artifacts

Alembic main owns the release staging package, while Dashboard source remains in
the `AlembicDashboard` repository. Release staging must therefore prove that
`dashboard/dist` was built from the current Dashboard source before it is copied
into `.release/alembic-ai`.

## Gate Flow

1. `npm run release:staging:prepare` runs `npm run build:dashboard` by default.
2. `scripts/build-dashboard.mjs` resolves Dashboard source through the shared
   workspace-source helper: local `../AlembicDashboard` first, then
   `vendor/AlembicDashboard`.
3. The build output is copied to `dashboard/dist`.
4. `dashboard/dist/alembic-dashboard-source.json` records Dashboard source kind,
   display path, package version, git commit, dirty state, and a source
   fingerprint.
5. Release staging copies `dashboard/dist` and verifies the copied metadata
   against the current Dashboard source and `alembic-release-source.json`.

`--skip-dashboard-build` exists only for stale-detection demos or local
debugging. The normal staging path does not skip the Dashboard build.

## Stale Detection

The stale gate fails when any of these are true:

- `dashboard/dist/index.html` is missing.
- `dashboard/dist/alembic-dashboard-source.json` is missing.
- The metadata source kind, display path, package version, commit, or source
  fingerprint differs from the currently resolved Dashboard source.
- The copied staging metadata differs from `alembic-release-source.json`.

This catches both old commits and uncommitted Dashboard source changes because
the fingerprint is computed from tracked and untracked Dashboard source files,
excluding generated `dist/`, `node_modules/`, and `.git/`.

## Vendor Refresh Boundary

Keep `vendor/AlembicDashboard` as the fallback/submodule boundary. Refresh it
only when a release or portable validation explicitly needs the vendor source:

1. Land and verify the Dashboard source change in `AlembicDashboard`.
2. Update the vendor submodule pointer in Alembic main.
3. Run `npm ci --prefix vendor/AlembicDashboard` if the vendor checkout needs
   dependencies for an offline build.
4. Run `npm run build:dashboard`.
5. Run `npm run release:staging:pack` and `npm run release:package-guard`.

Do not edit Dashboard frontend source inside Alembic main. Main owns only the
copied release artifact, release metadata, and staging gate.

## AO4 Coverage Gate

`npm run test:coverage` is the fast AO4 blocking coverage gate. It keeps the
existing global threshold values at branches 75, functions 75, lines 80, and
statements 80, and applies them to the owned gate-floor surface covered by the
AO4 suites: request validation, auth route behavior, and ProjectScope registry
resolution.

`npm run test:coverage:all` remains the broad Alembic `lib/**/*.ts` census. On
2026-06-12, enabling the missing Vitest coverage provider exposed the current
whole-library baseline at lines 50.82, statements 50.84, branches 43.81, and
functions 60.13. That command is evidence for AO5 census review, not the AO4
blocking floor.
