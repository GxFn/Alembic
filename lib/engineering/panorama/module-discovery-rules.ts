import path from "node:path";
import type { EngineeringDependencyNode } from "../foundation/types.js";
import { EngineeringLanguageProfiles } from "../language/profiles.js";
import { EngineeringLanguageService } from "../language/service.js";
import { isLikelyThirdPartyEngineeringPath } from "../workspace/paths.js";

const HOST_TARGET_TYPES = new Set(["app", "application", "host", "executable"]);
const RESOURCE_DIRS = new Set([
  "assets",
  "generated",
  "public",
  "res",
  "resource",
  "resources",
  "static",
]);
const RESOURCE_SUFFIXES = [
  ".appiconset",
  ".bundle",
  ".framework",
  ".imageset",
  ".lproj",
  ".playground",
  ".storyboard",
  ".xcassets",
  ".xcodeproj",
  ".xcworkspace",
  ".xib",
];
const CONFIG_EXTS = new Set([".json", ".toml", ".yaml", ".yml"]);
const DOC_EXTS = new Set([".md", ".mdx", ".rst"]);

export const SOURCE_WRAPPER_DIRS = new Set(["source", "sources", "src", "lib"]);
export const TEST_WRAPPER_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs"]);

/** Panorama 模块发现只消费能表达工程边界的文件，资源包和三方目录在这里统一过滤。 */
export function shouldUseModuleDiscoveryFile(relativePath: string): boolean {
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.some((segment) => segment.startsWith("."))) {
    return false;
  }
  if (segments.some((segment) => EngineeringLanguageProfiles.skipDirs.has(segment))) {
    return false;
  }
  if (isLikelyThirdPartyEngineeringPath(relativePath)) {
    return false;
  }
  if (segments.some((segment) => EngineeringLanguageProfiles.vendorDirs.has(segment))) {
    return false;
  }
  if (segments.some((segment) => RESOURCE_DIRS.has(segment.toLowerCase()))) {
    return false;
  }
  if (segments.some((segment) => RESOURCE_SUFFIXES.some((suffix) => segment.endsWith(suffix)))) {
    return false;
  }
  return isSourceLike(relativePath) || isDocFile(relativePath) || isConfigFile(relativePath);
}

export function inferModuleRole(
  name: string,
  node: EngineeringDependencyNode | undefined,
  configLayer: string | undefined,
): string {
  const configRole = EngineeringLanguageProfiles.roleForConfigLayer(configLayer);
  if (configRole) {
    return configRole;
  }
  const typeText = `${node?.type ?? ""} ${node?.targetType ?? ""} ${node?.conventionRole ?? ""}`;
  if (/\b(app|application|executable|host)\b/i.test(typeText)) {
    return "app";
  }
  if (
    /\b(framework|library|package)\b/i.test(typeText) &&
    /common|core|foundation|shared/i.test(name)
  ) {
    return "core";
  }
  const normalized = name.split("/").at(-1) ?? name;
  for (const rule of ROLE_RULES) {
    if (rule.regex.test(normalized)) {
      return rule.role;
    }
  }
  return "core";
}

export function isHostNode(node: EngineeringDependencyNode): boolean {
  const type = String(node.targetType ?? node.type ?? node.nodeType ?? "").toLowerCase();
  if (HOST_TARGET_TYPES.has(type)) {
    return true;
  }
  return (node.tags ?? []).some((tag) => HOST_TARGET_TYPES.has(tag.toLowerCase()));
}

export function isExternalNode(node: EngineeringDependencyNode): boolean {
  return node.type === "external" || node.type === "remote" || node.indirect === true;
}

export function isExternalDependencyName(name: string): boolean {
  return (
    name.startsWith("@") ||
    /^[a-z0-9_.-]+$/i.test(name) ||
    name.includes(".") ||
    EngineeringLanguageProfiles.knownLibraries[name.toLowerCase()] !== undefined
  );
}

export function normalizeImportPackage(specifier: string): string {
  if (specifier.startsWith("package:")) {
    return specifier.slice("package:".length).split("/")[0] ?? specifier;
  }
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  if (/^[A-Z]\w+$/.test(specifier)) {
    return specifier;
  }
  return specifier.split("/")[0] ?? specifier;
}

export function isResourceWrapperDir(segment: string): boolean {
  return RESOURCE_DIRS.has(segment.toLowerCase());
}

export function isVendorDir(segment: string): boolean {
  return EngineeringLanguageProfiles.vendorDirs.has(segment);
}

export function isSourceLike(filePath: string): boolean {
  return EngineeringLanguageService.sourceExts.has(path.extname(filePath).toLowerCase());
}

export function isDocFile(filePath: string): boolean {
  return DOC_EXTS.has(path.extname(filePath).toLowerCase());
}

export function isConfigFile(filePath: string): boolean {
  return CONFIG_EXTS.has(path.extname(filePath).toLowerCase());
}

const ROLE_RULES: readonly { readonly regex: RegExp; readonly role: string }[] = [
  { regex: /^(app|main|host|launcher|entry)$/i, role: "app" },
  { regex: /app(delegate)?|scene(delegate)?|launcher|bootstrap/i, role: "app" },
  { regex: /^(common|core|foundation|base|shared)$/i, role: "core" },
  { regex: /framework|sdk|kit/i, role: "core" },
  { regex: /ui|view|screen|page|component|widget/i, role: "ui" },
  { regex: /router|route|navigation|coordinator/i, role: "routing" },
  { regex: /network|api|http|client/i, role: "networking" },
  { regex: /service|manager|provider|interactor|usecase/i, role: "service" },
  { regex: /repository|store|storage|database|cache|dao/i, role: "storage" },
  { regex: /model|entity|dto|schema/i, role: "model" },
  { regex: /auth|oauth|login|session/i, role: "auth" },
  { regex: /config|setting|environment/i, role: "config" },
  { regex: /test|spec|mock|fixture/i, role: "test" },
  { regex: /feature|module/i, role: "feature" },
];
