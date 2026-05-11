import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigWatcher,
  CustomConfigDiscoverer,
  createDefaultDiscovererRegistry,
  DartDiscoverer,
  detectConflict,
  GoDiscoverer,
  JvmDiscoverer,
  NodeDiscoverer,
  PythonDiscoverer,
  RustDiscoverer,
  SpmDiscoverer,
} from "./index.js";

describe("engineering discovery", () => {
  it("registers discoverers in the legacy order and exposes conflict analysis", async () => {
    const registry = createDefaultDiscovererRegistry();
    expect(registry.getAll().map((discoverer) => discoverer.id)).toEqual([
      "spm",
      "node",
      "python",
      "jvm",
      "go",
      "dart",
      "rust",
      "customConfig",
      "generic",
    ]);

    const conflict = detectConflict([
      { discovererId: "node", displayName: "Node", confidence: 0.9 },
      { discovererId: "jvm", displayName: "JVM", confidence: 0.85 },
    ]);
    expect(conflict).toMatchObject({ ambiguous: true, recommended: { discovererId: "node" } });
  });

  it("discovers SPM Package.swift targets, files, and dependencies", async () => {
    const root = await fixture({
      "Package.swift": [
        'let package = Package(name: "Demo",',
        '  products: [.library(name: "Demo", targets: ["Core"])],',
        '  dependencies: [.package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.0.0")],',
        '  targets: [.target(name: "Core", dependencies: ["Utils"]), .testTarget(name: "CoreTests", dependencies: ["Core"])])',
      ].join("\n"),
      "Sources/Core/Core.swift": "public struct Core {}",
    });
    const discoverer = new SpmDiscoverer();
    await discoverer.load(root);
    expect((await discoverer.detect(root)).confidence).toBeGreaterThan(0.9);
    expect(await discoverer.listTargets()).toContainEqual(
      expect.objectContaining({ name: "Core", language: "swift" }),
    );
    expect(await discoverer.getTargetFiles("Core")).toContainEqual(
      expect.objectContaining({ name: "Core.swift" }),
    );
    expect(await discoverer.getDependencyGraph()).toMatchObject({
      edges: expect.arrayContaining([
        expect.objectContaining({ from: "Core", to: "Utils", type: "depends_on" }),
      ]),
    });
  });

  it("aggregates Node workspaces and Nx parser results", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        name: "@demo/root",
        workspaces: ["packages/*", "apps/*"],
        dependencies: { react: "^19.0.0" },
      }),
      "nx.json": JSON.stringify({
        projects: { web: "apps/web", core: { root: "packages/core", tags: ["scope:core"] } },
      }),
      "apps/web/package.json": JSON.stringify({
        name: "@demo/web",
        dependencies: { "@demo/core": "workspace:*", next: "^16" },
      }),
      "apps/web/src/index.ts": "import '@demo/core';",
      "packages/core/package.json": JSON.stringify({ name: "@demo/core" }),
      "packages/core/src/index.ts": "export const core = true;",
    });
    const discoverer = new NodeDiscoverer();
    await discoverer.load(root);
    const targets = await discoverer.listTargets();
    expect(targets).toContainEqual(
      expect.objectContaining({ name: "@demo/web", framework: "nextjs" }),
    );
    expect(targets).toContainEqual(
      expect.objectContaining({ name: "core", path: path.join(root, "packages/core") }),
    );
    expect(await discoverer.getDependencyGraph()).toMatchObject({
      edges: expect.arrayContaining([
        expect.objectContaining({ from: "@demo/web", to: "@demo/core", type: "depends_on" }),
      ]),
    });
  });

  it("discovers Python pyproject/setup.cfg packages and requirements", async () => {
    const root = await fixture({
      "pyproject.toml": '[project]\nname = "demo-py"\ndependencies = ["fastapi>=0.1"]\n',
      "setup.cfg": "[metadata]\nname = demo-py\n",
      "src/demo/__init__.py": "",
      "src/demo/app.py": "print('hi')",
      "requirements.txt": "uvicorn>=0.20\n",
    });
    const discoverer = new PythonDiscoverer();
    await discoverer.load(root);
    expect(await discoverer.listTargets()).toContainEqual(
      expect.objectContaining({ name: "demo", framework: "fastapi" }),
    );
    expect(await discoverer.getTargetFiles("demo")).toContainEqual(
      expect.objectContaining({ name: "app.py" }),
    );
    expect(await discoverer.getDependencyGraph()).toMatchObject({
      edges: expect.arrayContaining([expect.objectContaining({ to: "uvicorn" })]),
    });
  });

  it("discovers JVM Gradle and Maven structures", async () => {
    const gradleRoot = await fixture({
      "settings.gradle.kts": 'rootProject.name = "Demo"\ninclude(":app", ":core")\n',
      "app/build.gradle.kts":
        'plugins { id("application") }\ndependencies { implementation(project(":core")) }\n',
      "app/src/main/kotlin/App.kt": "class App",
      "core/build.gradle.kts": 'plugins { id("java-library") }\n',
    });
    const gradle = new JvmDiscoverer();
    await gradle.load(gradleRoot);
    expect(await gradle.listTargets()).toContainEqual(
      expect.objectContaining({ name: "app", type: "app" }),
    );
    expect(await gradle.getDependencyGraph()).toMatchObject({
      edges: expect.arrayContaining([expect.objectContaining({ from: "app", to: "core" })]),
    });

    const mavenRoot = await fixture({
      "pom.xml":
        "<project><artifactId>parent</artifactId><modules><module>service</module></modules><dependencies><dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId></dependency></dependencies></project>",
      "service/pom.xml": "<project><artifactId>service</artifactId></project>",
    });
    const maven = new JvmDiscoverer();
    await maven.load(mavenRoot);
    expect(await maven.listTargets()).toContainEqual(
      expect.objectContaining({
        name: "service",
        metadata: expect.objectContaining({ buildSystem: "maven" }),
      }),
    );
  });

  it("discovers Go modules, cmd targets, dependencies, and internal imports", async () => {
    const root = await fixture({
      "go.mod": "module example.com/demo\nrequire github.com/gin-gonic/gin v1.9.0\n",
      "cmd/api/main.go": 'package main\nimport "example.com/demo/internal/service"\n',
      "internal/service/service.go": "package service\n",
    });
    const discoverer = new GoDiscoverer();
    await discoverer.load(root);
    expect(await discoverer.listTargets()).toContainEqual(
      expect.objectContaining({ name: "cmd/api", type: "application" }),
    );
    expect(await discoverer.getDependencyGraph()).toMatchObject({
      edges: expect.arrayContaining([
        expect.objectContaining({ from: "demo", to: "gin", type: "dependency" }),
        expect.objectContaining({ from: "cmd/api", to: "internal/service", type: "internal" }),
      ]),
    });
  });

  it("discovers Dart pubspec/melos packages and dependencies", async () => {
    const root = await fixture({
      "pubspec.yaml":
        "name: demo_dart\ndependencies:\n  http: ^1.0.0\n  flutter:\n    sdk: flutter\n",
      "melos.yaml": "name: workspace\npackages:\n  - packages/*\n",
      "lib/src/main.dart": "library main;",
      "packages/core/pubspec.yaml": "name: core\n",
      "packages/core/lib/core.dart": "library core;",
    });
    const discoverer = new DartDiscoverer();
    await discoverer.load(root);
    expect(await discoverer.listTargets()).toContainEqual(
      expect.objectContaining({ name: "packages/core" }),
    );
    expect(await discoverer.getDependencyGraph()).toMatchObject({
      edges: expect.arrayContaining([expect.objectContaining({ from: "demo_dart", to: "http" })]),
    });
  });

  it("discovers Rust Cargo workspaces and dependencies", async () => {
    const root = await fixture({
      "Cargo.toml":
        '[workspace]\nmembers = ["crates/*"]\n[package]\nname = "demo"\nedition = "2021"\n[dependencies]\nserde = "1"\n',
      "src/lib.rs": "pub mod api;",
      "src/api/mod.rs": "pub fn api() {}",
      "crates/core/Cargo.toml": '[package]\nname = "core"\nedition = "2021"\n',
      "crates/core/src/lib.rs": "pub fn core() {}",
    });
    const discoverer = new RustDiscoverer();
    await discoverer.load(root);
    expect(await discoverer.listTargets()).toContainEqual(
      expect.objectContaining({
        name: "core",
        metadata: expect.objectContaining({ isWorkspaceMember: true }),
      }),
    );
    expect(await discoverer.getDependencyGraph()).toMatchObject({
      edges: expect.arrayContaining([expect.objectContaining({ from: "demo", to: "serde" })]),
    });
  });

  it("falls back to generic directory scanning", async () => {
    const root = await fixture({ "src/main.rb": "puts 'hi'" });
    const registry = createDefaultDiscovererRegistry();
    const discoverer = await registry.detect(root);
    expect(discoverer.id).toBe("generic");
    await discoverer.load(root);
    expect(await discoverer.listTargets()).toContainEqual(
      expect.objectContaining({ name: "src", language: "ruby" }),
    );
  });

  it("discovers EasyBox modules with Boxfile.local overrides and spec dependencies", async () => {
    const root = await fixture({
      Boxfile: [
        "host_app 'DemoApp', '1.0.0'",
        "layer 'Foundation' do",
        "  box 'Core', '~> 1.0'",
        "end",
        "layer 'Feature' do",
        "  access 'Foundation'",
        "  box 'Feature', :path => 'LocalModule/Feature'",
        "end",
      ].join("\n"),
      "Boxfile.local": [
        "layer 'Foundation' do",
        "  box 'Core', :path => 'LocalModule/Core'",
        "end",
      ].join("\n"),
      "LocalModule/Core/Core.boxspec": [
        "s.name = 'Core'",
        "s.source_files = 'Sources/**/*.{h,m}'",
      ].join("\n"),
      "LocalModule/Core/Sources/Core.m": "@implementation Core @end",
      "LocalModule/Feature/Feature.boxspec": [
        "s.name = 'Feature'",
        "s.source_files = 'Sources/**/*.swift'",
        "s.dependency 'Core'",
      ].join("\n"),
      "LocalModule/Feature/Sources/Feature.swift": "struct Feature {}",
    });
    const discoverer = new CustomConfigDiscoverer();
    await discoverer.load(root);

    expect(await discoverer.listTargets()).toContainEqual(
      expect.objectContaining({
        name: "Core",
        path: path.join(root, "LocalModule/Core"),
        metadata: expect.objectContaining({ layer: "Foundation", profileId: "easybox" }),
      }),
    );
    expect(await discoverer.getTargetFiles("Feature")).toContainEqual(
      expect.objectContaining({ name: "Feature.swift", targetName: "Feature" }),
    );
    expect(await discoverer.getDependencyGraph()).toMatchObject({
      layers: expect.arrayContaining([
        expect.objectContaining({ name: "Feature", accessibleLayers: ["Foundation"] }),
      ]),
      edges: expect.arrayContaining([
        expect.objectContaining({ from: "module:Feature", to: "module:Core", type: "depends_on" }),
      ]),
    });
  });

  it("discovers XcodeGen includes and keeps target graph metadata", async () => {
    const root = await fixture({
      "project.yml": [
        "name: Demo",
        "include:",
        "  - config/core.yml",
        "packages:",
        "  Alamofire:",
        "    url: https://github.com/Alamofire/Alamofire.git",
        "targets:",
        "  App:",
        "    type: application",
        "    sources:",
        "      - Sources/App",
        "    dependencies:",
        "      - target: Core",
      ].join("\n"),
      "config/core.yml": [
        "targets:",
        "  Core:",
        "    type: framework",
        "    sources:",
        "      - ../Sources/Core",
      ].join("\n"),
      "Sources/App/App.swift": "import Core",
      "Sources/Core/Core.swift": "public struct Core {}",
    });
    const discoverer = new CustomConfigDiscoverer();
    await discoverer.load(root);

    expect(await discoverer.listTargets()).toContainEqual(
      expect.objectContaining({ name: "Core", framework: "xcodegen" }),
    );
    expect(await discoverer.getDependencyGraph()).toMatchObject({
      edges: expect.arrayContaining([
        expect.objectContaining({ from: "project:Demo", to: "config/core.yml", type: "includes" }),
        expect.objectContaining({ from: "target:App", to: "target:Core", type: "target" }),
      ]),
    });
  });

  it("discovers Nx workspace project graph and tags", async () => {
    const root = await fixture({
      "nx.json": JSON.stringify({
        projects: { app: "apps/app", core: { root: "packages/core", tags: ["scope:core"] } },
      }),
      "apps/app/project.json": JSON.stringify({
        name: "app",
        root: "apps/app",
        projectType: "application",
        tags: ["scope:app"],
        implicitDependencies: ["core"],
      }),
      "packages/core/project.json": JSON.stringify({
        name: "core",
        root: "packages/core",
        projectType: "library",
        tags: ["scope:core"],
      }),
      "apps/app/src/main.ts": "import '@demo/core';",
      "packages/core/src/index.ts": "export const core = true;",
    });
    const discoverer = new CustomConfigDiscoverer();
    await discoverer.load(root);

    expect(await discoverer.listTargets()).toContainEqual(
      expect.objectContaining({ name: "app", type: "application" }),
    );
    expect(await discoverer.getDependencyGraph()).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: "module:app", tags: ["scope:app"] }),
      ]),
      edges: expect.arrayContaining([
        expect.objectContaining({ from: "module:app", to: "module:core", type: "depends_on" }),
      ]),
    });
  });

  it("discovers Gradle convention modules with configuration metadata", async () => {
    const root = await fixture({
      "settings.gradle.kts": 'rootProject.name = "Demo"\ninclude(":app", ":core:data")\n',
      "build-logic/convention/src/main/kotlin/AppConvention.kt": "class AppConvention",
      "app/build.gradle.kts": [
        'plugins { id("com.demo.feature") }',
        'dependencies { implementation(project(":core:data")) }',
      ].join("\n"),
      "core/data/build.gradle.kts": 'plugins { id("java-library") }\n',
      "app/src/main/kotlin/App.kt": "class App",
    });
    const discoverer = new CustomConfigDiscoverer();
    await discoverer.load(root);

    expect(await discoverer.listTargets()).toContainEqual(
      expect.objectContaining({
        name: "app",
        metadata: expect.objectContaining({ conventionRole: "feature" }),
      }),
    );
    expect(await discoverer.getDependencyGraph()).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: "module:app", conventionRole: "feature" }),
      ]),
      edges: expect.arrayContaining([
        expect.objectContaining({
          from: "module:app",
          to: "module:core:data",
          type: "depends_on",
          scope: "implementation",
          configuration: "implementation",
        }),
      ]),
    });
  });

  it("discovers CMake root and subdirectory targets", async () => {
    const root = await fixture({
      "CMakeLists.txt": [
        "project(Demo)",
        "add_subdirectory(src/lib)",
        "add_executable(app src/main.cpp)",
        "target_link_libraries(app PRIVATE core)",
      ].join("\n"),
      "src/lib/CMakeLists.txt": "add_library(core STATIC core.cpp)\n",
      "src/main.cpp": "int main() { return 0; }",
      "src/lib/core.cpp": "void core() {}",
    });
    const discoverer = new CustomConfigDiscoverer();
    await discoverer.load(root);

    expect(await discoverer.listTargets()).toContainEqual(
      expect.objectContaining({ name: "core", path: path.join(root, "src/lib") }),
    );
    expect(await discoverer.getDependencyGraph()).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: "module:src/lib", type: "cmake-subdirectory" }),
      ]),
      edges: expect.arrayContaining([
        expect.objectContaining({
          from: "target:app",
          to: "target:core",
          type: "target",
          scope: "PRIVATE",
        }),
      ]),
    });
  });

  it("diffs config watcher snapshots and reports profiles to rescan", () => {
    const diff = ConfigWatcher.diff(
      [
        { path: "Boxfile", fingerprint: "a" },
        { path: "LocalModule/Core/Core.boxspec", fingerprint: "b" },
        { path: "apps/app/project.json", fingerprint: "c" },
      ],
      [
        { path: "Boxfile", fingerprint: "a2" },
        { path: "LocalModule/Core/Core.boxspec", fingerprint: "b" },
        { path: "libs/core/project.json", fingerprint: "d" },
      ],
    );

    expect(diff.changed).toContainEqual(
      expect.objectContaining({ path: "Boxfile", kind: "changed", scope: "full" }),
    );
    expect(diff.removed).toContainEqual(
      expect.objectContaining({
        path: "apps/app/project.json",
        kind: "removed",
        scope: "module",
        moduleName: "app",
      }),
    );
    expect(diff.added).toContainEqual(
      expect.objectContaining({
        path: "libs/core/project.json",
        kind: "added",
        profileIds: expect.arrayContaining(["nx-monorepo"]),
      }),
    );
    expect(diff.rescanProfiles).toEqual(expect.arrayContaining(["easybox", "nx-monorepo"]));
  });
});

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "alembic-discovery-"));
  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const filePath = path.join(root, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    }),
  );
  return root;
}
