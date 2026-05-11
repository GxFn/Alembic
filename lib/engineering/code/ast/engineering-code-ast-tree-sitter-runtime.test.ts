import { beforeAll, describe, expect, it } from "vitest";
import {
  analyzeFile,
  analyzeProject,
  initializeTreeSitterRuntime,
  isAvailable,
  parseToTree,
  supportedLanguages,
} from "../tree-sitter/index.js";

describe("EngineeringCode tree-sitter runtime", () => {
  beforeAll(async () => {
    await initializeTreeSitterRuntime();
  });

  it("initializes parser grammars and parses TSX roots", () => {
    expect(isAvailable()).toBe(true);
    expect(supportedLanguages()).toEqual([
      "dart",
      "go",
      "java",
      "javascript",
      "kotlin",
      "objectivec",
      "python",
      "rust",
      "swift",
      "tsx",
      "typescript",
    ]);

    const parsed = parseToTree("export const View = () => <Panel />;", "tsx", {
      filePath: "src/View.tsx",
    });

    expect(parsed?.rootNode.type).toBe("program");
  });

  it("analyzes TypeScript facts through the engineering AST normalizer", () => {
    const summary = analyzeFile({
      filePath: "src/UserService.ts",
      source: `
        import type { UserRepo } from "./repo";
        export interface RepoLike { save(): Promise<void>; }
        export class UserService extends BaseService implements RepoLike {
          constructor(private readonly repo: UserRepo) {}
          async sync(user: User) {
            await this.repo.save(user);
            return new UserResult(user.id);
          }
        }
      `,
    });

    expect(summary?.languageId).toBe("typescript");
    expect(summary?.imports).toContainEqual(
      expect.objectContaining({
        path: "./repo",
        kind: "named",
        symbols: ["UserRepo"],
        isTypeOnly: true,
      }),
    );
    expect(summary?.classes).toContainEqual(
      expect.objectContaining({
        name: "UserService",
        superclass: "BaseService",
        protocols: ["RepoLike"],
      }),
    );
    expect(summary?.protocols).toContainEqual(expect.objectContaining({ name: "RepoLike" }));
    expect(summary?.methods).toContainEqual(
      expect.objectContaining({ name: "sync", className: "UserService" }),
    );
    expect(summary?.properties).toContainEqual(
      expect.objectContaining({ name: "repo", className: "UserService", type: "UserRepo" }),
    );
    expect(summary?.callSites).toContainEqual(
      expect.objectContaining({
        callee: "save",
        callerClass: "UserService",
        callerMethod: "sync",
        receiver: "this.repo",
        isAwait: true,
      }),
    );
    expect(summary?.callSites).toContainEqual(
      expect.objectContaining({
        callee: "UserResult",
        callType: "constructor",
        receiverType: "UserResult",
      }),
    );
  });

  it("analyzes JavaScript and Python files as a project summary", () => {
    const project = analyzeProject([
      {
        relativePath: "src/events.js",
        content: `
          import { createWidget } from "./widget.js";
          export class EventBus {
            constructor(repo) { this.repo = repo; }
            emitAll(user) {
              this.repo.save(user);
              return createWidget(user);
            }
          }
        `,
      },
      {
        relativePath: "tools/worker.py",
        content: `
          from app.repo import Repo

          class Worker(BaseModel):
              VERSION = "1"
              def run(self, user):
                  return self.repo.save(User(user.id))
        `,
      },
    ]);

    expect(project.fileSummaries).toHaveLength(2);
    expect(project.fileSummaries[0]?.classes).toContainEqual(
      expect.objectContaining({ name: "EventBus" }),
    );
    expect(project.fileSummaries[0]?.properties).toContainEqual(
      expect.objectContaining({ name: "repo", className: "EventBus" }),
    );
    expect(project.fileSummaries[0]?.callSites).toContainEqual(
      expect.objectContaining({ callee: "save", receiver: "this.repo" }),
    );
    expect(project.fileSummaries[1]?.classes).toContainEqual(
      expect.objectContaining({ name: "Worker", superclass: "BaseModel" }),
    );
    expect(project.fileSummaries[1]?.imports).toContainEqual(
      expect.objectContaining({ path: "app.repo", symbols: ["Repo"] }),
    );
    expect(project.fileSummaries[1]?.callSites).toContainEqual(
      expect.objectContaining({ callee: "save", receiver: "self.repo" }),
    );
  });
});
