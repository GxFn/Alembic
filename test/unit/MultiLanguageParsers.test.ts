/**
 * 多语言解析器 + CustomConfigDiscoverer 扩展 单元测试
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomConfigDiscoverer } from '../../lib/core/discovery/CustomConfigDiscoverer.js';
import { parseCMakeProject } from '../../lib/core/discovery/parsers/CMakeParser.js';
import {
  inferConventionRole,
  parseGradleProject,
} from '../../lib/core/discovery/parsers/GradleDslParser.js';
import {
  parseFlutterPluginsDeps,
  parseNxWorkspace,
  parseReactNativeProject,
} from '../../lib/core/discovery/parsers/JsonConfigParser.js';
import {
  parseStarlarkBuildFile,
  RULE_TO_LANGUAGE,
} from '../../lib/core/discovery/parsers/StarlarkParser.js';
import { parseMelosProject } from '../../lib/core/discovery/parsers/YamlConfigParser.js';

// ═══ StarlarkParser ═══════════════════════════════════

describe('StarlarkParser — parseStarlarkBuildFile', () => {
  it('should extract load statements', () => {
    const result = parseStarlarkBuildFile(`
load("@build_bazel_rules_swift//swift:swift.bzl", "swift_library", "swift_binary")
`);
    expect(result.loads).toHaveLength(1);
    expect(result.loads[0].repository).toBe('@build_bazel_rules_swift');
    expect(result.loads[0].path).toBe('//swift:swift.bzl');
    expect(result.loads[0].symbols).toEqual(['swift_library', 'swift_binary']);
  });

  it('should extract multi-line target declarations', () => {
    const result = parseStarlarkBuildFile(`
swift_library(
    name = "NetworkKit",
    srcs = glob(["Sources/**/*.swift"]),
    deps = [
        "//core/logging:Logging",
        ":Utils",
    ],
    visibility = ["//visibility:public"],
)
`);
    expect(result.targets).toHaveLength(1);
    const target = result.targets[0];
    expect(target.rule).toBe('swift_library');
    expect(target.name).toBe('NetworkKit');
    expect(target.srcs).toContain('Sources/**/*.swift');
    expect(target.deps).toContain('//core/logging:Logging');
    expect(target.deps).toContain(':Utils');
    expect(target.visibility).toContain('//visibility:public');
  });

  it('should detect testonly targets', () => {
    const result = parseStarlarkBuildFile(`
swift_test(
    name = "NetworkKitTests",
    testonly = True,
    srcs = ["Tests/NetworkKitTests.swift"],
    deps = [":NetworkKit"],
)
`);
    expect(result.targets[0].testonly).toBe(true);
  });

  it('should handle multiple targets', () => {
    const result = parseStarlarkBuildFile(`
cc_library(
    name = "core",
    srcs = ["core.cpp"],
    deps = [],
)

cc_binary(
    name = "main",
    srcs = ["main.cpp"],
    deps = [":core"],
)
`);
    expect(result.targets).toHaveLength(2);
    expect(result.targets[0].name).toBe('core');
    expect(result.targets[1].name).toBe('main');
  });

  it('RULE_TO_LANGUAGE should map common rules', () => {
    expect(RULE_TO_LANGUAGE.swift_library).toBe('swift');
    expect(RULE_TO_LANGUAGE.cc_binary).toBe('cpp');
    expect(RULE_TO_LANGUAGE.java_library).toBe('java');
    expect(RULE_TO_LANGUAGE.kt_jvm_library).toBe('kotlin');
    expect(RULE_TO_LANGUAGE.py_binary).toBe('python');
    expect(RULE_TO_LANGUAGE.go_library).toBe('go');
    expect(RULE_TO_LANGUAGE.rust_binary).toBe('rust');
  });

  it('should handle empty BUILD file', () => {
    const result = parseStarlarkBuildFile('');
    expect(result.targets).toHaveLength(0);
    expect(result.loads).toHaveLength(0);
  });

  it('should skip comment lines', () => {
    const result = parseStarlarkBuildFile(`
