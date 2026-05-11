import { describe, expect, it } from "vitest";
import { CallGraphAnalyzer } from "./analysis/index.js";
import { normalizeEngineeringCodeAstSummary } from "./ast/index.js";

describe("EngineeringCode AST facts normalizer", () => {
  it("normalizes TypeScript imports, calls, property types, and receiver types", () => {
    const normalized = normalizeEngineeringCodeAstSummary({
      file: "src/service.ts",
      lang: "ts",
      imports: [
        "import type DefaultClient, { UserRepository as Repo, User } from './repo';",
        "export { helper as publicHelper } from './helper';",
      ],
      classes: [{ name: "UserService", methods: [{ name: "sync" }] }],
      propertyTypes: { UserService: { repo: "UserRepository" } },
      receiverTypes: [{ receiver: "client", receiverType: "DefaultClient" }],
      textFacts: [
        {
          text: "await client.fetchUser(id); this.repo.save(user)",
          callerClass: "UserService",
          callerMethod: "sync",
          line: 10,
        },
      ],
    });
    const summary = normalized.fileSummaries[0];

    expect(summary?.languageId).toBe("typescript");
    expect(summary?.imports).toEqual([
      expect.objectContaining({
        path: "./repo",
        kind: "named",
        symbols: ["Repo", "User"],
        isTypeOnly: true,
      }),
      expect.objectContaining({
        path: "./helper",
        symbols: ["publicHelper"],
        isExportOnly: true,
      }),
    ]);
    expect(summary?.importFacts).toEqual(summary?.imports);
    expect(summary?.properties).toContainEqual(
      expect.objectContaining({ className: "UserService", name: "repo", type: "UserRepository" }),
    );
    expect(summary?.callSites).toEqual([
      expect.objectContaining({
        callee: "fetchUser",
        receiver: "client",
        receiverType: "DefaultClient",
        isAwait: true,
      }),
      expect.objectContaining({ callee: "save", receiver: "this.repo" }),
    ]);
  });

  it("normalizes Swift, ObjC, Python, Go, Rust, and Dart import facts", () => {
    const normalized = normalizeEngineeringCodeAstSummary([
      { file: "Sources/App.swift", imports: ["@testable import CoreKit"] },
      { file: "ObjC/Client.m", imports: ["#import <UIKit/UIKit.h>", "@class Foo, Bar;"] },
      { file: "pkg/service.py", imports: ["from pkg.repo import save_user as save, UserRepo"] },
      { file: "cmd/main.go", imports: ['import alias "github.com/acme/pkg"', '. "fmt"'] },
      { file: "src/lib.rs", imports: ["use crate::repo::{UserRepo, save_user as save};"] },
      { file: "lib/app.dart", imports: ["import 'package:app/repo.dart' as repo show UserRepo;"] },
    ]);

    expect(normalized.fileSummaries[0]?.imports).toContainEqual(
      expect.objectContaining({ path: "CoreKit", kind: "namespace", symbols: ["*"] }),
    );
    expect(normalized.fileSummaries[1]?.imports).toEqual([
      expect.objectContaining({ path: "UIKit/UIKit.h", kind: "header" }),
      expect.objectContaining({
        path: "(forward-declaration)",
        kind: "forward-declare",
        symbols: ["Foo", "Bar"],
      }),
    ]);
    expect(normalized.fileSummaries[2]?.imports).toContainEqual(
      expect.objectContaining({
        path: "pkg.repo",
        kind: "named",
        symbols: ["save_user", "UserRepo"],
      }),
    );
    expect(normalized.fileSummaries[3]?.imports).toEqual([
      expect.objectContaining({ path: "github.com/acme/pkg", alias: "alias" }),
      expect.objectContaining({ path: "fmt", kind: "named", symbols: ["*"] }),
    ]);
    expect(normalized.fileSummaries[4]?.imports).toContainEqual(
      expect.objectContaining({ path: "crate::repo", symbols: ["UserRepo", "save_user"] }),
    );
    expect(normalized.fileSummaries[5]?.imports).toContainEqual(
      expect.objectContaining({
        path: "package:app/repo.dart",
        alias: "repo",
        symbols: ["UserRepo"],
      }),
    );
  });

  it("normalizes raw call facts and lightweight tree-sitter-like nodes", () => {
    const normalized = normalizeEngineeringCodeAstSummary({
      file: "src/light.ts",
      languageId: "typescript",
      callSites: [
        {
          text: "repo.save(user)",
          callerClass: "LightService",
          callerMethod: "run",
          line: 8,
        },
      ],
      receiverTypes: { "LightService.run.repo": "UserRepository" },
      nodes: [
        {
          type: "import_statement",
          text: "import { UserRepository } from './repo'",
          startPosition: { row: 0, column: 0 },
        },
        {
          type: "new_expression",
          text: "new UserRepository()",
          startPosition: { row: 7, column: 10 },
        },
      ],
    });
    const summary = normalized.fileSummaries[0];

    expect(summary?.imports).toContainEqual(
      expect.objectContaining({ path: "./repo", symbols: ["UserRepository"] }),
    );
    expect(summary?.callSites).toContainEqual(
      expect.objectContaining({
        callee: "save",
        receiver: "repo",
        receiverType: "UserRepository",
      }),
    );
    expect(summary?.callSites).toContainEqual(
      expect.objectContaining({
        callee: "UserRepository",
        callType: "constructor",
        receiverType: "UserRepository",
      }),
    );
  });

  it("feeds normalized facts into CallGraphAnalyzer", () => {
    const normalized = normalizeEngineeringCodeAstSummary([
      {
        file: "src/service.ts",
        lang: "typescript",
        imports: ["import { UserRepository } from './repo';"],
        classes: [{ name: "UserService", methods: [{ name: "sync" }] }],
        propertyTypes: [{ className: "UserService", propertyName: "repo", type: "UserRepository" }],
        textFacts: [
          {
            text: "this.repo.save(user)",
            callerClass: "UserService",
            callerMethod: "sync",
            line: 6,
          },
        ],
      },
      {
        file: "src/repo.ts",
        lang: "typescript",
        exports: ["UserRepository"],
        classes: [{ name: "UserRepository", methods: [{ name: "save" }] }],
      },
    ]);

    const result = new CallGraphAnalyzer().analyze(normalized);

    expect(result.callEdges).toContainEqual(
      expect.objectContaining({
        caller: "src/service.ts::UserService.sync",
        callee: "src/repo.ts::UserRepository.save",
        tier: "class-method",
      }),
    );
    expect(result.symbolTable.propertyTypes.get("UserService")?.get("repo")).toBe("UserRepository");
  });
});
