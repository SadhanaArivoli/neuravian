import path from "node:path";
import { inspectRunCache, syncRun, type SyncManifest, type SyncResult } from "./run-cache.js";
import { remoteIdentityKey, type WorkspaceCredential, type WorkspaceProfile, type WorkspaceRun, type WorkspaceSnapshot } from "./workspace-types.js";
import { WorkspaceMetadataCache } from "./workspace-cache.js";

type JsonRecord = Record<string, unknown>;

function authorization(credential: WorkspaceCredential | null): string | null {
  if (!credential) return null;
  return `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
}

function authenticatedFetcher(
  credential: WorkspaceCredential | null,
  fetcher: typeof fetch,
): typeof fetch {
  const header = authorization(credential);
  return (input, init = {}) => fetcher(input, {
    ...init,
    headers: {
      ...init.headers,
      ...(header ? { Authorization: header } : {}),
    },
  });
}

function endpoint(profile: WorkspaceProfile, route: string): string {
  return new URL(route.replace(/^\//, ""), `${profile.serverUrl}/`).toString();
}

async function json<T>(
  profile: WorkspaceProfile,
  route: string,
  fetcher: typeof fetch,
): Promise<T> {
  const response = await fetcher(endpoint(profile, route));
  if (!response.ok) throw new Error(`Workspace request failed with HTTP ${response.status}.`);
  return await response.json() as T;
}

async function settledOr<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try { return await promise; } catch { return fallback; }
}

function withRemoteKey<T extends JsonRecord & { id: number | string }>(
  workspaceId: string,
  resourceType: "project" | "dataset" | "workflow" | "report",
  value: T,
): T & { remoteKey: string } {
  return {
    ...value,
    remoteKey: remoteIdentityKey({
      workspaceId,
      resourceType,
      serverResourceId: String(value.id),
    }),
  };
}

export class WorkspaceClient {
  constructor(
    private readonly metadataCache: WorkspaceMetadataCache,
    private readonly artifactCacheRoot: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async synchronize(
    profile: WorkspaceProfile,
    credential: WorkspaceCredential | null,
  ): Promise<{ snapshot: WorkspaceSnapshot; online: boolean }> {
    const fetcher = authenticatedFetcher(credential, this.fetcher);
    try {
      const identity = await json<{ workspace_id: string }>(
        profile, "/api/workspace/identity", fetcher,
      );
      if (profile.serverIdentity && profile.serverIdentity !== identity.workspace_id) {
        throw new Error("Workspace server identity changed; connection refused.");
      }
      const [rawProjects, rawDatasets, workflowSummaries, runSummaries] = await Promise.all([
        json<JsonRecord[]>(profile, "/api/projects", fetcher),
        json<JsonRecord[]>(profile, "/api/datasets", fetcher),
        json<Array<JsonRecord & { id: number }>>(profile, "/api/workflows", fetcher),
        json<Array<JsonRecord & { id: number; status: string }>>(profile, "/api/runs", fetcher),
      ]);
      const workspaceId = identity.workspace_id;
      const projects = await Promise.all(rawProjects.map(async (project) => {
        const projectDatasets = await settledOr(
          json<Array<{ id: number }>>(profile, `/api/projects/${project.id}/datasets`, fetcher),
          [],
        );
        return withRemoteKey(workspaceId, "project", {
          ...project,
          id: Number(project.id),
          datasetIds: projectDatasets.map((dataset) => dataset.id),
        });
      }));
      const datasets = rawDatasets.map((dataset) => withRemoteKey(workspaceId, "dataset", {
        ...dataset, id: Number(dataset.id),
      }));
      const workflows = await Promise.all(workflowSummaries.map(async (summary) =>
        withRemoteKey(workspaceId, "workflow", await settledOr(
          json<JsonRecord & { id: number }>(profile, `/api/workflows/${summary.id}`, fetcher),
          summary,
        )),
      ));
      const reportsNested = await Promise.all(datasets.map((dataset) => settledOr(
        json<Array<JsonRecord & { id: number | string }>>(
          profile, `/api/datasets/${dataset.id}/reports`, fetcher,
        ),
        [],
      )));
      const reports = reportsNested.flat().map((report) =>
        withRemoteKey(workspaceId, "report", report));
      const runs = await Promise.all(runSummaries.map(async (summary): Promise<WorkspaceRun> => {
        const [details, provenance, results, logs, manifest] = await Promise.all([
          settledOr(json<JsonRecord>(profile, `/api/runs/${summary.id}`, fetcher), summary),
          settledOr(json<unknown>(profile, `/api/runs/${summary.id}/provenance`, fetcher), null),
          settledOr(json<unknown>(profile, `/api/runs/${summary.id}/results`, fetcher), null),
          settledOr(json<unknown>(profile, `/api/runs/${summary.id}/logs`, fetcher), null),
          summary.status === "success"
            ? settledOr(json<SyncManifest>(profile, `/api/runs/${summary.id}/sync-manifest`, fetcher), null)
            : Promise.resolve(null),
        ]);
        const artifacts = manifest?.artifacts ?? [];
        const inspection = manifest
          ? await inspectRunCache(path.join(this.artifactCacheRoot, workspaceId), manifest)
          : { state: "cloud-only" as const, cachedPaths: [] };
        return {
          ...summary,
          ...details,
          id: summary.id,
          remoteKey: remoteIdentityKey({
            workspaceId, resourceType: "run", serverResourceId: String(summary.id),
          }),
          pipeline_manifest_id: String(details.pipeline_manifest_id ?? summary.pipeline_manifest_id),
          pipeline_version: String(details.pipeline_version ?? summary.pipeline_version),
          dataset_id: Number(details.dataset_id ?? summary.dataset_id),
          status: String(details.status ?? summary.status),
          created_at: String(details.created_at ?? summary.created_at),
          parameters: details.params,
          provenance,
          results,
          logs,
          reports: reports.filter((report) => Number(report.run_id) === summary.id),
          artifacts,
          cachedArtifacts: inspection.cachedPaths,
          cacheState: inspection.state,
        };
      }));
      const snapshot: WorkspaceSnapshot = {
        schemaVersion: 1,
        workspaceId,
        profileId: profile.id,
        serverUrl: profile.serverUrl,
        synchronizedAt: new Date().toISOString(),
        projects,
        datasets,
        workflows,
        runs,
        reports,
      };
      await this.metadataCache.write(snapshot);
      return { snapshot, online: true };
    } catch (error) {
      const cached = await this.metadataCache.read(profile.id);
      if (!cached) throw error;
      return {
        online: false,
        snapshot: {
          ...cached,
          runs: cached.runs.map((run) => ({
            ...run,
            cacheState: run.cacheState === "fully-cached" || run.cacheState === "partially-cached"
              ? "offline-cached"
              : "server-unavailable",
          })),
        },
      };
    }
  }

  async syncArtifacts(
    profile: WorkspaceProfile,
    credential: WorkspaceCredential | null,
    workspaceId: string,
    runId: number,
    relativePaths: string[],
  ): Promise<SyncResult> {
    if (!Number.isInteger(runId) || runId < 1 || relativePaths.length === 0) {
      throw new Error("Artifact synchronization requires a run and at least one artifact.");
    }
    const fetcher = authenticatedFetcher(credential, this.fetcher);
    const manifest = await json<SyncManifest>(profile, `/api/runs/${runId}/sync-manifest`, fetcher);
    const requested = new Set(relativePaths);
    manifest.artifacts = manifest.artifacts
      .filter((artifact) => requested.has(artifact.relativePath))
      .map((artifact) => ({
        ...artifact,
        url: new URL(artifact.url, `${profile.serverUrl}/`).toString(),
      }));
    if (manifest.artifacts.length !== requested.size) {
      throw new Error("One or more requested artifacts are not in the run manifest.");
    }
    return await syncRun(path.join(this.artifactCacheRoot, workspaceId), manifest, fetcher);
  }
}
