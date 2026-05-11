import path from "node:path";
import { EngineeringLanguageProfiles } from "../language/EngineeringLanguageProfiles.js";
import { EngineeringLanguageService } from "../language/EngineeringLanguageService.js";

export function toEngineeringRelativePath(projectRoot: string, filePath: string): string {
  const relative = path.isAbsolute(filePath) ? path.relative(projectRoot, filePath) : filePath;
  return relative.split(path.sep).join("/");
}

export function engineeringModuleNameForPath(filePath: string): string {
  const segments = filePath.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return filePath.includes("/") ? (filePath.split("/")[0] ?? "(root)") : "(root)";
  }
  if (["apps", "packages"].includes(segments[0] ?? "") && segments[1]) {
    return `${segments[0]}/${segments[1]}`;
  }
  if (["app", "lib", "src"].includes(segments[0] ?? "") && segments[1]) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0] ?? "(root)";
}

export function isEngineeringSourceFile(filePath: string): boolean {
  return EngineeringLanguageService.sourceExts.has(path.extname(filePath).toLowerCase());
}

export function isEngineeringTestFile(filePath: string): boolean {
  return EngineeringLanguageService.isTestFile(filePath);
}

export function isLikelyThirdPartyEngineeringPath(filePath: string): boolean {
  return EngineeringLanguageProfiles.thirdPartyPathRegex.test(filePath);
}
