export type WorkspaceConnectionState = "connected" | "offline" | "syncing" | "unavailable";
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
