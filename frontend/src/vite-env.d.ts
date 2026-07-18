/// <reference types="vite/client" />

interface NeuroForgeDesktopBridge {
  detectViewers(): Promise<Array<{
    viewerId: "freeview" | "mricrogl";
    displayName: string;
    installed: boolean;
    executable: string | null;
    reason: string | null;
  }>>;
  listWorkspaces(): Promise<WorkspaceProfile[]>;
  getLocalWorkspaceIdentity(): Promise<{ schemaVersion: 1; workspaceId: string; createdAt: string }>;
  saveWorkspace(input: {
    id?: string;
    name: string;
    serverUrl: string;
    username?: string;
    password?: string;
  }): Promise<WorkspaceProfile>;
  removeWorkspace(profileId: string): Promise<boolean>;
  syncWorkspace(profileId: string): Promise<{
    online: boolean;
    profile: WorkspaceProfile;
    snapshot: WorkspaceSnapshot;
  }>;
  testWorkspace(profileId: string): Promise<{
    workspaceId: string;
    product: string;
    apiVersion: string;
    serverVersion: string;
  }>;
  inspectWorkspace(input: { profileId: string; workspaceId: string }): Promise<WorkspaceInspection>;
  openWorkspaceRun(input: { profileId: string; runId: number }): Promise<boolean>;
  syncWorkspaceArtifacts(input: {
    profileId: string;
    workspaceId: string;
    runId: number;
    relativePaths: string[];
  }): Promise<{ runId: number; downloaded: string[]; reused: string[] }>;
  launchLocalViewer(request: {
    viewerId: "freeview" | "mricrogl";
    workspaceId: string;
    runId: number;
    files: Array<{ relativePath: string; overlay?: boolean }>;
    opacity?: number;
    freesurferLut?: boolean;
  }): Promise<boolean>;
  launchViewer(request: {
    viewerId: "freeview" | "mricrogl";
    runId: number;
    workspaceId?: string;
    files: Array<{ relativePath: string; overlay?: boolean }>;
    opacity?: number;
    freesurferLut?: boolean;
  }): Promise<boolean>;
}

interface WorkspaceProfile {
  id: string;
  name: string;
  serverUrl: string;
  authenticationRef: string | null;
  serverIdentity: string | null;
  lastSync: string | null;
  connectionState: "connected" | "offline" | "syncing" | "unavailable";
}

type WorkspaceCacheState =
  | "cloud-only" | "downloading" | "partially-cached" | "fully-cached"
  | "offline-cached" | "local-only" | "server-unavailable";

interface WorkspaceArtifact {
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

interface WorkspaceRun {
  id: number;
  remoteKey: string;
  dataset_id: number;
  pipeline_manifest_id: string;
  pipeline_version: string;
  status: string;
  source_run_id?: number | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
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

interface WorkspaceSnapshot {
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

interface WorkspaceInspection {
  cacheSizeBytes: number;
  cachedRuns: number;
  cacheEntries: number;
  legacyCacheEntries: string[];
  viewers: Array<{
    viewerId: "freeview" | "mricrogl";
    displayName: string;
    installed: boolean;
    executable: string | null;
    reason: string | null;
  }>;
}

interface Window {
  neuroforgeDesktop?: NeuroForgeDesktopBridge;
}
