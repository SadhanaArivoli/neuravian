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
  syncWorkspaceArtifacts(input: {
    profileId: string;
    workspaceId: string;
    runId: number;
    relativePaths: string[];
  }): Promise<{ runId: number; downloaded: string[]; reused: string[] }>;
  syncRun(runId: number): Promise<{ runId: number; downloaded: string[]; reused: string[] }>;
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
  progress?: unknown;
  parameters?: unknown;
  artifacts: WorkspaceArtifact[];
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

interface Window {
  neuroforgeDesktop?: NeuroForgeDesktopBridge;
}
