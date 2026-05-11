import { describe, expect, it } from "vitest";
import {
  CallGraphAnalyzer,
  CallSiteExtractor,
  ImportPathResolver,
  SymbolTableBuilder,
} from "./analysis/index.js";
import type { EngineeringCodeAstSummaryInput } from "./types.js";

const analysisSummary: EngineeringCodeAstSummaryInput = {
  fileSummaries: [
    {
      file: "src/UserService.ts",
      lang: "typescript",
      imports: [
        { path: "./repo", symbols: ["UserRepository"] },
        { path: "@api/client", symbols: ["fetchUser"] },
      ],
      classes: [
        {
          name: "UserService",
          methods: [{ name: "sync", line: 8 }],
          properties: [{ name: "repo", type: "UserRepository", line: 4 }],
        },
      ],
      callSites: [
        {
          callee: "fetchUser",
          callerClass: "UserService",
          callerMethod: "sync",
          callType: "function",
          argCount: 1,
          line: 9,
        },
        {
          callee: "save",
          callerClass: "UserService",
          callerMethod: "sync",
          callType: "method",
          receiver: "this.repo",
          argCount: 1,
          line: 10,
        },
      ],
    },
    {
      file: "src/repo.ts",
      lang: "typescript",
      exports: ["UserRepository"],
      classes: [{ name: "UserRepository", methods: [{ name: "save", line: 3 }] }],
    },
    {
      file: "src/api/client.ts",
      lang: "typescript",
      exports: ["fetchUser"],
      methods: [{ name: "fetchUser", line: 1 }],
    },
    {
      file: "Sources/App/Screen.swift",
      lang: "swift",
      protocols: [{ name: "Renderable", requiredMethods: [{ name: "render", line: 2 }] }],
      classes: [
        { name: "BaseScreen", methods: [{ name: "display", line: 8 }] },
        { name: "HomeScreen", superclass: "BaseScreen", methods: [{ name: "display", line: 14 }] },
        { name: "CardView", protocols: ["Renderable"], methods: [{ name: "render", line: 22 }] },
        {
          name: "ScreenCoordinator",
          methods: [{ name: "show", line: 30 }],
        },
      ],
      callSites: [
        {
          callee: "HomeScreen",
          callerClass: "ScreenCoordinator",
          callerMethod: "show",
          callType: "constructor",
          receiverType: "HomeScreen",
          line: 31,
        },
        {
          callee: "display",
          callerClass: "ScreenCoordinator",
          callerMethod: "show",
          callType: "method",
          receiver: "screen",
          receiverType: "BaseScreen",
          line: 32,
        },
        {
          callee: "CardView",
          callerClass: "ScreenCoordinator",
          callerMethod: "show",
          callType: "constructor",
          receiverType: "CardView",
          line: 33,
        },
        {
          callee: "render",
          callerClass: "ScreenCoordinator",
          callerMethod: "show",
          callType: "method",
          receiver: "renderable",
          receiverType: "Renderable",
          line: 34,
        },
      ],
    },
    {
      file: "pkg/service.py",
      lang: "python",
      imports: [{ path: "pkg.repo", symbols: ["save_user"] }],
      methods: [{ name: "handle", line: 4 }],
      callSites: [
        {
          callee: "save_user",
          callerMethod: "handle",
          callType: "function",
          argCount: 1,
          line: 5,
        },
      ],
    },
    {
      file: "pkg/repo.py",
      lang: "python",
      methods: [{ name: "save_user", line: 1 }],
    },
    {
      file: "ObjC/LegacyClient.m",
      lang: "objective-c",
      classes: [{ name: "LegacyClient", methods: [{ name: "send", line: 7 }] }],
      callSites: [
        {
          callee: "post",
          callerClass: "LegacyClient",
          callerMethod: "send",
          callType: "method",
          receiver: "AFHTTPSessionManager",
          argCount: 1,
          line: 8,
        },
      ],
    },
  ],
};

