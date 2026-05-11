import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry } from "../agent/tools/index.js";
import { CODEX_TOOLS } from "./tools.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const resourceActionToolName = /^[a-z]+(?:_[a-z]+)*\.[a-z]+(?:_[a-z]+)*$/;

describe("tool surface boundaries", () => {
  it("keeps Codex MCP tools out of the internal Agent registry", () => {
    const codexToolNames = CODEX_TOOLS.map((tool) => tool.name);
    const agentToolNames = createDefaultToolRegistry()
      .list()
      .map((tool) => tool.name);

    // Codex/MCP 是插件协议面；内部 Agent tools 是 runtime 执行面，二者不能共用命名空间。
    expect(codexToolNames.every((name) => name.startsWith("alembic_"))).toBe(true);
    expect(agentToolNames.every((name) => !name.startsWith("alembic_"))).toBe(true);
    expect(intersection(codexToolNames, agentToolNames)).toEqual([]);
    expect(agentToolNames).not.toEqual(expect.arrayContaining(codexToolNames));
  });

  it("keeps Agent resource.action tools off the Codex MCP surface", () => {
    const codexToolNames = CODEX_TOOLS.map((tool) => tool.name);
    const agentToolNames = createDefaultToolRegistry()
      .list()
      .map((tool) => tool.name);

    // Agent tools 用 resource.action 标识给内部 runtime 路由；插件 tools 用 alembic_* 标识给 MCP 暴露。
    expect(agentToolNames.every((name) => resourceActionToolName.test(name))).toBe(true);
    expect(codexToolNames.every((name) => !resourceActionToolName.test(name))).toBe(true);
    expect(codexToolNames).not.toEqual(expect.arrayContaining(agentToolNames));
  });

  it("keeps Codex public tool implementations away from internal Agent tools", () => {
    const codexToolImports = codexProductionFiles().flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => ({
        file: relative(repoRoot, file),
        specifier: match[1],
      }));
    });

    // Codex public tools 只能读 mainline read models；internal Agent tools 留在 lib/agent/tools。
    for (const { file, specifier } of codexToolImports) {
      expect({ file, specifier }).not.toMatchObject({
        specifier: expect.stringMatching(/(?:\.\.\/)*agent\/tools/),
      });
      expect({ file, specifier }).not.toMatchObject({
        specifier: expect.stringContaining("lib/agent/tools"),
      });
    }
  });

  it("exports internal Agent tools only from lib/agent/tools", () => {
    expect(existsSync(join(repoRoot, "lib/tools"))).toBe(false);

    const agentIndex = readFileSync(join(repoRoot, "lib/agent/index.ts"), "utf8");
    expect(agentIndex).not.toContain("./tools/index.js");
  });

  it("keeps runtime imports pointed at the internal Agent tools namespace", () => {
    const runtimeDir = join(repoRoot, "lib/agent/runtime");
    const runtimeImports = readdirSync(runtimeDir)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .flatMap((file) => {
        const source = readFileSync(join(runtimeDir, file), "utf8");
        return [...source.matchAll(/from\s+["']([^"']*tools[^"']*)["']/g)].map((match) => ({
          file,
          specifier: match[1],
        }));
      });

    expect(runtimeImports.length).toBeGreaterThan(0);
    expect(runtimeImports).toEqual(
      runtimeImports.map((entry) => ({ ...entry, specifier: "../tools/index.js" })),
    );
  });
});

function intersection(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value)).sort();
}

function codexProductionFiles(): string[] {
  const codexDir = join(repoRoot, "lib", "codex");
  return readdirSync(codexDir)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => join(codexDir, file));
}
