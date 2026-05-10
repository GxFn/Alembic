#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(repoRoot, "package.json");
const pluginRoot = path.join(repoRoot, "plugins", "alembic-codex");

const failures = [];
const warnings = [];

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    fail(`Could not read valid JSON at ${path.relative(repoRoot, filePath)}: ${error.message}`);
    return undefined;
  }
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}`);
  }
}

function expectPresent(value, label) {
  if (!value) {
    fail(`${label} is required`);
  }
}

function expectFile(filePath, label) {
  if (!existsSync(filePath)) {
    fail(`${label} is missing at ${path.relative(repoRoot, filePath)}`);
  }
}

const packageJson = await readJson(packagePath);

if (packageJson) {
  expectEqual(packageJson.name, "alembic-ai", "package name");
  expectEqual(packageJson.version, "0.1.0", "package version");
  expectEqual(packageJson.type, "module", "package type");
  expectEqual(packageJson.engines?.node, ">=22", "Node engine");
  expectEqual(packageJson.bin?.alembic, "./dist/bin/cli.js", "alembic bin target");
  expectEqual(
    packageJson.bin?.["alembic-codex-mcp"],
    "./dist/bin/codex-mcp.js",
    "alembic-codex-mcp bin target",
  );

  for (const scriptName of ["build", "typecheck", "test:unit", "verify:codex-plugin"]) {
    expectPresent(packageJson.scripts?.[scriptName], `script ${scriptName}`);
  }

  for (const dependencyName of ["@modelcontextprotocol/sdk", "commander", "zod"]) {
    expectPresent(packageJson.dependencies?.[dependencyName], `dependency ${dependencyName}`);
  }

  for (const devDependencyName of ["typescript", "vitest", "@biomejs/biome"]) {
    expectPresent(
      packageJson.devDependencies?.[devDependencyName],
      `dev dependency ${devDependencyName}`,
    );
  }
}

if (!existsSync(pluginRoot)) {
  warn("plugins/alembic-codex is not present yet; skipped plugin payload checks.");
} else {
  const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  const mcpPath = path.join(pluginRoot, ".mcp.json");

  expectFile(manifestPath, "Codex plugin manifest");
  expectFile(mcpPath, "Codex plugin MCP config");
  expectFile(path.join(pluginRoot, "README.md"), "Codex plugin README");

  const manifest = existsSync(manifestPath) ? await readJson(manifestPath) : undefined;
  if (manifest) {
    expectPresent(manifest.name, "Codex plugin manifest name");
    expectPresent(manifest.version, "Codex plugin manifest version");
  }

  const mcpConfig = existsSync(mcpPath) ? await readJson(mcpPath) : undefined;
  if (mcpConfig) {
    const serialized = JSON.stringify(mcpConfig);
    if (!serialized.includes("alembic-ai@0.1.0")) {
      fail(".mcp.json should pin the runtime package as alembic-ai@0.1.0");
    }
    if (!serialized.includes("alembic-codex-mcp")) {
      fail(".mcp.json should launch the alembic-codex-mcp binary");
    }
  }

  for (const skillName of [
    "alembic",
    "alembic-create",
    "alembic-devdocs",
    "alembic-guard",
    "alembic-recipes",
    "alembic-structure",
  ]) {
    expectFile(path.join(pluginRoot, "skills", skillName, "SKILL.md"), `skill ${skillName}`);
  }
}

for (const warning of warnings) {
  console.warn(`warn: ${warning}`);
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`error: ${failure}`);
  }
  process.exit(1);
}

console.log("Codex plugin package scaffold verified.");