# This is a comment
# load("@repo//path:file.bzl", "rule")
swift_library(
    name = "Lib",
    srcs = ["lib.swift"],
)
`);
    expect(result.loads).toHaveLength(0);
    expect(result.targets).toHaveLength(1);
  });
});

// ═══ GradleDslParser ═════════════════════════════════

describe('GradleDslParser — parseGradleProject', () => {
  it('should extract rootProject.name (Kotlin DSL)', () => {
    const result = parseGradleProject(`
rootProject.name = "MyAndroidApp"
include(":app")
include(":core:network", ":core:database")
include(":feature:home")
`);
    expect(result.rootProjectName).toBe('MyAndroidApp');
    expect(result.includedModules).toHaveLength(4);
    expect(result.includedModules[0].path).toBe(':app');
    expect(result.includedModules[0].directory).toBe('app');
    expect(result.includedModules[1].path).toBe(':core:network');
    expect(result.includedModules[1].directory).toBe('core/network');
  });

  it('should extract rootProject.name (Groovy DSL)', () => {
    const result = parseGradleProject(`
rootProject.name = 'LegacyApp'
include ':app', ':lib'
`);
    expect(result.rootProjectName).toBe('LegacyApp');
    expect(result.includedModules).toHaveLength(2);
  });

  it('should detect version catalog', () => {
    const result = parseGradleProject(`
rootProject.name = "App"
dependencyResolutionManagement {
    versionCatalogs {
        create("libs") {
            from(files("gradle/libs.versions.toml"))
        }
    }
}
include(":app")
`);
    expect(result.versionCatalog).toBe('gradle/libs.versions.toml');
  });

  it('should parse build file for module (plugins + deps)', () => {
    const module = { path: ':feature:home', directory: 'feature/home', dependencies: [] };
    const result = parseGradleProject(
      `
plugins {
    id("myapp.android.feature")
}

dependencies {
    implementation(project(":core:network"))
    api(project(":core:model"))
    testImplementation(project(":core:testing"))
}
`,
      module
    );
    expect(result.includedModules).toHaveLength(1);
    const mod = result.includedModules[0];
    expect(mod.conventionPlugin).toBe('myapp.android.feature');
    expect(mod.dependencies).toHaveLength(3);
    expect(mod.dependencies[0]).toEqual({
      configuration: 'implementation',
      target: ':core:network',
      isProject: true,
    });
  });
});

describe('GradleDslParser — inferConventionRole', () => {
  it('should infer feature role', () => {
    expect(inferConventionRole('myapp.android.feature')).toBe('feature');
  });

  it('should infer library role', () => {
    expect(inferConventionRole('myapp.android.library')).toBe('library');
  });

  it('should infer application role', () => {
    expect(inferConventionRole('myapp.android.application')).toBe('application');
  });

  it('should return undefined for unknown suffix', () => {
    expect(inferConventionRole('myapp.android.custom')).toBeUndefined();
  });
});

// ═══ CMakeParser ═════════════════════════════════════

describe('CMakeParser — parseCMakeProject', () => {
  it('should extract project name and version', () => {
    const result = parseCMakeProject(`
cmake_minimum_required(VERSION 3.20)
project(MyProject VERSION 1.0.0)
`);
    expect(result.projectName).toBe('MyProject');
    expect(result.version).toBe('1.0.0');
  });

  it('should extract add_subdirectory calls', () => {
    const result = parseCMakeProject(`
project(Root)
add_subdirectory(src)
add_subdirectory(libs/core)
add_subdirectory(tests)
`);
    expect(result.subdirectories).toEqual(['src', 'libs/core', 'tests']);
  });

  it('should extract library targets', () => {
    const result = parseCMakeProject(`
project(Libs)
add_library(core STATIC
    core.cpp
    core.h
)
add_library(utils SHARED utils.cpp)
add_library(api INTERFACE)
`);
    expect(result.targets).toHaveLength(3);
    expect(result.targets[0].name).toBe('core');
    expect(result.targets[0].type).toBe('static-library');
    expect(result.targets[1].name).toBe('utils');
    expect(result.targets[1].type).toBe('shared-library');
    expect(result.targets[2].name).toBe('api');
    expect(result.targets[2].type).toBe('interface-library');
  });

  it('should extract executable targets', () => {
    const result = parseCMakeProject(`
