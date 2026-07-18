import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceMetadataCache } from "../src/main/workspace-cache.js";
import { WorkspaceClient } from "../src/main/workspace-client.js";
import type { WorkspaceProfile } from "../src/main/workspace-types.js";

const profile: WorkspaceProfile = {
  id: "profile-1",
  name: "AWS",
  serverUrl: "https://cloud.example",
  authenticationRef: "os-credential:profile-1",
  serverIdentity: null,
  lastSync: null,
  connectionState: "offline",
};
const body = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

function metadataFetch(online = true) {
  return vi.fn(async (input: string | URL | Request) => {
    if (!online) throw new Error("offline");
    const url = String(input);
    if (url.endsWith("/api/workspace/identity")) return body({ workspace_id: "workspace-a" });
    if (url.endsWith("/api/projects")) return body([{ id: 1, title: "ASD Study" }]);
    if (url.endsWith("/api/projects/1/datasets")) return body([{ id: 1 }]);
    if (url.endsWith("/api/datasets")) return body([{ id: 1, name: "Dataset" }]);
    if (url.endsWith("/api/workflows")) return body([{ id: 3, name: "Structural", dataset_id: 1 }]);
    if (url.endsWith("/api/workflows/3")) return body({
      id: 3, name: "Structural", dataset_id: 1, state: { nodes: [{ id: "fastsurfer" }] },
    });
    if (url.endsWith("/api/runs")) return body([{
      id: 7, dataset_id: 1, pipeline_manifest_id: "fastsurfer", pipeline_version: "1",
      status: "success", created_at: "2026-07-15T00:00:00Z",
    }]);
    if (url.endsWith("/api/runs/7")) return body({
      id: 7, dataset_id: 1, pipeline_manifest_id: "fastsurfer", pipeline_version: "1",
      status: "success", created_at: "2026-07-15T00:00:00Z", params: { subject: "01" },
    });
    if (url.endsWith("/api/runs/7/sync-manifest")) return body({
      runId: 7, provenance: {}, methods: {}, reports: [], artifacts: [],
    });
    if (url.includes("/reports")) return body([]);
    return body({});
  });
}

describe("workspace metadata synchronization", () => {
  it("builds stable remote identities and preserves workflow metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nf-workspace-"));
    const client = new WorkspaceClient(
      new WorkspaceMetadataCache(path.join(root, "metadata")),
      path.join(root, "artifacts"),
      metadataFetch() as typeof fetch,
    );
    const result = await client.synchronize(profile, { username: "u", password: "p" });
    expect(result.online).toBe(true);
    expect(result.snapshot.projects[0].remoteKey).toBe("workspace-a:project:1");
    expect(result.snapshot.workflows[0].state).toEqual({ nodes: [{ id: "fastsurfer" }] });
    expect(result.snapshot.runs[0]).toMatchObject({
      remoteKey: "workspace-a:run:7",
      cacheState: "cloud-only",
      cachedArtifacts: [],
    });
  });

  it("returns cached metadata with offline states when the server disappears", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nf-workspace-"));
    const cache = new WorkspaceMetadataCache(path.join(root, "metadata"));
    const online = new WorkspaceClient(cache, path.join(root, "artifacts"), metadataFetch() as typeof fetch);
    await online.synchronize(profile, null);
    const offline = new WorkspaceClient(cache, path.join(root, "artifacts"), metadataFetch(false) as typeof fetch);
    const result = await offline.synchronize(profile, null);
    expect(result.online).toBe(false);
    expect(result.snapshot.runs[0].cacheState).toBe("server-unavailable");
  });

  it("downloads only requested artifacts and reuses verified cache files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nf-workspace-"));
    const content = "volume";
    const checksum = createHash("sha256").update(content).digest("hex");
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/sync-manifest")) return body({
        runId: 7, provenance: {}, methods: {}, reports: [], artifacts: [
          { artifactId: 1, relativePath: "mri/orig_nu.mgz", url: "/api/file/one", sha256: checksum, sizeBytes: 6 },
          { artifactId: 2, relativePath: "mri/other.mgz", url: "/api/file/two", sha256: checksum, sizeBytes: 6 },
        ],
      });
      return new Response(content);
    });
    const client = new WorkspaceClient(
      new WorkspaceMetadataCache(path.join(root, "metadata")),
      path.join(root, "artifacts"),
      fetcher as typeof fetch,
    );
    const first = await client.syncArtifacts(profile, null, "workspace-a", 7, ["mri/orig_nu.mgz"]);
    const second = await client.syncArtifacts(profile, null, "workspace-a", 7, ["mri/orig_nu.mgz"]);
    expect(first.downloaded).toEqual(["mri/orig_nu.mgz"]);
    expect(second.reused).toEqual(["mri/orig_nu.mgz"]);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/api/file/")).length).toBe(1);
  });
});
