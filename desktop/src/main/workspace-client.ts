import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { inspectRunCache, syncRun, type SyncManifest, type SyncResult } from "./run-cache.js";
import {
  remoteIdentityKey,
  type Ec2ConnectionHealth,
  type WorkspaceCredential,
  type WorkspaceProfile,
  type WorkspaceRun,
  type WorkspaceSnapshot,
} from "./workspace-types.js";
import { WorkspaceMetadataCache } from "./workspace-cache.js";

const execFileAsync = promisify(execFile);

/** Derive a sslip.io hostname from a dotted IPv4 address. */
function sslipHostname(ip: string): string {
  return `${ip.replace(/\./g, "-")}.sslip.io`;
}

/**
 * Reconstruct the workspace serverUrl with a new hostname substituted in.
 * Preserves the original protocol, port, and path.
 * Falls back to `https://<hostname>` if the existing serverUrl cannot be parsed.
 */
function rebuildServerUrl(currentServerUrl: string, newHostname: string): string {
  if (!currentServerUrl) return `https://${newHostname}`;
  try {
    const url = new URL(currentServerUrl);
    url.hostname = newHostname;
    return url.toString().replace(/\/$/, "");
  } catch {
    return `https://${newHostname}`;
  }
}

/**
 * Detect the current state of an EC2 instance and derive the correct serverUrl.
 * Replaces the old `resolveInstanceUrl` with a fully structured result so that
 * callers can surface instance state, IP, and hostname to the user.
 */