project(App)
add_executable(main main.cpp)
`);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].name).toBe('main');
    expect(result.targets[0].type).toBe('executable');
  });

  it('should extract target_link_libraries', () => {
    const result = parseCMakeProject(`
project(App)
add_executable(main main.cpp)
add_library(core STATIC core.cpp)
target_link_libraries(main
    PUBLIC core
    PRIVATE utils
)
`);
    const mainTarget = result.targets.find((t) => t.name === 'main');
    expect(mainTarget).toBeDefined();
    expect(mainTarget?.linkDependencies).toHaveLength(2);
    expect(mainTarget?.linkDependencies[0]).toEqual({ target: 'core', scope: 'PUBLIC' });
    expect(mainTarget?.linkDependencies[1]).toEqual({ target: 'utils', scope: 'PRIVATE' });
  });

  it('should ignore comments', () => {
    const result = parseCMakeProject(`
# project(Fake)
project(Real)
# add_subdirectory(fake)
add_subdirectory(real)
`);
    expect(result.projectName).toBe('Real');
    expect(result.subdirectories).toEqual(['real']);
  });

  it('should handle empty CMakeLists.txt', () => {
    const result = parseCMakeProject('');
    expect(result.projectName).toBe('');
    expect(result.targets).toHaveLength(0);
    expect(result.subdirectories).toHaveLength(0);
  });
});

// ═══ JsonConfigParser ════════════════════════════════

describe('JsonConfigParser — parseNxWorkspace', () => {
  it('should extract Nx project from project.json', () => {
    const result = parseNxWorkspace(
      JSON.stringify({
        name: 'my-lib',
        root: 'libs/my-lib',
        projectType: 'library',
        tags: ['scope:shared', 'type:util'],
      })
    );
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].name).toBe('my-lib');
    expect(result.projects[0].root).toBe('libs/my-lib');
    expect(result.projects[0].projectType).toBe('library');
    expect(result.projects[0].tags).toEqual(['scope:shared', 'type:util']);
  });

  it('should handle missing tags', () => {
    const result = parseNxWorkspace(
      JSON.stringify({
        name: 'my-app',
        root: 'apps/my-app',
        projectType: 'application',
      })
    );
    expect(result.projects[0].tags).toEqual([]);
  });

  it('should return empty on invalid JSON', () => {
    const result = parseNxWorkspace('not json');
    expect(result.projects).toHaveLength(0);
  });
});

describe('JsonConfigParser — parseFlutterPluginsDeps', () => {
  it('should extract plugins from dependencyGraph', () => {
    const result = parseFlutterPluginsDeps(
      JSON.stringify({
        dependencyGraph: [
          { name: 'flutter', path: '/sdk/flutter' },
          { name: 'url_launcher', path: '/pub-cache/url_launcher' },
          { name: 'shared_preferences', path: '/pub-cache/shared_preferences' },
        ],
      })
    );
    // Skips flutter itself
    expect(result.plugins).toHaveLength(2);
    expect(result.plugins[0].name).toBe('url_launcher');
    expect(result.plugins[1].name).toBe('shared_preferences');
  });

  it('should extract platform-specific plugins', () => {
    const result = parseFlutterPluginsDeps(
      JSON.stringify({
        plugins: {
          ios: [{ name: 'camera', path: '/p/camera' }],
          android: [{ name: 'camera', path: '/p/camera' }],
        },
      })
    );
    expect(result.plugins.some((p) => p.platform === 'ios')).toBe(true);
    expect(result.plugins.some((p) => p.platform === 'android')).toBe(true);
  });

  it('should extract Flutter SDK version', () => {
    const result = parseFlutterPluginsDeps(
      JSON.stringify({
        flutterVersion: '3.24.0',
      })
    );
    expect(result.flutterSdkVersion).toBe('3.24.0');
  });
});

describe('JsonConfigParser — parseReactNativeProject', () => {
  it('should detect React Native project', () => {
    const result = parseReactNativeProject(
      JSON.stringify({
        name: 'my-rn-app',
        dependencies: {
          'react-native': '0.73.0',
          react: '18.2.0',
        },
      })
    );
    expect(result.isReactNative).toBe(true);
    expect(result.name).toBe('my-rn-app');
    expect(result.rnVersion).toBe('0.73.0');
  });

  it('should detect non-RN project', () => {
    const result = parseReactNativeProject(
      JSON.stringify({
        name: 'web-app',
        dependencies: { react: '18.2.0' },
      })
    );
    expect(result.isReactNative).toBe(false);
  });

  it('should detect Fabric / TurboModules', () => {
    const result = parseReactNativeProject(
      JSON.stringify({
        name: 'modern-rn',
        dependencies: {
          'react-native': '0.73.0',
          'react-native-codegen': '1.0.0',
        },
        codegenConfig: { name: 'specs' },
      })
    );
    expect(result.hasFabric).toBe(true);
    expect(result.hasTurboModules).toBe(true);
  });
});

// ═══ YamlConfigParser — Melos ════════════════════════

describe('YamlConfigParser — parseMelosProject', () => {
  it('should extract Melos project name', () => {
    const result = parseMelosProject(`