describe("EngineeringCode analysis", () => {
  it("builds class, method, module, protocol, import, and property symbols from summaries", () => {
    const table = SymbolTableBuilder.build(analysisSummary);

    expect(table.declarations.get("src/UserService.ts::UserService")).toMatchObject({
      kind: "class",
      languageId: "typescript",
    });
    expect(table.declarations.get("src/UserService.ts::UserService.sync")).toMatchObject({
      kind: "method",
      className: "UserService",
    });
    expect(table.fileImports.get("src/UserService.ts")).toEqual([
      expect.objectContaining({ path: "./repo", symbols: ["UserRepository"] }),
      expect.objectContaining({ path: "@api/client", symbols: ["fetchUser"] }),
    ]);
    expect(table.propertyTypes.get("UserService")?.get("repo")).toBe("UserRepository");
    expect(table.inheritanceEdges).toContainEqual({
      from: "HomeScreen",
      to: "BaseScreen",
      type: "inherits",
    });
    expect(table.inheritanceEdges).toContainEqual({
      from: "CardView",
      to: "Renderable",
      type: "conforms",
    });
  });

  it("resolves local relative, tsconfig-like alias, python module, and external imports fail-soft", () => {
    const resolver = new ImportPathResolver({
      knownFiles: [
        "src/UserService.ts",
        "src/repo.ts",
        "src/api/client.ts",
        "pkg/service.py",
        "pkg/repo.py",
      ],
      pathHints: { baseUrl: "src", paths: { "@api/*": ["api/*"] } },
    });

    expect(resolver.resolve("./repo", "src/UserService.ts")).toMatchObject({
      status: "resolved",
      resolvedPath: "src/repo.ts",
    });
    expect(resolver.resolve("@api/client", "src/UserService.ts")).toMatchObject({
      status: "resolved",
      resolvedPath: "src/api/client.ts",
    });
    expect(resolver.resolve("pkg.repo", "pkg/service.py")).toMatchObject({
      status: "resolved",
      resolvedPath: "pkg/repo.py",
    });
    expect(resolver.resolve("react", "src/UserService.ts")).toMatchObject({
      status: "external",
      externalPackage: "react",
      resolvedPath: null,
    });
  });

  it("normalizes summary call sites and extracts lightweight text facts without tree-sitter runtime", () => {
    const callSites = CallSiteExtractor.extractFile({
      file: "src/TextFacts.ts",
      lang: "typescript",
      textFacts: [
        {
          text: "await client.fetchUser(id); const repo = new UserRepository(); repo.save(user)",
          callerClass: "TextFacts",
          callerMethod: "run",
          line: 12,
        },
      ],
    });

    expect(callSites).toEqual([
      expect.objectContaining({
        callee: "fetchUser",
        receiver: "client",
        isAwait: true,
        origin: "text-fact",
      }),
      expect.objectContaining({
        callee: "UserRepository",
        callType: "constructor",
        receiverType: "UserRepository",
      }),
      expect.objectContaining({
        callee: "save",
        receiver: "repo",
      }),
    ]);
  });

  it("resolves direct imports, class methods, inheritance overrides, protocol conformers, python calls, and unresolved externals", () => {
    const result = new CallGraphAnalyzer().analyze(analysisSummary, {
      pathHints: { baseUrl: "src", paths: { "@api/*": ["api/*"] } },
    });

    expect(result.callEdges).toContainEqual(
      expect.objectContaining({
        caller: "src/UserService.ts::UserService.sync",
        callee: "src/api/client.ts::fetchUser",
        tier: "import",
      }),
    );
    expect(result.callEdges).toContainEqual(
      expect.objectContaining({
        caller: "src/UserService.ts::UserService.sync",
        callee: "src/repo.ts::UserRepository.save",
        tier: "class-method",
      }),
    );
    expect(result.callEdges).toContainEqual(
      expect.objectContaining({
        caller: "Sources/App/Screen.swift::ScreenCoordinator.show",
        callee: "Sources/App/Screen.swift::HomeScreen.display",
        tier: "override",
      }),
    );
    expect(result.callEdges).toContainEqual(
      expect.objectContaining({
        caller: "Sources/App/Screen.swift::ScreenCoordinator.show",
        callee: "Sources/App/Screen.swift::CardView.render",
        tier: "protocol",
      }),
    );
    expect(result.callEdges).toContainEqual(
      expect.objectContaining({
        caller: "pkg/service.py::handle",
        callee: "pkg/repo.py::save_user",
        tier: "import",
      }),
    );
    expect(result.callEdges).toContainEqual(
      expect.objectContaining({
        caller: "ObjC/LegacyClient.m::LegacyClient.send",
        callee: "AFHTTPSessionManager.post",
        tier: "unresolved",
        targetFilePath: null,
      }),
    );
    expect(result.stats.unresolvedCallSites).toBe(1);
  });

  it("infers source, sink, transform/store-compatible data flow edges from resolved calls", () => {
    const result = new CallGraphAnalyzer().analyze(analysisSummary, {
      pathHints: { baseUrl: "src", paths: { "@api/*": ["api/*"] } },
    });

    expect(result.dataFlowEdges).toContainEqual(
      expect.objectContaining({
        from: "src/api/client.ts::fetchUser",
        to: "src/UserService.ts::UserService.sync",
        flowType: "source",
        direction: "backward",
      }),
    );
    expect(result.dataFlowEdges).toContainEqual(
      expect.objectContaining({
        from: "src/UserService.ts::UserService.sync",
        to: "src/repo.ts::UserRepository.save",
        flowType: "sink",
        direction: "forward",
      }),
    );
    expect(result.dataFlowEdges).toContainEqual(
      expect.objectContaining({
        from: "pkg/service.py::handle",
        to: "pkg/repo.py::save_user",
        flowType: "store",
        direction: "forward",
      }),
    );
  });
});
