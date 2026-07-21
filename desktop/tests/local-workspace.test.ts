import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalWorkspaceStore, localResourceKey } from "../src/main/local-workspace.js";

describe("LocalWorkspaceStore", () => {
  it("creates a stable persisted identity with private permissions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "neuroforge-local-workspace-"));
    const store = new LocalWorkspaceStore(root, () => "5df1dc24-a857-4adf-8908-1f8a7f36d058");
    const first = await store.get();
    const second = await new LocalWorkspaceStore(root).get();
    expect(first.workspaceId).toBe("local-5df1dc24-a857-4adf-8908-1f8a7f36d058");
    expect(second).toEqual(first);
    expect(JSON.parse(await readFile(store.filePath, "utf8"))).toEqual(first);
  });

  it("namespaces local IDs without changing them", () => {
    expect(localResourceKey("local-5df1dc24-a857-4adf-8908-1f8a7f36d058", "run", 7))
      .toBe("local-5df1dc24-a857-4adf-8908-1f8a7f36d058:run:7");
  });

  it("rejects malformed identities and resource types", () => {
    expect(() => localResourceKey("cloud", "run", 7)).toThrow("Invalid local workspace");
    expect(() => localResourceKey("local-5df1dc24-a857-4adf-8908-1f8a7f36d058", "../run", 7))
      .toThrow("Invalid local resource");
  });
});