name: my_workspace
packages:
  - packages/**
  - plugins/**
scripts:
  analyze:
    exec: dart analyze .
  test:
    exec: flutter test
`);
    expect(result.name).toBe('my_workspace');
    expect(result.packageGlobs).toEqual(['packages/**', 'plugins/**']);
    expect(result.scripts).toContain('analyze');
    expect(result.scripts).toContain('test');
  });

  it('should handle minimal melos.yaml', () => {
    const result = parseMelosProject(`
name: minimal
`);
    expect(result.name).toBe('minimal');
    expect(result.packageGlobs).toEqual([]);
    expect(result.scripts).toEqual([]);
  });

  it('should handle invalid YAML', () => {
    const result = parseMelosProject('{{invalid yaml');
    expect(result.name).toBe('');
  });
});

// ═══ CustomConfigDiscoverer — markerStrategy + antiMarkers ══

describe('CustomConfigDiscoverer — 多语言检测', () => {
  let root: string;

  beforeAll(() => {
    root = join(tmpdir(), `asd-multi-lang-test-${Date.now()}`);
    mkdirSync(root, { recursive: true });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('should detect Bazel project (WORKSPACE + BUILD.bazel)', async () => {
    const projDir = join(root, 'bazel-proj');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 'WORKSPACE'), '# Bazel workspace');
    writeFileSync(
      join(projDir, 'BUILD.bazel'),
      `
swift_library(
    name = "App",
    srcs = glob(["**/*.swift"]),
)
`
    );

    const d = new CustomConfigDiscoverer();
    const result = await d.detect(projDir);
    expect(result.match).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('should detect Buck2 project (BUCK + .buckconfig)', async () => {
    const projDir = join(root, 'buck2-proj');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, '.buckconfig'), '[buck]');
    writeFileSync(
      join(projDir, 'BUCK'),
      `
cxx_library(
    name = "core",
    srcs = ["core.cpp"],
)
`
    );

    const d = new CustomConfigDiscoverer();
    const result = await d.detect(projDir);
    expect(result.match).toBe(true);
  });

  it('should detect Gradle convention-plugin project', async () => {
    const projDir = join(root, 'gradle-proj');
    mkdirSync(join(projDir, 'build-logic', 'convention'), { recursive: true });
    writeFileSync(
      join(projDir, 'settings.gradle.kts'),
      `
rootProject.name = "MyApp"
include(":app")
`
    );
    writeFileSync(join(projDir, 'build.gradle.kts'), '');
    writeFileSync(join(projDir, 'build-logic', 'convention', 'build.gradle.kts'), '');

    const d = new CustomConfigDiscoverer();
    const result = await d.detect(projDir);
    expect(result.match).toBe(true);
  });

  it('should detect Melos project', async () => {
    const projDir = join(root, 'melos-proj');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'melos.yaml'),
      `
