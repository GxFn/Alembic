import { describe, expect, it } from "vitest";
import {
  parseCMakeDiscoveryFile,
  parseGradleDiscoveryFile,
  parseJsonDiscoveryFile,
  parseRubyDiscoveryFile,
  parseStarlarkDiscoveryFile,
  parseYamlDiscoveryFile,
} from "./index.js";

describe("engineering discovery parsers", () => {
  it("parses EasyBox Boxfile layers and local module specs without mainline dependencies", () => {
    const boxfile = parseRubyDiscoveryFile({
      filePath: "Boxfile",
      content: [
        "source 'https://example.com/specs.git'",
        "host_app 'DemoApp', '1.2.3'",
        "layer 'Foundation' do",
        "  group 'CoreGroup' do",
        "    box 'Core', '~> 1.0', :path => 'LocalModule/Core'",
        "  end",
        "end",
        "layer 'Feature' do",
        "  access 'Foundation'",
        "  box 'Feature', path: 'LocalModule/Feature'",
        "end",
      ].join("\n"),
    });

    expect(boxfile.projects).toContainEqual(
      expect.objectContaining({ name: "DemoApp", version: "1.2.3" }),
    );
    expect(boxfile.layers.map((layer) => [layer.name, layer.accessibleLayers])).toEqual([
      ["Foundation", []],
      ["Feature", ["Foundation"]],
    ]);
    expect(boxfile.modules).toContainEqual(
      expect.objectContaining({
        name: "Core",
        path: "LocalModule/Core",
        layer: "Foundation",
        group: "CoreGroup",
      }),
    );
    expect(boxfile.packages).toContainEqual(
      expect.objectContaining({ name: "https://example.com/specs.git" }),
    );

    const boxspec = parseRubyDiscoveryFile({
      filePath: "LocalModule/Feature/Feature.boxspec",
      content: [
        "s.name = 'Feature'",
        "s.version = '2.0.0'",
        "s.source_files = ['Sources/**/*.m', 'Sources/**/*.h']",
        "s.resources = 'Resources/**/*'",
        "s.public_header_files = ['Sources/Public/**/*.h']",
        "s.ios.deployment_target = '13.0'",
        "s.dependency 'Core', '~> 1.0'",
      ].join("\n"),
    });

    expect(boxspec.modules).toContainEqual(
      expect.objectContaining({
        name: "Feature",
        version: "2.0.0",
        metadata: expect.objectContaining({
          sources: ["Sources/**/*.m", "Sources/**/*.h"],
          resources: ["Resources/**/*"],
          publicHeaders: ["Sources/Public/**/*.h"],
          deploymentTarget: "13.0",
        }),
      }),
    );
    expect(boxspec.dependencies).toContainEqual(
      expect.objectContaining({ from: "module:Feature", to: "module:Core", kind: "depends_on" }),
    );
  });

  it("parses XcodeGen target dependencies from YAML", () => {
    const parsed = parseYamlDiscoveryFile({
      filePath: "project.yml",
      content: [
        "name: Demo",
        "packages:",
        "  Alamofire:",
        "    url: https://github.com/Alamofire/Alamofire.git",
        "    from: 5.0.0",
        "targets:",
        "  App:",
        "    type: application",
        "    platform: iOS",
        "    sources:",
        "      - path: Sources/App",
        "    dependencies:",
        "      - target: Core",
        "      - package: Alamofire",
        "  Core:",
        "    type: framework",
        "    sources:",
        "      - Sources/Core",
      ].join("\n"),
    });

    expect(parsed.projects).toContainEqual(
      expect.objectContaining({ name: "Demo", type: "xcodegen" }),
    );
    expect(parsed.targets).toContainEqual(
      expect.objectContaining({ name: "App", layer: "App", path: "Sources/App" }),
    );
    expect(parsed.targets).toContainEqual(
      expect.objectContaining({ name: "Core", layer: "Framework" }),
    );
    expect(parsed.dependencies).toContainEqual(
      expect.objectContaining({ from: "target:App", to: "target:Core", kind: "target" }),
    );
    expect(parsed.dependencies).toContainEqual(
      expect.objectContaining({ from: "target:App", to: "package:Alamofire", kind: "package" }),
    );
  });

  it("parses Melos package globs from YAML", () => {
    const parsed = parseYamlDiscoveryFile({
      filePath: "melos.yaml",
      content: [
        "name: demo_workspace",
        "packages:",
        "  - packages/**",
        "  - apps/*",
        "scripts:",
        "  analyze: melos exec dart analyze",
      ].join("\n"),
    });

    expect(parsed.projects).toContainEqual(
      expect.objectContaining({ name: "demo_workspace", type: "melos" }),
    );
    expect(parsed.modules.map((module) => module.path)).toEqual(["apps/*", "packages/**"]);
    expect(parsed.dependencies).toContainEqual(
      expect.objectContaining({
        from: "project:demo_workspace",
        to: "module-glob:packages/**",
        kind: "workspace",
      }),
    );
  });

  it("parses Nx project dependencies from JSON", () => {
    const parsed = parseJsonDiscoveryFile({
      filePath: "apps/app/project.json",
      content: JSON.stringify({
        name: "app",
        root: "apps/app",
        sourceRoot: "apps/app/src",
        projectType: "application",
        tags: ["scope:app"],
        implicitDependencies: ["core"],
        targets: {
          build: {
            dependsOn: ["shared", "projects:ui"],
          },
        },
      }),
    });

    expect(parsed.modules).toContainEqual(
      expect.objectContaining({ name: "app", path: "apps/app" }),
    );
    expect(parsed.dependencies).toContainEqual(
      expect.objectContaining({ from: "module:app", to: "module:core", kind: "depends_on" }),
    );
    expect(parsed.dependencies).toContainEqual(
      expect.objectContaining({ from: "module:app", to: "module:ui", kind: "depends_on" }),
    );
  });

  it("parses tsconfig references and package workspaces from JSON", () => {
    const packageJson = parseJsonDiscoveryFile({
      filePath: "package.json",
      content: JSON.stringify({
        name: "@demo/root",
        private: true,
        workspaces: { packages: ["packages/*", "apps/*"] },
        dependencies: { "@demo/core": "workspace:*" },
      }),
    });

    expect(packageJson.modules.map((module) => module.name)).toContain("packages/*");
    expect(packageJson.dependencies).toContainEqual(
      expect.objectContaining({
        from: "project:@demo/root",
        to: "module-glob:apps/*",
        kind: "workspace",
      }),
    );
    expect(packageJson.dependencies).toContainEqual(
      expect.objectContaining({
        from: "module:@demo/root",
        to: "package:@demo/core",
        kind: "package",
      }),
    );

    const tsconfig = parseJsonDiscoveryFile({
      filePath: "tsconfig.json",
      content: JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@demo/core": ["packages/core/src/index.ts"],
          },
        },
        references: [{ path: "packages/core" }, { path: "apps/web" }],
      }),
    });

    expect(tsconfig.modules.map((module) => module.path)).toEqual(["apps/web", "packages/core"]);
    expect(tsconfig.dependencies).toContainEqual(
      expect.objectContaining({
        from: "project:tsconfig",
        to: "module:packages/core",
        kind: "reference",
      }),
    );
    expect(tsconfig.dependencies).toContainEqual(
      expect.objectContaining({ from: "project:tsconfig", to: "@demo/core", kind: "includes" }),
    );
  });

  it("parses Gradle multi-project settings, projectDir mappings, catalogs, plugins, and deps", () => {
    const settings = parseGradleDiscoveryFile({
      filePath: "settings.gradle.kts",
      content: [
        'rootProject.name = "DemoGradle"',
        'include(":app", ":core:network")',
        'project(":core:network").projectDir = file("modules/network")',
        'includeBuild("build-logic")',
        "dependencyResolutionManagement {",
        "  versionCatalogs {",
        '    create("libs") { from(files("gradle/libs.versions.toml")) }',
        "  }",
        "}",
      ].join("\n"),
    });

    expect(settings.projects).toContainEqual(
      expect.objectContaining({ name: "DemoGradle", type: "gradle-root" }),
    );
    expect(settings.modules).toContainEqual(
      expect.objectContaining({ name: "core:network", path: "modules/network" }),
    );
    expect(settings.modules).toContainEqual(
      expect.objectContaining({ name: "build-logic", type: "gradle-included-build" }),
    );
    expect(settings.dependencies).toContainEqual(
      expect.objectContaining({
        from: "project:DemoGradle",
        to: "module:core:network",
        kind: "workspace",
      }),
    );
    expect(settings.packages).toContainEqual(
      expect.objectContaining({
        name: "gradle/libs.versions.toml",
        type: "gradle-version-catalog",
      }),
    );

    const build = parseGradleDiscoveryFile({
      filePath: "app/build.gradle.kts",
      content: [
        "plugins {",
        '  id("com.android.application") version "8.5.0"',
        '  kotlin("android") version "2.0.0"',
        "  alias(libs.plugins.compose)",
        "}",
        "subprojects { repositories { google() } }",
        "dependencies {",
        '  implementation(project(":core:network"))',
        '  testImplementation("junit:junit:4.13.2")',
        "}",
      ].join("\n"),
    });

    expect(build.modules).toContainEqual(
      expect.objectContaining({
        name: "app",
        metadata: expect.objectContaining({
          plugins: expect.arrayContaining([
            "com.android.application",
            "org.jetbrains.kotlin.android",
          ]),
          scopedBlocks: ["subprojects"],
        }),
      }),
    );
    expect(build.dependencies).toContainEqual(
      expect.objectContaining({
        from: "module:app",
        to: "module:core:network",
        kind: "depends_on",
        scope: "implementation",
      }),
    );
    expect(build.packages).toContainEqual(
      expect.objectContaining({ name: "junit:junit", version: "4.13.2" }),
    );
  });

  it("parses Bazel BUILD target deps, load statements, visibility, and rule kind", () => {
    const parsed = parseStarlarkDiscoveryFile({
      filePath: "services/api/BUILD.bazel",
      content: [
        'load("@rules_java//java:defs.bzl", "java_library")',
        'package(default_visibility = ["//visibility:public"])',
        "java_library(",
        '  name = "api",',
        '  srcs = glob(["src/main/java/**/*.java"]),',
        '  deps = [":model", "//libs/http:client", "@maven//:guava"],',
        '  visibility = ["//teams/backend:__pkg__"],',
        ")",
        'proto_library(name = "model", deps = ["//proto:common"])',
      ].join("\n"),
    });

    expect(parsed.packages).toContainEqual(
      expect.objectContaining({
        name: "@rules_java//java:defs.bzl".replace("@rules_java", ""),
        type: "starlark-load",
      }),
    );
    expect(parsed.targets).toContainEqual(
      expect.objectContaining({
        name: "api",
        type: "java_library",
        language: "java",
        metadata: expect.objectContaining({
          visibility: ["//teams/backend:__pkg__"],
          rule: "java_library",
        }),
      }),
    );
    expect(parsed.dependencies).toContainEqual(
      expect.objectContaining({
        from: "target://services/api:api",
        to: "target://services/api:model",
        kind: "target",
      }),
    );
    expect(parsed.dependencies).toContainEqual(
      expect.objectContaining({
        from: "target://services/api:api",
        to: "package:@maven//:guava",
        kind: "package",
      }),
    );
  });

  it("parses Bazel MODULE dependencies", () => {
    const parsed = parseStarlarkDiscoveryFile({
      filePath: "MODULE.bazel",
      content: [
        'module(name = "demo", version = "1.0.0")',
        'bazel_dep(name = "rules_jvm_external", version = "6.4")',
      ].join("\n"),
    });

    expect(parsed.projects).toContainEqual(
      expect.objectContaining({ name: "demo", version: "1.0.0", type: "bazel-module" }),
    );
    expect(parsed.dependencies).toContainEqual(
      expect.objectContaining({
        from: "workspace:demo",
        to: "package:rules_jvm_external",
        kind: "package",
      }),
    );
  });

  it("parses CMake library, executable, links, subdirectory, find_package, and sources", () => {
    const parsed = parseCMakeDiscoveryFile({
      filePath: "CMakeLists.txt",
      content: [
        "cmake_minimum_required(VERSION 3.24)",
        "project(DemoCMake VERSION 2.1.0 LANGUAGES CXX)",
        "find_package(fmt REQUIRED)",
        "include_directories(include)",
        "add_subdirectory(src/plugins)",
        "add_library(core STATIC src/core.cpp include/core.h)",
        "target_sources(core PRIVATE src/extra.cpp)",
        "target_include_directories(core PUBLIC include/core)",
        "add_executable(app src/main.cpp)",
        "target_link_libraries(app PRIVATE core PUBLIC fmt::fmt)",
      ].join("\n"),
    });

    expect(parsed.projects).toContainEqual(
      expect.objectContaining({ name: "DemoCMake", version: "2.1.0" }),
    );
    expect(parsed.modules).toContainEqual(
      expect.objectContaining({ name: "src/plugins", type: "cmake-subdirectory" }),
    );
    expect(parsed.packages).toContainEqual(
      expect.objectContaining({ name: "fmt", type: "cmake-find-package" }),
    );
    expect(parsed.targets).toContainEqual(
      expect.objectContaining({
        name: "core",
        type: "static-library",
        metadata: expect.objectContaining({
          sources: ["include/core.h", "src/core.cpp", "src/extra.cpp"],
        }),
      }),
    );
    expect(parsed.targets).toContainEqual(
      expect.objectContaining({ name: "app", type: "executable" }),
    );
    expect(parsed.dependencies).toContainEqual(
      expect.objectContaining({
        from: "target:app",
        to: "target:core",
        kind: "target",
        scope: "PRIVATE",
      }),
    );
    expect(parsed.dependencies).toContainEqual(
      expect.objectContaining({
        from: "target:app",
        to: "package:fmt::fmt",
        kind: "package",
        scope: "PUBLIC",
      }),
    );
  });

  it("returns diagnostics instead of throwing on invalid input", () => {
    const parsed = parseJsonDiscoveryFile({ filePath: "broken.json", content: "{ nope" });

    expect(parsed.confidence).toBe(0);
    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ severity: "error" }));
  });
});
