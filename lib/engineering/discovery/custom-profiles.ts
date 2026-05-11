import path from "node:path";
import type { EngineeringWorkspaceReader } from "./project.js";

export type CustomConfigMarkerStrategy = "all" | "any" | "ordered";

export type CustomConfigParserRoute =
  | "ruby-dsl"
  | "yaml"
  | "swift-dsl"
  | "starlark"
  | "gradle-dsl"
  | "cmake"
  | "json-config";

export interface CustomConfigProfile {
  readonly id: string;
  readonly displayName: string;
  readonly markers: readonly string[];
  readonly markerStrategy?: CustomConfigMarkerStrategy;
  readonly antiMarkers?: readonly string[];
  readonly moduleSpecPattern: string | null;
  readonly language: readonly string[];
  readonly confidence: number;
  readonly parser: CustomConfigParserRoute;
  readonly watchPatterns?: readonly string[];
}

export interface CustomConfigProfileMatch {
  readonly profile: CustomConfigProfile;
  readonly confidence: number;
  readonly reason: string;
}

export const BUILTIN_CUSTOM_CONFIG_PROFILES: readonly CustomConfigProfile[] = Object.freeze([
  {
    id: "bazel",
    displayName: "Bazel",
    markers: ["MODULE.bazel", "WORKSPACE", "WORKSPACE.bazel"],
    markerStrategy: "any",
    moduleSpecPattern: "BUILD.bazel",
    language: Object.freeze([]),
    confidence: 0.85,
    parser: "starlark",
    watchPatterns: Object.freeze([
      "MODULE.bazel",
      "WORKSPACE",
      "WORKSPACE.bazel",
      "**/BUILD.bazel",
      "**/BUILD",
    ]),
  },
  {
    id: "buck2",
    displayName: "Buck2",
    markers: [".buckconfig", ".buckroot"],
    markerStrategy: "any",
    moduleSpecPattern: "BUCK",
    language: Object.freeze([]),
    confidence: 0.85,
    parser: "starlark",
    watchPatterns: Object.freeze([".buckconfig", ".buckroot", "**/BUCK"]),
  },
  {
    id: "gradle-convention",
    displayName: "Gradle Convention Plugins",
    markers: ["build-logic/convention/", "buildSrc/src/main/kotlin/"],
    markerStrategy: "any",
    moduleSpecPattern: null,
    language: Object.freeze(["kotlin", "java"]),
    confidence: 0.8,
    parser: "gradle-dsl",
    watchPatterns: Object.freeze([
      "settings.gradle",
      "settings.gradle.kts",
      "**/build.gradle",
      "**/build.gradle.kts",
      "gradle/libs.versions.toml",
      "build-logic/**/*.gradle.kts",
      "buildSrc/**/*.kt",
    ]),
  },
  {
    id: "melos",
    displayName: "Melos (Flutter Monorepo)",
    markers: ["melos.yaml"],
    moduleSpecPattern: null,
    language: Object.freeze(["dart"]),
    confidence: 0.82,
    parser: "yaml",
    watchPatterns: Object.freeze(["melos.yaml", "**/pubspec.yaml"]),
  },
  {
    id: "easybox",
    displayName: "Baidu EasyBox",
    markers: ["Boxfile"],
    moduleSpecPattern: "*.boxspec",
    language: Object.freeze(["objectivec", "swift"]),
    confidence: 0.8,
    parser: "ruby-dsl",
    watchPatterns: Object.freeze([
      "Boxfile",
      "Boxfile.local",
      "Boxfile.overlay",
      "**/*.boxspec",
      "**/*.podspec",
    ]),
  },
  {
    id: "tuist",
    displayName: "Tuist",
    markers: ["Tuist/Config.swift", "Project.swift"],
    markerStrategy: "any",
    moduleSpecPattern: null,
    language: Object.freeze(["swift"]),
    confidence: 0.8,
    parser: "swift-dsl",
    watchPatterns: Object.freeze(["Project.swift", "Tuist/**/*.swift"]),
  },
  {
    id: "ks-component",
    displayName: "KSComponent",
    markers: ["KSPodfile", "Podfile.ks"],
    markerStrategy: "any",
    moduleSpecPattern: "*.podspec",
    language: Object.freeze(["swift", "objectivec"]),
    confidence: 0.8,
    parser: "ruby-dsl",
    watchPatterns: Object.freeze(["KSPodfile", "Podfile.ks", "**/*.podspec"]),
  },
  {
    id: "mt-component",
    displayName: "MTComponent",
    markers: ["MTModulefile", "MTConfig.yml"],
    markerStrategy: "any",
    moduleSpecPattern: "*.podspec",
    language: Object.freeze(["swift", "objectivec"]),
    confidence: 0.78,
    parser: "ruby-dsl",
    watchPatterns: Object.freeze(["MTModulefile", "MTConfig.yml", "**/*.podspec"]),
  },
  {
    id: "flutter-add-to-app",
    displayName: "Flutter Add-to-App",
    markers: [".flutter-plugins-dependencies", ".flutter-plugins"],
    markerStrategy: "any",
    moduleSpecPattern: "pubspec.yaml",
    language: Object.freeze(["dart"]),
    confidence: 0.78,
    parser: "json-config",
    watchPatterns: Object.freeze([
      ".flutter-plugins-dependencies",
      ".flutter-plugins",
      "**/pubspec.yaml",
    ]),
  },
  {
    id: "react-native-hybrid",
    displayName: "React Native Hybrid",
    markers: ["metro.config.js", "metro.config.ts", "react-native.config.js"],
    markerStrategy: "any",
    moduleSpecPattern: null,
    language: Object.freeze(["typescript", "javascript"]),
    confidence: 0.78,
    parser: "json-config",
    watchPatterns: Object.freeze([
      "metro.config.js",
      "metro.config.ts",
      "react-native.config.js",
      "package.json",
    ]),
  },
  {
    id: "kotlin-multiplatform",
    displayName: "Kotlin Multiplatform",
    markers: ["shared/build.gradle.kts"],
    moduleSpecPattern: null,
    language: Object.freeze(["kotlin"]),
    confidence: 0.78,
    parser: "gradle-dsl",
    watchPatterns: Object.freeze([
      "settings.gradle",
      "settings.gradle.kts",
      "**/build.gradle",
      "**/build.gradle.kts",
    ]),
  },
  {
    id: "nx-monorepo",
    displayName: "Nx Monorepo",
    markers: ["nx.json"],
    moduleSpecPattern: "project.json",
    language: Object.freeze(["typescript", "javascript"]),
    confidence: 0.8,
    parser: "json-config",
    watchPatterns: Object.freeze([
      "nx.json",
      "**/project.json",
      "package.json",
      "tsconfig.base.json",
    ]),
  },
  {
    id: "pants",
    displayName: "Pants Build",
    markers: ["pants.toml"],
    moduleSpecPattern: "BUILD",
    language: Object.freeze([]),
    confidence: 0.8,
    parser: "starlark",
    watchPatterns: Object.freeze(["pants.toml", "**/BUILD"]),
  },
  {
    id: "cmake-multiproject",
    displayName: "CMake Multi-Project",
    markers: ["CMakeLists.txt"],
    antiMarkers: ["MODULE.bazel", "WORKSPACE", "meson.build"],
    moduleSpecPattern: "CMakeLists.txt",
    language: Object.freeze(["cpp", "c"]),
    confidence: 0.75,
    parser: "cmake",
    watchPatterns: Object.freeze(["CMakeLists.txt", "**/CMakeLists.txt", "**/*.cmake"]),
  },
  {
    id: "xcodegen",
    displayName: "XcodeGen",
    markers: ["project.yml", "project.yaml"],
    markerStrategy: "any",
    moduleSpecPattern: null,
    language: Object.freeze(["swift", "objectivec"]),
    confidence: 0.75,
    parser: "yaml",
    watchPatterns: Object.freeze(["project.yml", "project.yaml", "**/*.yml", "**/*.yaml"]),
  },
]);

