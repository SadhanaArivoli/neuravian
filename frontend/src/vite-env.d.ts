/// <reference types="vite/client" />

type Ec2InstanceState =
  | "pending" | "running" | "stopping" | "stopped" | "shutting-down" | "terminated";

interface Ec2ConnectionHealth {
  instanceId: string;
  region: string;
  instanceState: Ec2InstanceState | "unknown";
  publicIp: string | null;
  publicHostname: string | null;
  resolvedServerUrl: string | null;
  lastUpdated: string;
  error?: string;
  awsCliAvailable: boolean;
}

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
    connectionMode?: "url" | "instance-id";
    instanceId?: string | null;
    awsRegion?: string | null;
  }): Promise<WorkspaceProfile>;
  removeWorkspace(profileId: string): Promise<boolean>;
  duplicateWorkspace(profileId: string): Promise<WorkspaceProfile>;
  exportWorkspace(profileId: string): Promise<Record<string, unknown>>;
  importWorkspace(input: {
    name?: string; serverUrl: string; username?: string; password?: string;
    connectionMode?: "url" | "instance-id"; instanceId?: string | null; awsRegion?: string | null;
  }): Promise<WorkspaceProfile>;
  resetWorkspaceCache(workspaceId: string): Promise<boolean>;
  clearWorkspaceCredentials(profileId: string): Promise<boolean>;
  resolveInstanceUrl(profileId: string): Promise<WorkspaceProfile | null>;
  getEc2State(profileId: string): Promise<Ec2ConnectionHealth | null>;
  pullToLocal(input: { type: "project" | "workflow"; data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  syncWorkspace(profileId: string): Promise<{
    online: boolean;
    profile: WorkspaceProfile;
    snapshot: WorkspaceSnapshot;
    ec2Health?: Ec2ConnectionHealth | null;
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
  syncAllRunArtifacts(input: {
    profileId: string;
    workspaceId: string;
    runId: number;
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
  pushCloudProject(input: {
    profileId: string;
    project: {
      title: string;
      description?: string | null;
      institution?: string | null;
      lab?: string | null;
      pi_name?: string | null;
      collaborators?: string[];
      tags?: string[];
      status?: string;
    };
  }): Promise<Record<string, unknown>>;
  pushCloudWorkflow(input: {
    profileId: string;
    workflow: {
      name: string;
      description?: string | null;
      dataset_id?: number | null;
      tags?: string[];
      state: Record<string, unknown>;
      schema_version?: string;
      is_template?: boolean;
      is_favorite?: boolean;
      is_archived?: boolean;
    };
  }): Promise<Record<string, unknown>>;
  browseForViewer(viewerId: string): Promise<string | null>;
  saveViewerConfig(input: { viewerId: string; executablePath: string | null }): Promise<boolean>;
  readArtifact(input: { workspaceId: string; runId: number; relativePath: string }): Promise<Uint8Array>;
  replicateObjects(input: { profileId: string; objects: unknown[] }): Promise<{
    pushed: string[];
    skipped: string[];
    errors: Array<{ objectId: string; error: string }>;
  }>;
  shutdownFence(input: { profileId: string; workspaceId: string }): Promise<{
    artifactsPulled: string[];
    errors: string[];
    fenceComplete: boolean;
  }>;
  onCloudEvent(callback: (event: {
    profileId: string;
    type: string;
    [key: string]: unknown;
  }) => void): () => void;
  launchPipeline(input: {
    profileId: string;
    pipelineId: string;
    datasetId: number;
    params?: Record<string, unknown>;
    autoStart?: boolean;
  }): Promise<{ runId: number; status: string; profileId: string }>;
  launchEnvironment(input: { profileId: string }): Promise<{
    profile: WorkspaceProfile;
    workspaceId: string | null;
    elapsedMs: number;
  }>;
  startEnvironment(profileId: string): Promise<{ started: boolean }>;
  stopEnvironment(input: {
    profileId: string;
    workspaceId?: string;
    runFence?: boolean;
  }): Promise<{
    stopped: boolean;
    fenceResult: { artifactsPulled: string[]; errors: string[]; fenceComplete: boolean } | null;
  }>;
}

interface WorkspaceProfile {
  id: string;
  name: string;
  serverUrl: string;
  authenticationRef: string | null;
  serverIdentity: string | null;
  lastSync: string | null;
  connectionState: "connected" | "offline" | "syncing" | "unavailable";
  connectionMode?: "url" | "instance-id";
  instanceId?: string | null;
  awsRegion?: string | null;
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
