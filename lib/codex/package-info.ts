import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PackageInfo {
  packageRoot: string;
  version: string;
}

export function findPackageRoot(startUrl = import.meta.url): string {
  let dir = dirname(fileURLToPath(startUrl));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return process.cwd();
}

export function readPackageInfo(): PackageInfo {
  const packageRoot = findPackageRoot();
  try {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      version?: string;
    };
    return { packageRoot, version: packageJson.version || "0.0.0" };
  } catch {
    return { packageRoot, version: "0.0.0" };
  }
}