export class CustomConfigProfileRegistry {
  readonly #profiles: CustomConfigProfile[];

  constructor(profiles: readonly CustomConfigProfile[] = BUILTIN_CUSTOM_CONFIG_PROFILES) {
    this.#profiles = [...profiles];
  }

  register(profile: CustomConfigProfile): this {
    this.#profiles.unshift(profile);
    return this;
  }

  list(): readonly CustomConfigProfile[] {
    return [...this.#profiles];
  }

  get(profileId: string): CustomConfigProfile | undefined {
    return this.#profiles.find((profile) => profile.id === profileId);
  }

  async detectAll(
    projectRoot: string,
    reader: EngineeringWorkspaceReader,
  ): Promise<readonly CustomConfigProfileMatch[]> {
    const matches: CustomConfigProfileMatch[] = [];
    for (const profile of this.#profiles) {
      if (await hasAntiMarker(projectRoot, reader, profile)) {
        continue;
      }
      if (await markersMatch(projectRoot, reader, profile)) {
        matches.push({
          profile,
          confidence: profile.confidence,
          reason: `${profile.displayName} detected (${profile.markers.join(", ")})`,
        });
      }
    }
    return matches.sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.profile.displayName.localeCompare(right.profile.displayName),
    );
  }
}

async function hasAntiMarker(
  projectRoot: string,
  reader: EngineeringWorkspaceReader,
  profile: CustomConfigProfile,
): Promise<boolean> {
  for (const marker of profile.antiMarkers ?? []) {
    if (await markerExists(projectRoot, reader, marker)) {
      return true;
    }
  }
  return false;
}

async function markersMatch(
  projectRoot: string,
  reader: EngineeringWorkspaceReader,
  profile: CustomConfigProfile,
): Promise<boolean> {
  const strategy = profile.markerStrategy ?? "all";
  const checks = await Promise.all(
    profile.markers.map(async (marker) => markerExists(projectRoot, reader, marker)),
  );
  return strategy === "any" ? checks.some(Boolean) : checks.every(Boolean);
}

async function markerExists(
  projectRoot: string,
  reader: EngineeringWorkspaceReader,
  marker: string,
): Promise<boolean> {
  const filePath = path.join(projectRoot, marker.replace(/[/\\]+$/, ""));
  const stat = await reader.stat(filePath).catch(() => null);
  if (stat === null) {
    return false;
  }
  return marker.endsWith("/") ? stat.isDirectory : stat.isFile || stat.isDirectory;
}