export async function resolveEc2State(profile: WorkspaceProfile): Promise<Ec2ConnectionHealth> {
  const lastUpdated = new Date().toISOString();
  const instanceId = profile.instanceId ?? "";
  const region = profile.awsRegion ?? "";

  if (!instanceId || !region) {
    return {
      instanceId, region, instanceState: "unknown",
      publicIp: null, publicHostname: null, resolvedServerUrl: null,
      lastUpdated, awsCliAvailable: false,
      error: "EC2 instance ID and region must both be set.",
    };
  }

  // Verify AWS CLI is available before making the real call.
  try {
    await execFileAsync("aws", ["--version"], { timeout: 5_000, env: process.env });
  } catch {
    return {
      instanceId, region, instanceState: "unknown",
      publicIp: null, publicHostname: null, resolvedServerUrl: null,
      lastUpdated, awsCliAvailable: false,
      error: "AWS CLI not found. Install it to enable automatic EC2 reconnection.",
    };
  }

  try {
    // Fetch state name, public IP, and public DNS in one call.
    const { stdout } = await execFileAsync(
      "aws",
      [
        "ec2", "describe-instances",
        "--instance-ids", instanceId,
        "--region", region,
        "--query", "Reservations[0].Instances[0].[State.Name,PublicIpAddress,PublicDnsName]",
        "--output", "text",
      ],
      { timeout: 15_000, env: process.env },
    );

    const parts = stdout.trim().split(/\t/);
    const rawState = parts[0]?.trim() ?? "";
    const rawIp = parts[1]?.trim() ?? "";
    const rawDns = parts[2]?.trim() ?? "";

    const instanceState = (rawState && rawState !== "None" ? rawState : "unknown") as Ec2ConnectionHealth["instanceState"];
    const publicIp = rawIp && rawIp !== "None" && /^\d{1,3}(\.\d{1,3}){3}$/.test(rawIp) ? rawIp : null;
    // Prefer sslip.io (stable HTTPS-compatible wildcard DNS) over EC2 public DNS.
    const publicHostname = publicIp
      ? sslipHostname(publicIp)
      : (rawDns && rawDns !== "None" ? rawDns : null);

    const resolvedServerUrl = publicHostname
      ? rebuildServerUrl(profile.serverUrl, publicHostname)
      : null;

    return {
      instanceId, region, instanceState, publicIp, publicHostname,
      resolvedServerUrl, lastUpdated, awsCliAvailable: true,
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    let friendlyError = raw;
    if (raw.includes("InvalidInstanceID")) {
      friendlyError = `Instance '${instanceId}' was not found in region '${region}'. Check the instance ID.`;
    } else if (raw.includes("UnauthorizedOperation") || raw.includes("AccessDenied")) {
      friendlyError = "AWS credentials lack permission to describe EC2 instances (ec2:DescribeInstances).";
    } else if (raw.includes("Could not connect to the endpoint URL") || raw.includes("EndpointResolutionError")) {
      friendlyError = `Region '${region}' could not be reached. Verify the region name.`;
    } else if (raw.includes("NoCredentialProviders") || raw.includes("Unable to locate credentials")) {
      friendlyError = "No AWS credentials found. Run `aws configure` or set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.";
    }
    return {
      instanceId, region, instanceState: "unknown",
      publicIp: null, publicHostname: null, resolvedServerUrl: null,
      lastUpdated, awsCliAvailable: true, error: friendlyError,
    };
  }
}

/** @deprecated Use resolveEc2State instead. Kept for any callers still referencing this name. */
export async function resolveInstanceUrl(profile: WorkspaceProfile): Promise<string | null> {
  const health = await resolveEc2State(profile);
  return health.resolvedServerUrl;
}

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
  /** Tracks runs whose artifacts are currently being auto-synced in the background. */
  private readonly autoSyncingRuns = new Set<string>();

  constructor(
    private readonly metadataCache: WorkspaceMetadataCache,
    private readonly artifactCacheRoot: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async testConnection(
    profile: WorkspaceProfile,
    credential: WorkspaceCredential | null,
  ): Promise<{ workspaceId: string; product: string; apiVersion: string; serverVersion: string }> {
    const fetcher = authenticatedFetcher(credential, this.fetcher);
    const [identity, about] = await Promise.all([
      json<{ workspace_id: string; product: string; api_version: string }>(
        profile, "/api/workspace/identity", fetcher,
      ),
      json<{ version?: string; backend_version?: string }>(profile, "/api/about", fetcher),
    ]);
    if (profile.serverIdentity && profile.serverIdentity !== identity.workspace_id) {
      throw new Error("Workspace server identity changed; connection refused.");
    }
    return {
      workspaceId: identity.workspace_id,
      product: identity.product,
      apiVersion: identity.api_version,
      serverVersion: about.version ?? about.backend_version ?? "unknown",
    };
  }

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

        // Auto-sync: download all artifacts for completed runs that are not yet fully cached.
        // Fire-and-forget — never blocks the snapshot response.
        const autoSyncKey = `${workspaceId}:${summary.id}`;
        if (manifest && inspection.state !== "fully-cached" && !this.autoSyncingRuns.has(autoSyncKey)) {
          this.autoSyncingRuns.add(autoSyncKey);
          const resolvedManifest: SyncManifest = {
            ...manifest,
            artifacts: manifest.artifacts.map((artifact) => ({
              ...artifact,
              url: new URL(artifact.url, `${profile.serverUrl}/`).toString(),
            })),
          };
          syncRun(path.join(this.artifactCacheRoot, workspaceId), resolvedManifest, fetcher)
            .then(() => { this.autoSyncingRuns.delete(autoSyncKey); })
            .catch((e: unknown) => {
              console.error(`[auto-sync] run ${summary.id} failed:`, e instanceof Error ? e.message : e);
              this.autoSyncingRuns.delete(autoSyncKey);
            });
        }

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

  /** Download every artifact for a completed run in a single call. */
  async syncAllRunArtifacts(
    profile: WorkspaceProfile,
    credential: WorkspaceCredential | null,
    workspaceId: string,
    runId: number,
  ): Promise<SyncResult> {
    if (!Number.isInteger(runId) || runId < 1) throw new Error("Invalid run ID.");
    const fetcher = authenticatedFetcher(credential, this.fetcher);
    const manifest = await json<SyncManifest>(profile, `/api/runs/${runId}/sync-manifest`, fetcher);
    manifest.artifacts = manifest.artifacts.map((artifact) => ({
      ...artifact,
      url: new URL(artifact.url, `${profile.serverUrl}/`).toString(),
    }));
    // Mark as auto-syncing so the background job doesn't start a duplicate.
    const key = `${workspaceId}:${runId}`;
    this.autoSyncingRuns.add(key);
    try {
      return await syncRun(path.join(this.artifactCacheRoot, workspaceId), manifest, fetcher);
    } finally {
      this.autoSyncingRuns.delete(key);
    }
  }
}
