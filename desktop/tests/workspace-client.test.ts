import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceMetadataCache } from "../src/main/workspace-cache.js";
import { rebuildServerUrl, WorkspaceClient } from "../src/main/workspace-client.js";
import { WorkspaceReplicationEngine } from "../src/main/workspace-replication.js";
import type { WorkspaceProfile, WorkspaceSnapshot } from "../src/main/workspace-types.js";

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

function metadataFetch(online = true, runStatus = "success") {
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
      status: runStatus, created_at: "2026-07-15T00:00:00Z",
    }]);
    if (url.endsWith("/api/runs/7")) return body({
      id: 7, dataset_id: 1, pipeline_manifest_id: "fastsurfer", pipeline_version: "1",
      status: runStatus, created_at: "2026-07-15T00:00:00Z", params: { subject: "01" },
    });
    if (url.endsWith("/api/runs/7/sync-manifest")) return body({
      runId: 7, provenance: {}, methods: {},
      reports: [{ name: "sub-01", path: "sub-01.html" }],
      artifacts: [],
    });
    if (url.includes("/reports")) return body([{ id: 12, dataset_id: 1, status: "ready" }]);
    return body({});
  });
}

describe("workspace metadata synchronization", () => {
  it("routes legacy instance URLs through the public HTTPS gateway", () => {
    expect(rebuildServerUrl(
      "https://44-204-18-239.sslip.io:8000",
      "44-202-161-200.sslip.io",
    )).toBe("https://44-202-161-200.sslip.io");
  });
  it("tests identity and version using existing lightweight endpoints", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nf-workspace-"));
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/workspace/identity")) {
        return body({ workspace_id: "workspace-a", product: "Neuravian", api_version: "1" });
      }
      return body({ version: "0.1.0" });
    });
    const client = new WorkspaceClient(
      new WorkspaceMetadataCache(path.join(root, "metadata")),
      path.join(root, "artifacts"),
      fetcher as typeof fetch,
    );
    await expect(client.testConnection(profile, null)).resolves.toEqual({
      workspaceId: "workspace-a", product: "Neuravian", apiVersion: "1",
      serverVersion: "0.1.0",
    });
  });
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
      reports: [{ name: "sub-01", path: "sub-01.html" }],
    });
  });

  it("does not enumerate result artifacts while a cloud run is active", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nf-workspace-"));
    const fetcher = metadataFetch(true, "running");
    const client = new WorkspaceClient(
      new WorkspaceMetadataCache(path.join(root, "metadata")),
      path.join(root, "artifacts"),
      fetcher as typeof fetch,
    );
    const result = await client.synchronize(profile, null);
    expect(result.snapshot.runs[0].status).toBe("running");
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/api/runs/7/results"))).toBe(false);
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
    const replication = new WorkspaceReplicationEngine({
      artifactCacheRoot: path.join(root, "artifacts"),
      client,
      fetcher: fetcher as typeof fetch,
    });
    const first = await replication.syncArtifacts(profile, null, "workspace-a", 7, ["mri/orig_nu.mgz"]);
    const second = await replication.syncArtifacts(profile, null, "workspace-a", 7, ["mri/orig_nu.mgz"]);
    expect(first.downloaded).toEqual(["mri/orig_nu.mgz"]);
    expect(second.reused).toEqual(["mri/orig_nu.mgz"]);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/api/file/")).length).toBe(1);
  });
});

