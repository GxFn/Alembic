import fs from "node:fs";
import path from "node:path";
import {
  detectEngineeringKnowledgeBaseDir,
  engineeringPathContains,
  normalizeEngineeringRelativePath,
} from "./model.js";

export interface EngineeringProjectExclusion {
  readonly excluded: boolean;
  readonly reason: string;
}

export interface EngineeringPathGuardOptions {
  readonly projectRoot: string;
  readonly packageRoot?: string;
  readonly knowledgeBaseDir?: string;
  readonly extraAllowPaths?: readonly string[];
  readonly excludedProject?: EngineeringProjectExclusion;
}

export class EngineeringPathGuardError extends Error {
  readonly projectRoot: string;
  readonly targetPath: string;

  constructor(targetPath: string, projectRoot: string, reason?: string) {
    const message = reason
      ? `[EngineeringPathGuard] ${reason}: "${targetPath}"`
      : `[EngineeringPathGuard] 写入路径越界: "${targetPath}" 不在允许范围内。`;
    super(
      `${message}\n  projectRoot: ${projectRoot}\n  提示: 检查 projectRoot、dataRoot 或写入目标是否正确。`,
    );
    this.name = "EngineeringPathGuardError";
    this.projectRoot = projectRoot;
    this.targetPath = targetPath;
  }
}

// 写边界说明：
// assertSafe 只守住项目根、包根和显式 allowList 的绝对边界；
// assertProjectWriteSafe 进一步限制“在用户项目内新建/写入”的位置，只允许 Alembic
// 运行时目录、知识库目录、IDE 配置目录和少量根配置文件，避免误写 src/data 等业务目录。
const PROJECT_WRITE_SCOPE_PREFIXES = [".asd", ".cursor", ".vscode", ".github"] as const;
const PROJECT_ROOT_WRITABLE_FILES = [".gitignore", ".env"] as const;

export class EngineeringPathGuard {
  readonly #projectRoot: string;
  readonly #packageRoot: string | null;
  readonly #allowList: readonly string[];
  readonly #knowledgeBaseDir: string | null;
  readonly #excludedProject: EngineeringProjectExclusion;

