import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface LocalWorkspaceIdentity {
  schemaVersion: 1;
  workspaceId: string;
  createdAt: string;
}

const FILE_NAME = "local-workspace.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function localResourceKey(workspaceId: string, resourceType: string, localId: string | number): string {
  if (!workspaceId.startsWith("local-") || !UUID.test(workspaceId.slice(6))) {
    throw new Error("Invalid local workspace identity.");
  }
  if (!/^[a-z][a-z0-9-]*$/.test(resourceType)) throw new Error("Invalid local resource type.");
  return `${workspaceId}:${resourceType}:${String(localId)}`;
}

export class LocalWorkspaceStore {
  readonly filePath: string;

  constructor(private readonly root: string, private readonly uuid = randomUUID) {
    this.filePath = path.join(root, FILE_NAME);
  }

  async get(): Promise<LocalWorkspaceIdentity> {
    const existing = await this.read();
    if (existing) return existing;
    await mkdir(this.root, { recursive: true });
    const identity: LocalWorkspaceIdentity = {
      schemaVersion: 1,
      workspaceId: `local-${this.uuid()}`,
      createdAt: new Date().toISOString(),
    };
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
    return identity;
  }

  private async read(): Promise<LocalWorkspaceIdentity | null> {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as LocalWorkspaceIdentity;
      if (value.schemaVersion !== 1 || !value.workspaceId.startsWith("local-") ||
          !UUID.test(value.workspaceId.slice(6)) || !value.createdAt) {
        throw new Error("Local workspace identity file is invalid.");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
