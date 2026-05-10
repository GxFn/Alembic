#!/usr/bin/env node

import { Command } from "commander";
import { readPackageInfo } from "../lib/codex/package-info.js";
import { buildDiagnostics, buildStatus } from "../lib/codex/tools.js";
import { initializeCodexWorkspace } from "../lib/codex/workspace.js";

const packageInfo = readPackageInfo();
const program = new Command();

program.name("alembic").description("Alembic Codex-first runtime").version(packageInfo.version);

const codex = program.command("codex").description("Codex plugin helper commands");

codex
  .command("diagnostics")
  .description("Run local Codex plugin diagnostics without starting the daemon")
  .option("--json", "Print JSON output")
  .action((options: { json?: boolean }) => {
    printResult(buildDiagnostics(), options.json);
  });

codex
  .command("status")
  .description("Inspect workspace status without starting the daemon")
  .option("--json", "Print JSON output")
  .action((options: { json?: boolean }) => {
    printResult(buildStatus(), options.json);
  });

codex
  .command("init")
  .description("Initialize this project for Alembic Codex in Ghost mode")
  .option("--force", "Overwrite setup artifacts")
  .option("--seed", "Create a seed candidate")
  .option("--standard", "Use project-local standard mode instead of Ghost mode")
  .option("--json", "Print JSON output")
  .action((options: { force?: boolean; json?: boolean; seed?: boolean; standard?: boolean }) => {
    const workspace = initializeCodexWorkspace(options);
    printResult(
      {
        initialized: workspace.initialized,
        workspace,
        message: workspace.ghost
          ? "Alembic Codex Ghost workspace initialized."
          : "Alembic standard workspace initialized.",
      },
      options.json,
    );
  });

program.parse();

function printResult(result: unknown, json?: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
