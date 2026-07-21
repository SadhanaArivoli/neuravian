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
  syncWorkflowInputs?(input: {
    profileId: string;
    executionUuid: string;
    upstreamRunId: number;
    artifactType: string;
  }): Promise<{
    uploaded: string[];
    reused: string[];
    stagedPaths: Record<string, string>;
    bytesTransferred: number;
  }>;
  prepareWorkflowHandoff?(input: {
    profileId: string;
    workflowId: number;
    executionUuid: string;
    idempotencyKey: string;
    upstreamRunId: number;
    artifactType: string;
    state: Record<string, unknown>;
  }): Promise<{
    execution: Record<string, unknown>;
    executionUuid: string;
    cloudWorkflowId: number;
    remoteDatasetId: number;
    sourceDatasetId: number;
    uploaded: string[];
    reused: string[];
    stagedPaths: Record<string, string>;
    bytesTransferred: number;
  }>;
  updateWorkflowExecution?(input: {
    profileId: string;
    executionUuid: string;
    expectedRevision: number;
    status: string;
    currentNodeId?: string | null;
    returnSyncComplete?: boolean;
    state: Record<string, unknown>;
  }): Promise<Record<string, unknown> & { revision: number }>;
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
    launchMode?: "default" | "composed";
    files: Array<{
      relativePath: string;
      overlay?: boolean;
      intendedRole?: "base image" | "overlay" | "segmentation";
    }>;
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
  viewerRuntimeBuild?: string;
  readArtifact(input: import("../../desktop/src/preload/viewer-api-contract").ReadArtifactRequest): Promise<Uint8Array>;
  assertDefaultViewerScene?(
    input: import("../../desktop/src/preload/viewer-api-contract").DefaultViewerSceneRequest,
  ): Promise<boolean>;
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
  setAutoStop(input: { profileId: string; enabled: boolean }): Promise<WorkspaceProfile>;
  loadSession(profileId: string): Promise<{ session: WorkspaceSession | null; cachedSnapshot: WorkspaceSnapshot | null }>;
  loadRunHistory(input: { profileId: string; page?: number; pageSize?: number }): Promise<{
    entries: SessionRunHistoryEntry[];
    totalCount: number;
    hasMore: boolean;
  }>;
  saveUiState(input: { profileId: string; uiState: SessionUIState }): Promise<{ ok: boolean }>;
  onCloudEvent(callback: (event: {
    profileId: string;
    type: string;
    [key: string]: unknown;
  }) => void): () => void;
  launchPipeline(input: {
    profileId: string;
    pipelineId: string;
    datasetId: number;
    lineage?: {
      upstream_run_id: number;
      upstream_pipeline_id: string;
      upstream_pipeline_display_name?: string;
      artifact_type: string;
      artifact_label: string;
      injected_param?: string;
      injected_path?: string;
      external?: boolean;
      upstream_workspace_id?: string;
      workflow_execution_uuid?: string;
    };
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
  autoStopAfterRun?: boolean;
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
  /** Semantic role attached at sync time. Absent on legacy cached artifacts — fall back to classifyArtifactRole(). */
  semanticRole?: import("./lib/artifact-capabilities").ArtifactSemanticRole;
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

interface SessionUIState {
  activeView: string;
  selectedProjectId: string | null;
  selectedWorkflowId: string | null;
  selectedRunId: number | null;
  openPanels: string[];
  scrollPositions: Record<string, number>;
}

interface SessionSyncStatus {
  lastSyncAt: string | null;
  lastOnlineAt: string | null;
  pendingArtifacts: number;
  syncErrors: string[];
}

interface SessionRunHistoryEntry {
  runId: number;
  remoteKey: string;
  pipelineId: string;
  pipelineName: string;
  datasetId: number;
  status: string;
  launchedAt: string;
  finishedAt: string | null;
  cacheState: WorkspaceCacheState;
  artifactCount: number;
  fenceComplete: boolean;
}

interface WorkspaceSession {
  sessionId: string;
  profileId: string;
  workspaceId: string | null;
  createdAt: string;
  lastActiveAt: string;
  projectSummaries: Array<{ id: number; remoteKey: string; title: string }>;
  workflowSummaries: Array<{ id: number; remoteKey: string; name: string }>;
  datasetSummaries: Array<{ id: number; remoteKey: string; name: string }>;
  /** Display cache — last 50 entries. Complete history is in RunHistoryStore. */
  recentRunHistory: SessionRunHistoryEntry[];
  pendingExecutions: Array<{
    runId: number; profileId: string; pipelineId: string; launchedAt: string; autoStop: boolean;
  }>;
  notifications: Array<{
    notificationId: string;
    type: string;
    message: string;
    timestamp: string;
    runId: number | null;
    read: boolean;
  }>;
  uiState: SessionUIState;
  viewerState: {
    lastRunId: number | null;
    openFiles: string[];
    viewerPreference: "freeview" | "mricrogl" | "neuroforge-viewer" | null;
  };
  syncStatus: SessionSyncStatus;
  researchContext: {
    annotations: Record<string, Record<string, unknown>>;
    recentlyViewed: string[];
    scratch: string;
    preferences: Record<string, unknown>;
  };
}

interface Window {
  neuroforgeDesktop?: NeuroForgeDesktopBridge;
}