describe("workflow input handoff", () => {
  it("uploads only the required manifest artifact with checksum headers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nf-handoff-"));
    const payload = new TextEncoder().encode("brain-volume");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("handoff-manifest")) return body({ artifacts: [{ artifactId: "brain", relativePath: "brain.nii.gz", url: "/api/runs/8/files/brain.nii.gz", sha256, sizeBytes: payload.byteLength }] });
      if (url.endsWith("/api/workflow-executions/11111111-1111-1111-1111-111111111111/inputs")) return body([]);
      if (url.endsWith("/api/runs/8/files/brain.nii.gz")) return new Response(payload);
      if (url.endsWith("/inputs/brain") && init?.method === "PUT") {
        expect(new Headers(init.headers).get("X-Neuravian-Sha256")).toBe(sha256);
        expect(new Headers(init.headers).get("Authorization")).toMatch(/^Basic /);
        return body({ staged_path: "/cloud/inputs/brain.nii.gz" });
      }
      return body({}, 404);
    });
    const client = new WorkspaceClient(new WorkspaceMetadataCache(path.join(root, "metadata")), path.join(root, "artifacts"), fetcher as typeof fetch);
    const replication = new WorkspaceReplicationEngine({ artifactCacheRoot: root, client, fetcher: fetcher as typeof fetch });
    const result = await replication.syncWorkflowInputs(profile, { username: "u", password: "secret" }, "11111111-1111-1111-1111-111111111111", 8, "brain");
    expect(result).toMatchObject({ uploaded: ["brain"], reused: [], bytesTransferred: payload.byteLength });
    expect(result.stagedPaths.brain).toBe("/cloud/inputs/brain.nii.gz");
  });

  it("reuses an already synchronized input without downloading or uploading it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nf-handoff-"));
    const sha256 = "a".repeat(64);
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("handoff-manifest")) return body({ artifacts: [{ artifactId: "brain", relativePath: "brain.nii.gz", url: "/never", sha256, sizeBytes: 12 }] });
      if (url.endsWith("/inputs")) return body([{ artifact_key: "brain", sha256, size_bytes: 12, status: "complete", staged_path: "/cloud/brain.nii.gz" }]);
      throw new Error("unexpected transfer");
    });
    const client = new WorkspaceClient(new WorkspaceMetadataCache(path.join(root, "metadata")), path.join(root, "artifacts"), fetcher as typeof fetch);
    const replication = new WorkspaceReplicationEngine({ artifactCacheRoot: root, client, fetcher: fetcher as typeof fetch });
    const result = await replication.syncWorkflowInputs(profile, null, "11111111-1111-1111-1111-111111111111", 8, "brain");
    expect(result.reused).toEqual(["brain"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a local artifact that changed after manifest creation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nf-handoff-"));
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("handoff-manifest")) return body({ artifacts: [{ artifactId: "brain", relativePath: "brain.nii.gz", url: "/file", sha256: "0".repeat(64), sizeBytes: 4 }] });
      if (url.endsWith("/inputs")) return body([]);
      if (url.endsWith("/file")) return new Response("data");
      return body({});
    });
    const client = new WorkspaceClient(new WorkspaceMetadataCache(path.join(root, "metadata")), path.join(root, "artifacts"), fetcher as typeof fetch);
    const replication = new WorkspaceReplicationEngine({ artifactCacheRoot: root, client, fetcher: fetcher as typeof fetch });
    await expect(replication.syncWorkflowInputs(profile, null, "11111111-1111-1111-1111-111111111111", 8, "brain")).rejects.toThrow("changed");
  });
});

describe("automatic completed-run persistence", () => {
  it("synchronizes discovered reports and their assets without pipeline-name checks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nf-auto-sync-"));
    const html = "<html>report</html>";
    const checksum = createHash("sha256").update(html).digest("hex");
    const snapshot: WorkspaceSnapshot = {
      schemaVersion: 1,
      workspaceId: "workspace-a",
      profileId: profile.id,
      serverUrl: profile.serverUrl,
      synchronizedAt: "2026-07-20T00:00:00Z",
      projects: [], datasets: [], workflows: [], reports: [],
      runs: [{
        id: 9, remoteKey: "workspace-a:run:9", dataset_id: 1,
        pipeline_manifest_id: "future-report-pipeline", pipeline_version: "1",
        status: "success", created_at: "2026-07-20T00:00:00Z",
        artifacts: [{ artifactId: "report", relativePath: "qc/report.html", url: "/file/report", sha256: checksum, sizeBytes: html.length }],
        cachedArtifacts: [], cacheState: "cloud-only", reports: [{ path: "qc/report.html", name: "QC" }],
      }],
    };
    const client = { synchronize: vi.fn(async () => ({ online: true, profile, snapshot })) } as unknown as WorkspaceClient;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/sync-manifest")) return body({
        runId: 9, provenance: {}, methods: {}, reports: [{ path: "qc/report.html" }],
        artifacts: [{ artifactId: "report", relativePath: "qc/report.html", url: "/file/report", sha256: checksum, sizeBytes: html.length }],
      });
      return new Response(html);
    });
    const replication = new WorkspaceReplicationEngine({ artifactCacheRoot: root, client, fetcher: fetcher as typeof fetch });
    const result = await replication.synchronize(profile, null);
    expect(result.snapshot.runs[0].cacheState).toBe("fully-cached");
    expect(result.snapshot.runs[0].cachedArtifacts).toEqual(["qc/report.html"]);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/file/report"))).toBe(true);
  });
});
