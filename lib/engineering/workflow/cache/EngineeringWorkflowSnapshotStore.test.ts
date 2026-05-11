import { describe, expect, it } from "vitest";
import {
  InMemoryEngineeringWorkflowSnapshotStore,
  JsonSerializableEngineeringWorkflowSnapshotStore,
} from "./EngineeringWorkflowSnapshotStore.js";

describe("EngineeringWorkflowSnapshotStore", () => {
  it("prunes old snapshots using the legacy capacity policy", () => {
    let tick = 0;
    const store = new InMemoryEngineeringWorkflowSnapshotStore({
      capacity: 2,
      idFactory: () => `snap_${tick}`,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    });

    store.writeSnapshot({
      projectRoot: "/repo",
      allFiles: [{ relativePath: "src/a.ts", content: "1" }],
    });
    store.writeSnapshot({
      projectRoot: "/repo",
      allFiles: [{ relativePath: "src/a.ts", content: "2" }],
    });
    const third = store.writeSnapshot({
      projectRoot: "/repo",
      allFiles: [{ relativePath: "src/a.ts", content: "3" }],
    });

    expect(store.listSnapshots("/repo").map((snapshot) => snapshot.id)).toEqual([
      "snap_2",
      "snap_1",
    ]);
    expect(third.prunedIds).toEqual(["snap_0"]);
    expect(third.diagnostics.map((diagnostic) => diagnostic.code)).toContain("capacity_pruned");
  });

  it("round-trips snapshots through a JSON-serializable document", () => {
    const store = new JsonSerializableEngineeringWorkflowSnapshotStore(undefined, {
      idFactory: () => "snap_json",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    store.writeSnapshot({
      projectRoot: "/repo",
      allFiles: [{ relativePath: "src/a.ts", content: "same" }],
      dimensionStats: {
        "code-standard": {
          referencedFilesList: ["src/a.ts"],
        },
      },
    });

    const document = JSON.stringify(store.toJSON());
    const loaded = JsonSerializableEngineeringWorkflowSnapshotStore.fromJSON(document);

    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.store.readLatest("/repo").snapshot?.id).toBe("snap_json");
    expect(loaded.store.readLatest("/repo").snapshot?.dimensionMeta["code-standard"]).toMatchObject(
      {
        referencedFiles: 1,
        referencedFilesList: ["src/a.ts"],
      },
    );
  });
});
