import path from "node:path";
import { MainlineWriteBoundaryError } from "./Errors.js";

/**
 * MainlinePathScope 表示一个只读/写入边界的纯路径范围。
 * 它统一替代散落的 startsWith 判断，避免 `/tmp/app2` 被误判为 `/tmp/app` 子路径。
 */
export class MainlinePathScope {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  contains(targetPath: string): boolean {
    const resolved = path.resolve(targetPath);
    return resolved === this.root || resolved.startsWith(`${this.root}${path.sep}`);
  }

  resolve(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new MainlineWriteBoundaryError("PathScope requires a relative path.", {
        root: this.root,
        relativePath,
      });
    }

    const resolved = path.resolve(this.root, relativePath);
    this.assertInside(resolved);
    return resolved;
  }

  assertInside(targetPath: string): void {
    if (!this.contains(targetPath)) {
      throw new MainlineWriteBoundaryError("Path escaped mainline scope.", {
        root: this.root,
        targetPath,
      });
    }
  }
}
