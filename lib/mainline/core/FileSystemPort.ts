import fs from "node:fs/promises";
import path from "node:path";

export interface MainlineDirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

export interface MainlineFileSystemPort {
  exists(path: string): Promise<boolean>;
  mkdirp(path: string, options?: { mode?: number }): Promise<void>;
  readText(path: string): Promise<string>;
  readTextOrNull(path: string): Promise<string | null>;
  writeFile(path: string, data: string | Buffer, options?: { mode?: number }): Promise<void>;
  appendFile(path: string, data: string | Buffer, options?: { mode?: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  list(path: string): Promise<MainlineDirectoryEntry[]>;
}

/**
 * NodeMainlineFileSystem 是新主线的真实文件系统 adapter。
 * 它只封装基础 IO，不做 PathGuard、业务路径或旧 workspace 解析。
 */
export class NodeMainlineFileSystem implements MainlineFileSystemPort {
  async exists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  async mkdirp(targetPath: string, options: { mode?: number } = {}): Promise<void> {
    await fs.mkdir(targetPath, { recursive: true, mode: options.mode });
  }

  async readText(targetPath: string): Promise<string> {
    return fs.readFile(targetPath, "utf8");
  }

  async readTextOrNull(targetPath: string): Promise<string | null> {
    try {
      return await this.readText(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async writeFile(
    targetPath: string,
    data: string | Buffer,
    options: { mode?: number } = {},
  ): Promise<void> {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, data, { mode: options.mode });
  }

  async appendFile(
    targetPath: string,
    data: string | Buffer,
    _options: { mode?: number } = {},
  ): Promise<void> {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.appendFile(targetPath, data);
  }

  async rename(from: string, to: string): Promise<void> {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
  }

  async remove(targetPath: string, options: { recursive?: boolean } = {}): Promise<void> {
    await fs.rm(targetPath, { force: true, recursive: options.recursive ?? false });
  }

  async list(targetPath: string): Promise<MainlineDirectoryEntry[]> {
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      path: path.join(targetPath, entry.name),
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    }));
  }
}
