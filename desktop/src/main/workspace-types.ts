export type WorkspaceConnectionState = "connected" | "offline" | "syncing" | "unavailable";

export type Ec2InstanceState =
  | "pending" | "running" | "stopping" | "stopped" | "shutting-down" | "terminated";

export interface Ec2ConnectionHealth {
  instanceId: string;
  region: string;
  instanceState: Ec2InstanceState | "unknown";
  publicIp: string | null;
  /** sslip.io hostname if publicIp is available, else EC2 public DNS, else null */
  publicHostname: string | null;
  /** Fully-qualified serverUrl with the new hostname substituted in */
  resolvedServerUrl: string | null;
  lastUpdated: string;
  /** Human-readable error if resolution failed */
  error?: string;
  awsCliAvailable: boolean;
}
export type WorkspaceCacheState =
  | "cloud-only"
  | "downloading"
  | "partially-cached"
  | "fully-cached"
  | "offline-cached"
  | "local-only"
  | "server-unavailable";

export interface WorkspaceProfile {
  id: string;
  name: string;
  serverUrl: string;
  authenticationRef: string | null;
  serverIdentity: string | null;
  lastSync: string | null;
  connectionState: WorkspaceConnectionState;
  /** "url" = static server URL (default); "instance-id" = resolve EC2 public IP on each reconnect */
  connectionMode?: "url" | "instance-id";
  instanceId?: string | null;
  awsRegion?: string | null;
}

export interface WorkspaceCredential {
  username: string;
  password: string;
}

export interface StableRemoteIdentity {
  workspaceId: string;
  resourceType: "project" | "dataset" | "workflow" | "run" | "report" | "artifact";
  serverResourceId: string;
}

export function remoteIdentityKey(identity: StableRemoteIdentity): string {
  return `${identity.workspaceId}:${identity.resourceType}:${identity.serverResourceId}`;
}

export interface WorkspaceArtifact {
  artifactId: string | number;
  relativePath: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  geometry?: {
    shape: number[];
    voxelSize: number[];
    orientation: string[];
    affine: number[][];
  } | null;
}

export interface WorkspaceRun {
  id: number;
  remoteKey: string;
  dataset_id: number;
  pipeline_manifest_id: string;
  pipeline_version: string;
  status: string;
  source_run_id?: number | null;
  remote_host_id?: number | null;
  started_at?: string | null;
  finished_at?: string | null;
  created_at: string;
  progress?: unknown;
  parameters?: unknown;
  provenance?: unknown;
  results?: unknown;
  reports?: unknown[];
  logs?: unknown;
  artifacts: WorkspaceArtifact[];
  cachedArtifacts: string[];
  cacheState: WorkspaceCacheState;
}

export interface WorkspaceSnapshot {
  schemaVersion: 1;
  workspaceId: string;
  profileId: string;
  serverUrl: string;
  synchronizedAt: string;
  projects: Array<Record<string, unknown> & { id: number; remoteKey: string }>;
  datasets: Array<Record<string, unknown> & { id: number; remoteKey: string }>;
  workflows: Array<Record<string, unknown> & { id: number; remoteKey: string }>;
  runs: WorkspaceRun[];
  reports: Array<Record<string, unknown> & { id: number | string; remoteKey: string }>;
}
