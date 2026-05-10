import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type MainlineImportKind,
  MainlineImportParser,
  MainlineImportPathResolver,
  type MainlineImportRecord,
  MainlineSourceFileScanner,
  MainlineSymbolTableBuilder,
} from "./index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("mainline code import parser", () => {
  it("extracts TS/JS import, export, require, and dynamic import records", () => {
    const records = new MainlineImportParser().parse(
      `
        import React, { useMemo, type FC as Component } from "react";
        import "./setup";
        export { Widget as PublicWidget } from "./widget";
        export * as tools from "./tools";
        const { join: joinPath } = require("node:path");
        const lazy = await import("./lazy");
      `,
      "typescript",
    );

    expect(records).toContainEqual(
      expect.objectContaining({
        path: "react",
        kind: "default",
        symbols: ["default"],
        alias: "React",
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        path: "react",
        kind: "named",
        symbols: ["FC"],
        alias: "Component",
        isTypeOnly: true,
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({ path: "./setup", kind: "side-effect" }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        path: "./widget",
        kind: "export",
        isExportOnly: true,
        exportedName: "PublicWidget",
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        path: "node:path",
        kind: "commonjs",
        symbols: ["join"],
        alias: "joinPath",
      }),
    );
    expect(records.filter((record) => record.path === "./lazy")).toHaveLength(1);
    expect(records).toContainEqual(
      expect.objectContaining({
        path: "./lazy",
        kind: "dynamic",
        alias: "lazy",
      }),
    );
  });
});

describe("mainline import path resolver", () => {
  it("resolves relative, tsconfig paths, baseUrl imports, and external packages", async () => {
    const root = await makeTempRoot();
    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: "src",
          paths: {
            "@app/*": ["*"],
          },
        },
      }),
    );

    const resolver = new MainlineImportPathResolver();
    const resolutions = resolver.resolveImports({
      projectRoot: root,
      knownFiles: [
        "src/components/Button.tsx",
        "src/utils/math.ts",
        "src/models/user.ts",
        "src/config.ts",
      ],
      fromPath: "src/components/Button.tsx",
      languageId: "typescript",
      importRecords: [
        importRecord("../utils/math"),
        importRecord("@app/models/user"),
        importRecord("config"),
        importRecord("react"),
      ],
    });

    expect(resolutions.map((resolution) => [resolution.importPath, resolution.status])).toEqual([
      ["../utils/math", "resolved"],
      ["@app/models/user", "resolved"],
      ["config", "resolved"],
      ["react", "external"],
    ]);
    expect(resolutions[0]?.resolvedPath).toBe("src/utils/math.ts");
    expect(resolutions[1]?.resolvedPath).toBe("src/models/user.ts");
    expect(resolutions[2]?.resolvedPath).toBe("src/config.ts");
    expect(resolutions[3]?.externalPackage).toBe("react");
  });
});

describe("mainline symbol table builder", () => {
  it("normalizes declarations and separates imports from re-exports", () => {
    const table = new MainlineSymbolTableBuilder().build({
      path: "src\\Widget.ts",
      languageId: "typescript",
      symbols: [
        { name: "Widget", kind: "class", startLine: 3, isExported: true },
        { name: "render", kind: "method", startLine: 8, containerName: "Widget" },
      ],
      imports: [
        importRecord("react", { kind: "named", symbols: ["useMemo"] }),
        importRecord("./widget", {
          kind: "export",
          isExportOnly: true,
          exportedName: "PublicWidget",
        }),
      ],
    });

    expect(table.declarations.get("src/Widget.ts::Widget")).toMatchObject({
      name: "Widget",
      kind: "class",
      file: "src/Widget.ts",
      line: 3,
      isExported: true,
    });
    expect(table.declarations.get("src/Widget.ts::Widget.render")).toMatchObject({
      name: "render",
      kind: "method",
      containerName: "Widget",
    });
    expect(table.fileImports.get("src/Widget.ts")).toEqual([
      expect.objectContaining({ path: "react" }),
    ]);
    expect(table.fileExports.get("src/Widget.ts")).toEqual(["PublicWidget", "Widget"]);
  });
});

describe("mainline source file scanner", () => {
  it("skips ignored directories and excludes tests unless requested", async () => {
    const root = await makeTempRoot();
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(root, "README.md"), "# Notes\n");
    await fs.writeFile(path.join(root, "src", "app.ts"), "export const app = true;\n");
    await fs.writeFile(path.join(root, "src", "app.test.ts"), "export const test = true;\n");
    await fs.writeFile(path.join(root, "node_modules", "pkg", "ignored.ts"), "export {};\n");

    const scanner = new MainlineSourceFileScanner();
    const result = await scanner.scan({ root, includeMarkdown: true });

    expect(result.files.map((file) => file.relativePath)).toEqual(["README.md", "src/app.ts"]);
    expect(result.languageCounts).toEqual({ typescript: 1 });
    expect(result.documentCounts).toEqual({ markdown: 1 });
    expect(result.profile.primary).toBe("typescript");

    const withTests = await scanner.scan({ root, includeMarkdown: true, includeTests: true });
    expect(withTests.files.map((file) => file.relativePath)).toEqual([
      "README.md",
      "src/app.test.ts",
      "src/app.ts",
    ]);
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-code-"));
  tempRoots.push(root);
  return root;
}

function importRecord(
  importPath: string,
  overrides: Partial<MainlineImportRecord> = {},
): MainlineImportRecord {
  const kind: MainlineImportKind = overrides.kind ?? "named";
  return {
    path: importPath,
    kind,
    symbols: [],
    alias: null,
    specifiers: [],
    isTypeOnly: false,
    isExportOnly: false,
    ...overrides,
  };
}
