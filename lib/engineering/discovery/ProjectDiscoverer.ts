import path from "node:path";
import type {
  EngineeringDependencyGraph,
  EngineeringDetection,
  EngineeringDiscoverer,
  EngineeringFile,
  EngineeringTarget,
} from "../foundation/EngineeringCoreTypes.js";

export type {
  EngineeringDependencyEdge,
  EngineeringDependencyGraph,
  EngineeringDependencyGraphLayer,
  EngineeringDependencyNode,
  EngineeringDetection,
  EngineeringDiscoverer,
  EngineeringFile,
  EngineeringTarget,
} from "../foundation/EngineeringCoreTypes.js";

export interface EngineeringWorkspaceDirent {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

export interface EngineeringWorkspaceFileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly size: number;
}

export interface EngineeringWorkspaceReader {
  exists(filePath: string): Promise<boolean>;
  readText(filePath: string): Promise<string>;
  readDir(dirPath: string): Promise<readonly EngineeringWorkspaceDirent[]>;
  stat(filePath: string): Promise<EngineeringWorkspaceFileStat | null>;
}

export interface ProjectDiscovererOptions {
  readonly reader?: EngineeringWorkspaceReader;
}

export abstract class ProjectDiscoverer implements EngineeringDiscoverer {
  protected readonly reader: EngineeringWorkspaceReader;
  protected projectRoot: string | null = null;

  protected constructor(options: ProjectDiscovererOptions = {}) {
    this.reader = options.reader ?? new NodeEngineeringWorkspaceReader();
  }

  get workspaceReader(): EngineeringWorkspaceReader {
    return this.reader;
  }

  abstract readonly id: string;
  abstract readonly displayName: string;

  abstract detect(projectRoot: string): Promise<EngineeringDetection>;
  abstract load(projectRoot: string): Promise<void>;
  abstract listTargets(): Promise<readonly EngineeringTarget[]>;
  abstract getTargetFiles(target: EngineeringTarget | string): Promise<readonly EngineeringFile[]>;
  abstract getDependencyGraph(): Promise<EngineeringDependencyGraph>;

  protected resolve(...parts: readonly string[]): string {
    return path.resolve(...parts);
  }

  protected join(...parts: readonly string[]): string {
    return path.join(...parts);
  }

  protected async exists(...parts: readonly string[]): Promise<boolean> {
    try {
      return await this.reader.exists(path.join(...parts));
    } catch {
      return false;
    }
  }

  protected async readText(...parts: readonly string[]): Promise<string | null> {
    try {
      return await this.reader.readText(path.join(...parts));
    } catch {
      return null;
    }
  }

  protected async readJson(filePath: string): Promise<Record<string, unknown> | null> {
    const content = await this.readText(filePath);
    if (content === null) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(content);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  protected async readDir(
    ...parts: readonly string[]
  ): Promise<readonly EngineeringWorkspaceDirent[]> {
    try {
      return await this.reader.readDir(path.join(...parts));
    } catch {
      return [];
    }
  }

  protected async stat(...parts: readonly string[]): Promise<EngineeringWorkspaceFileStat | null> {
    try {
      return await this.reader.stat(path.join(...parts));
    } catch {
      return null;
    }
  }
}

class NodeEngineeringWorkspaceReader implements EngineeringWorkspaceReader {
  async exists(filePath: string): Promise<boolean> {
    const fs = await import("node:fs/promises");
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async readText(filePath: string): Promise<string> {
    const fs = await import("node:fs/promises");
    return fs.readFile(filePath, "utf8");
  }

  async readDir(dirPath: string): Promise<readonly EngineeringWorkspaceDirent[]> {
    const fs = await import("node:fs/promises");
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    }));
  }

  async stat(filePath: string): Promise<EngineeringWorkspaceFileStat | null> {
    const fs = await import("node:fs/promises");
    try {
      const stat = await fs.stat(filePath);
      return { isFile: stat.isFile(), isDirectory: stat.isDirectory(), size: stat.size };
    } catch {
      return null;
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