name: my_workspace
packages:
  - packages/**
`
    );
    writeFileSync(
      join(projDir, 'pubspec.yaml'),
      `
name: my_workspace
`
    );

    const d = new CustomConfigDiscoverer();
    const result = await d.detect(projDir);
    expect(result.match).toBe(true);
  });

  it('should detect CMake multi-project', async () => {
    const projDir = join(root, 'cmake-proj');
    mkdirSync(join(projDir, 'src'), { recursive: true });
    mkdirSync(join(projDir, 'libs'), { recursive: true });
    writeFileSync(
      join(projDir, 'CMakeLists.txt'),
      `
cmake_minimum_required(VERSION 3.20)
project(MyProject)
add_subdirectory(src)
add_subdirectory(libs)
`
    );

    const d = new CustomConfigDiscoverer();
    const result = await d.detect(projDir);
    expect(result.match).toBe(true);
  });

  it('should detect Nx monorepo', async () => {
    const projDir = join(root, 'nx-proj');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 'nx.json'), '{}');
    writeFileSync(join(projDir, 'package.json'), '{ "name": "my-nx" }');

    const d = new CustomConfigDiscoverer();
    const result = await d.detect(projDir);
    expect(result.match).toBe(true);
  });

  it('should detect Flutter add-to-app', async () => {
    const projDir = join(root, 'flutter-hybrid');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 'pubspec.yaml'), 'name: flutter_module');
    writeFileSync(
      join(projDir, '.flutter-plugins-dependencies'),
      JSON.stringify({ dependencyGraph: [] })
    );

    const iosDir = join(projDir, 'ios');
    mkdirSync(iosDir, { recursive: true });
    writeFileSync(join(iosDir, 'Podfile'), '# iOS Podfile');

    const d = new CustomConfigDiscoverer();
    const result = await d.detect(projDir);
    expect(result.match).toBe(true);
  });

  it('should detect React Native hybrid', async () => {
    const projDir = join(root, 'rn-hybrid');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'package.json'),
      JSON.stringify({ name: 'my-rn', dependencies: { 'react-native': '0.73.0' } })
    );
    writeFileSync(join(projDir, 'metro.config.js'), 'module.exports = {};');

    const iosDir = join(projDir, 'ios');
    mkdirSync(iosDir, { recursive: true });
    writeFileSync(join(iosDir, 'Podfile'), '# Podfile');

    const d = new CustomConfigDiscoverer();
    const result = await d.detect(projDir);
    expect(result.match).toBe(true);
  });

  it('should use antiMarkers to reject false positives', async () => {
    // A plain Podfile project without any special markers should NOT match
    // custom systems that also require specific markers
    const projDir = join(root, 'plain-pod');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 'Podfile'), '# Just cocoapods');
    writeFileSync(join(projDir, 'MyApp.xcodeproj'), ''); // file, not dir — quirky but tests antiMarker

    const d = new CustomConfigDiscoverer();
    const result = await d.detect(projDir);
    // Should NOT match any custom system (no specific markers)
    // Low confidence at most (heuristic)
    if (result.match) {
      expect(result.confidence).toBeLessThan(0.7);
    }
  });
});

// ═══ CustomConfigDiscoverer — Bazel load() + targets ════

describe('CustomConfigDiscoverer — Bazel load & targets', () => {
  let root: string;
  let projDir: string;

  beforeAll(async () => {
    root = join(tmpdir(), `asd-bazel-load-test-${Date.now()}`);
    projDir = join(root, 'bazel-full');
    mkdirSync(join(projDir, 'lib', 'network'), { recursive: true });

    writeFileSync(join(projDir, 'WORKSPACE'), '# Bazel WORKSPACE');
    writeFileSync(
      join(projDir, 'BUILD.bazel'),
      `
load("@build_bazel_rules_swift//swift:swift.bzl", "swift_library")

swift_library(
    name = "App",
    srcs = glob(["Sources/**/*.swift"]),
    deps = ["//lib/network:NetworkKit"],
    visibility = ["//visibility:public"],
)
`
    );
    writeFileSync(
      join(projDir, 'lib', 'network', 'BUILD.bazel'),
      `
