#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { readPackageInfo } from "../lib/codex/package-info.js";
import { inspectWorkspace, resolveProjectRoot } from "../lib/codex/workspace.js";
import { startDaemonHttpBridge } from "../lib/daemon/DaemonHttpBridge.js";
import { clearDaemonState, writeDaemonState } from "../lib/daemon/DaemonState.js";
import { JsonDaemonJobStore } from "../lib/daemon/JobStore.js";

const projectRoot = resolveProjectRoot(process.env.ALEMBIC_PROJECT_DIR);
const workspace = inspectWorkspace(projectRoot);
if (!workspace.projectId) {
  throw new Error("Alembic workspace is not initialized. Run `alembic codex init` first.");
}

const info = readPackageInfo();
const startedAt = new Date().toISOString();
const initialState = {
  pid: process.pid,
  port: Number.parseInt(process.env.ALEMBIC_DAEMON_PORT ?? "0", 10) || 0,
  token: process.env.ALEMBIC_DAEMON_TOKEN ?? randomBytes(24).toString("hex"),
  projectRoot: workspace.projectRoot,
  dataRoot: process.env.ALEMBIC_DAEMON_DATA_ROOT ?? workspace.dataRoot,
  projectId: workspace.projectId,
  databasePath: workspace.databasePath,
  version: info.version,
  startedAt,
  updatedAt: startedAt,
};

const interruptedJobs = await new JsonDaemonJobStore(initialState.dataRoot).markInterrupted();
let currentState = initialState;
const bridge = await startDaemonHttpBridge({
  state: () => currentState,
  requestedPort: initialState.port,
});
const readyState = {
  ...initialState,
  port: bridge.port,
  updatedAt: new Date().toISOString(),
};
currentState = readyState;
await writeDaemonState(readyState);

process.stderr.write(
  `Alembic daemon ready on ${bridge.url}; interruptedJobs=${interruptedJobs.length}\n`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await shutdown();
  });
}

async function shutdown(): Promise<void> {
  await bridge.close();
  await clearDaemonState(readyState.dataRoot);
  process.exit(0);
}
