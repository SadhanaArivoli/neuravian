import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceSnapshot } from "./workspace-types.js";

export class WorkspaceMetadataCache {
  constructor(private readonly root: string) {}

  pathFor(profileId: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(profileId)) throw new Error("Invalid workspace profile ID.");
    return path.join(this.root, profileId, "metadata.json");
  }

  async read(profileId: string): Promise<WorkspaceSnapshot | null> {
    try {
      const parsed = JSON.parse(await readFile(this.pathFor(profileId), "utf8")) as WorkspaceSnapshot;
      return parsed.schemaVersion === 1 ? parsed : null;
    } catch {
      return null;
    }
  }

  async write(snapshot: WorkspaceSnapshot): Promise<void> {
    const target = this.pathFor(snapshot.profileId);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }
}