swift_library(
    name = "NetworkKit",
    srcs = glob(["**/*.swift"]),
    visibility = ["//visibility:public"],
)
`
    );

    const d = new CustomConfigDiscoverer();
    await d.detect(projDir);
    await d.load(projDir);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('should discover BUILD targets', async () => {
    const d = new CustomConfigDiscoverer();
    await d.detect(projDir);
    await d.load(projDir);
    const targets = await d.listTargets();
    expect(targets.length).toBeGreaterThanOrEqual(2);
    expect(targets.some((t) => t.name === 'App')).toBe(true);
    expect(targets.some((t) => t.name === 'NetworkKit')).toBe(true);
  });
});

// ═══ CustomConfigDiscoverer — Gradle load & targets ═════

describe('CustomConfigDiscoverer — Gradle load & targets', () => {
  let root: string;
  let projDir: string;

  beforeAll(() => {
    root = join(tmpdir(), `asd-gradle-load-test-${Date.now()}`);
    projDir = join(root, 'gradle-full');
    mkdirSync(join(projDir, 'build-logic', 'convention'), { recursive: true });
    mkdirSync(join(projDir, 'app'), { recursive: true });
    mkdirSync(join(projDir, 'core', 'network'), { recursive: true });

    writeFileSync(
      join(projDir, 'settings.gradle.kts'),
      `
rootProject.name = "MyAndroidApp"
include(":app")
include(":core:network")
`
    );
    writeFileSync(join(projDir, 'build.gradle.kts'), '');
    writeFileSync(join(projDir, 'build-logic', 'build.gradle.kts'), '');

    writeFileSync(
      join(projDir, 'app', 'build.gradle.kts'),
      `
plugins {
    id("myapp.android.application")
}

dependencies {
    implementation(project(":core:network"))
}
`
    );
    writeFileSync(
      join(projDir, 'core', 'network', 'build.gradle.kts'),
      `
plugins {
    id("myapp.android.library")
}
`
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('should discover Gradle modules with convention roles', async () => {
    const d = new CustomConfigDiscoverer();
    await d.detect(projDir);
    await d.load(projDir);
    const targets = await d.listTargets();
    expect(targets.length).toBeGreaterThanOrEqual(2);
    expect(targets.some((t) => t.name === ':app')).toBe(true);
    expect(targets.some((t) => t.name === ':core:network')).toBe(true);

    const appTarget = targets.find((t) => t.name === ':app');
    expect(appTarget?.metadata?.conventionRole).toBe('application');
  });
});

// ═══ CustomConfigDiscoverer — CMake load & targets ══════

describe('CustomConfigDiscoverer — CMake load & targets', () => {
  let root: string;
  let projDir: string;

  beforeAll(() => {
    root = join(tmpdir(), `asd-cmake-load-test-${Date.now()}`);
    projDir = join(root, 'cmake-full');
    mkdirSync(join(projDir, 'src'), { recursive: true });
    mkdirSync(join(projDir, 'libs', 'core'), { recursive: true });

    writeFileSync(
      join(projDir, 'CMakeLists.txt'),
      `
cmake_minimum_required(VERSION 3.20)
project(MyCppProject VERSION 2.0.0)
add_subdirectory(src)
add_subdirectory(libs/core)
add_executable(main src/main.cpp)
target_link_libraries(main PUBLIC core)
`
    );
    writeFileSync(
      join(projDir, 'src', 'CMakeLists.txt'),
      `
add_library(app STATIC app.cpp)
`
    );
    writeFileSync(
      join(projDir, 'libs', 'core', 'CMakeLists.txt'),
      `
add_library(core STATIC core.cpp)
`
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('should discover CMake targets from root and subdirectories', async () => {
    const d = new CustomConfigDiscoverer();
    await d.detect(projDir);
    await d.load(projDir);
    const targets = await d.listTargets();
    // main (exe) + app (lib from src) + core (lib from libs/core)
    expect(targets.length).toBeGreaterThanOrEqual(3);
    expect(targets.some((t) => t.name === 'main')).toBe(true);
  });
});
