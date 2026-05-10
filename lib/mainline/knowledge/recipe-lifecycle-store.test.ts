import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MainlineWorkspacePaths, MainlineWriteBoundary } from "../core/index.js";
import { createRecipe, type Recipe } from "./Recipe.js";
import { createRecipeKnowledgePayload } from "./RecipeKnowledgePayload.js";
import { RecipeLifecycleStore } from "./RecipeLifecycleStore.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("RecipeLifecycleStore", () => {
  it("writes candidates without exposing them to the default active list", async () => {
    const root = await makeTempRoot();
    const store = makeStore(root);

    const record = await store.writeCandidate(recipe("candidate-cache-policy"), {
      now: 10,
      submittedBy: "agent-a",
    });

    expect(record.status).toBe("candidate");
    expect(record.metadata).toMatchObject({ createdAt: 10, submittedBy: "agent-a" });
    expect(record.file?.relativePath).toMatch(/^Alembic[/\\]candidates[/\\]/);
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.list({ status: "candidate" })).resolves.toMatchObject([
      { id: "candidate-cache-policy", status: "candidate" },
    ]);
  });

  it("publishes a candidate into active recipes and removes the draft boundary file", async () => {
    const root = await makeTempRoot();
    const store = makeStore(root);
    const candidate = await store.writeCandidate(recipe("recipe-event-bus"), { now: 20 });

    const active = await store.publish("recipe-event-bus", { now: 30, publishedBy: "reviewer" });

    expect(active.status).toBe("active");
    expect(active.recipe.status).toBe("active");
    expect(active.metadata).toMatchObject({
      createdAt: 20,
      publishedAt: 30,
      publishedBy: "reviewer",
    });
    expect(active.file?.relativePath).toMatch(/^Alembic[/\\]recipes[/\\]/);
    await expect(fs.stat(candidate.file?.absolutePath ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(store.list()).resolves.toMatchObject([
      { id: "recipe-event-bus", status: "active" },
    ]);
    await expect(store.list({ status: "candidate" })).resolves.toEqual([]);
  });

  it("rejects a candidate and keeps it out of the default active load path", async () => {
    const root = await makeTempRoot();
    const store = makeStore(root);
    await store.writeCandidate(recipe("recipe-old-wrapper"), { now: 40 });

    const rejected = await store.reject("recipe-old-wrapper", {
      now: 50,
      reason: "Too narrow for a project Recipe.",
      rejectedBy: "reviewer",
    });

    expect(rejected.status).toBe("rejected");
    expect(rejected.recipe.status).toBe("rejected");
    expect(rejected.file?.relativePath).toMatch(/^Alembic[/\\]candidates[/\\]/);
    expect(rejected.metadata).toMatchObject({
      rejectedAt: 50,
      rejectedBy: "reviewer",
      rejectionReason: "Too narrow for a project Recipe.",
    });
    await expect(store.load("recipe-old-wrapper")).resolves.toBeNull();
    await expect(store.load("recipe-old-wrapper", { status: "rejected" })).resolves.toMatchObject({
      id: "recipe-old-wrapper",
      status: "rejected",
    });
  });

  it("lists and filters lifecycle records deterministically", async () => {
    const root = await makeTempRoot();
    const store = makeStore(root);
    await store.writeCandidate(recipe("recipe-alpha"), { now: 1 });
    await store.writeCandidate(recipe("recipe-beta"), { now: 2 });
    await store.writeCandidate(recipe("recipe-gamma"), { now: 3 });
    await store.publish("recipe-beta", { now: 4 });
    await store.reject("recipe-gamma", { now: 5 });

    await expect(store.list()).resolves.toMatchObject([{ id: "recipe-beta", status: "active" }]);
    await expect(store.list({ status: ["candidate", "rejected"] })).resolves.toMatchObject([
      { id: "recipe-alpha", status: "candidate" },
      { id: "recipe-gamma", status: "rejected" },
    ]);
    await expect(store.list({ status: "all" })).resolves.toMatchObject([
      { id: "recipe-beta", status: "active" },
      { id: "recipe-alpha", status: "candidate" },
      { id: "recipe-gamma", status: "rejected" },
    ]);
    await expect(store.list({ status: "all", limit: 2 })).resolves.toHaveLength(2);
  });

  it("recovers lifecycle state after reconstructing the store over the same data root", async () => {
    const root = await makeTempRoot();
    const firstStore = makeStore(root);
    await firstStore.writeCandidate(recipe("recipe-survives-restart"), { now: 60 });
    await firstStore.writeCandidate(recipe("recipe-rejected-restart"), { now: 61 });
    await firstStore.publish("recipe-survives-restart", { now: 70 });
    await firstStore.reject("recipe-rejected-restart", { now: 71, reason: "Duplicate." });

    const restartedStore = makeStore(root);

    await expect(restartedStore.load("recipe-survives-restart")).resolves.toMatchObject({
      id: "recipe-survives-restart",
      status: "active",
      metadata: { createdAt: 60, publishedAt: 70 },
    });
    await expect(
      restartedStore.load("recipe-rejected-restart", { status: "rejected" }),
    ).resolves.toMatchObject({
      id: "recipe-rejected-restart",
      status: "rejected",
      metadata: { createdAt: 61, rejectedAt: 71, rejectionReason: "Duplicate." },
    });
  });
});

function makeStore(root: string): RecipeLifecycleStore {
  return new RecipeLifecycleStore(
    new MainlineWriteBoundary({
      workspacePaths: new MainlineWorkspacePaths({
        projectRoot: path.join(root, "project"),
        dataRoot: path.join(root, "ghost"),
      }),
    }),
  );
}

function recipe(id: string): Recipe {
  return createRecipe({
    id,
    title: titleFromId(id),
    kind: "pattern",
    status: "candidate",
    summary: `Use ${id} deliberately.`,
    trigger: id,
    dimensionIds: ["recipe-lifecycle"],
    confidence: 0.8,
    knowledge: createRecipeKnowledgePayload({
      language: "typescript",
      doClause: `Keep ${id} inside the lifecycle store boundary.`,
    }),
  });
}

function titleFromId(id: string): string {
  return id
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-recipe-lifecycle-"));
  tempRoots.push(root);
  return root;
}