  constructor(options: EngineeringPathGuardOptions) {
    if (!path.isAbsolute(options.projectRoot)) {
      throw new Error(
        `[EngineeringPathGuard] projectRoot must be absolute, received "${options.projectRoot}"`,
      );
    }

    this.#projectRoot = path.resolve(options.projectRoot);
    this.#packageRoot = options.packageRoot ? path.resolve(options.packageRoot) : null;
    this.#allowList = (options.extraAllowPaths ?? [])
      .filter((candidate) => path.isAbsolute(candidate))
      .map((candidate) => path.resolve(candidate));
    this.#knowledgeBaseDir = options.knowledgeBaseDir ?? null;
    this.#excludedProject =
      options.excludedProject ?? inspectEngineeringExcludedProject(this.#projectRoot);
  }

  get projectRoot(): string {
    return this.#projectRoot;
  }

  get excludedProject(): EngineeringProjectExclusion {
    return this.#excludedProject;
  }

  assertSafe(targetPath: string): void {
    if (!targetPath) {
      throw new EngineeringPathGuardError(String(targetPath), this.#projectRoot);
    }

    const resolved = path.resolve(targetPath);
    if (engineeringPathContains(resolved, this.#projectRoot)) {
      return;
    }
    if (this.#packageRoot && engineeringPathContains(resolved, this.#packageRoot)) {
      return;
    }
    if (this.#allowList.some((allowedPath) => engineeringPathContains(resolved, allowedPath))) {
      return;
    }

    throw new EngineeringPathGuardError(resolved, this.#projectRoot);
  }

  assertProjectWriteSafe(targetPath: string): void {
    this.assertSafe(targetPath);

    const resolved = path.resolve(targetPath);
    if (!engineeringPathContains(resolved, this.#projectRoot)) {
      return;
    }

    const relative = normalizeEngineeringRelativePath(path.relative(this.#projectRoot, resolved));
    const firstSegment = relative.split("/").filter(Boolean)[0] ?? "";
    const knowledgeBaseDir = this.#resolveKnowledgeBaseDir();

    if (this.#excludedProject.excluded) {
      if (firstSegment === ".asd") {
        throw new EngineeringPathGuardError(
          resolved,
          this.#projectRoot,
          `排除项目保护 (${this.#excludedProject.reason}): 禁止创建 .asd/ 运行时数据`,
        );
      }
      if (firstSegment === knowledgeBaseDir) {
        throw new EngineeringPathGuardError(
          resolved,
          this.#projectRoot,
          `排除项目保护 (${this.#excludedProject.reason}): 禁止创建 ${knowledgeBaseDir}/ 知识库数据`,
        );
      }
      if (isIdeScope(firstSegment) || isProjectRootWritableFile(relative)) {
        return;
      }
      throw new EngineeringPathGuardError(
        resolved,
        this.#projectRoot,
        `排除项目保护 (${this.#excludedProject.reason}): "${relative}" 不在允许范围内`,
      );
    }

    if (
      PROJECT_WRITE_SCOPE_PREFIXES.includes(
        firstSegment as (typeof PROJECT_WRITE_SCOPE_PREFIXES)[number],
      ) ||
      firstSegment === knowledgeBaseDir ||
      isProjectRootWritableFile(relative)
    ) {
      return;
    }

    throw new EngineeringPathGuardError(
      resolved,
      this.#projectRoot,
      `项目内写入范围受限: "${relative}" 不在允许的目录中（允许: ${[
        ...PROJECT_WRITE_SCOPE_PREFIXES,
        knowledgeBaseDir,
      ].join(", ")}）`,
    );
  }

  isSafe(targetPath: string): boolean {
    try {
      this.assertSafe(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  isProjectWriteSafe(targetPath: string): boolean {
    try {
      this.assertProjectWriteSafe(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  #resolveKnowledgeBaseDir(): string {
    return this.#knowledgeBaseDir ?? detectEngineeringKnowledgeBaseDir(this.#projectRoot);
  }
}

export function inspectEngineeringExcludedProject(
  projectRoot: string,
): EngineeringProjectExclusion {
  const resolved = path.resolve(projectRoot);
  if (isEngineeringAlembicDevRepo(resolved)) {
    return { excluded: true, reason: "Alembic 源码开发仓库" };
  }
  if (isEngineeringAlembicEcosystemRepo(resolved)) {
    return { excluded: true, reason: "Alembic 生态项目" };
  }
  if (fs.existsSync(path.join(resolved, ".asd-skip"))) {
    return { excluded: true, reason: "项目包含 .asd-skip 标记" };
  }
  return { excluded: false, reason: "" };
}

function isIdeScope(firstSegment: string): boolean {
  return firstSegment === ".cursor" || firstSegment === ".vscode" || firstSegment === ".github";
}

function isProjectRootWritableFile(relativePath: string): boolean {
  return PROJECT_ROOT_WRITABLE_FILES.includes(
    relativePath as (typeof PROJECT_ROOT_WRITABLE_FILES)[number],
  );
}

function isEngineeringAlembicDevRepo(projectRoot: string): boolean {
  const packageName = readPackageName(projectRoot);
  return (
    packageName === "alembic-ai" &&
    fs.existsSync(path.join(projectRoot, "lib", "bootstrap.ts")) &&
    fs.existsSync(path.join(projectRoot, "SOUL.md"))
  );
}

function isEngineeringAlembicEcosystemRepo(projectRoot: string): boolean {
  const packageName = readPackageName(projectRoot);
  return typeof packageName === "string" && packageName.startsWith("alembic-");
}

function readPackageName(projectRoot: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(projectRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}
