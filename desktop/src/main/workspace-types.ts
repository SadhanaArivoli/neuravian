// ─── Workspace Replication Engine — core object model ────────────────────────
//
// The WRE is pipeline-agnostic, storage-agnostic, and event-driven.
// It replicates typed NeuroForgeObjects between the desktop (authoritative)
// and cloud VMs (ephemeral cache). It never reads pipeline manifests, never
// hard-codes storage paths, and never holds EC2/Caddy infrastructure concerns.

/** Every domain type the WRE can replicate. */
export type NeuroForgeObjectType =
  | "project"
  | "workflow"
  | "dataset"
  | "run"
  | "artifact-manifest"
  | "report"
  | "pipeline-template";

/**
 * A storage reference that is opaque to the WRE. The `strategy` field names
 * a registered TransportStrategy implementation; `location` is interpreted
 * entirely by that strategy. New storage backends (S3, SFTP, etc.) are added
 * by registering a new strategy — no WRE changes required.
 */
export interface TransportRef {
  strategy: string;
  location: string;
  contentHash?: string;
  sizeBytes?: number;
}

// ── Payload types (discriminated by NeuroForgeObjectType) ──────────────────

export interface ProjectPayload {
  title: string;
  description?: string;
}

export interface WorkflowPayload {
  name: string;
  description?: string;
  definition: unknown;
}

export interface DatasetPayload {
  name: string;
  description?: string;
  transportRef: TransportRef;
  bidsValidated?: boolean;
  subjects?: number;
}

export interface ArtifactEntry {
  relativePath: string;
  transportRef: TransportRef;
  sizeBytes: number;
}

export interface ArtifactManifestPayload {
  runObjectId: string;
  pipelineManifestId: string;
  artifacts: ArtifactEntry[];
}

export interface ReportPayload {
  runObjectId: string;
  title: string;
  html?: string;
  transportRef?: TransportRef;
}

export interface PipelineTemplatePayload {
  manifestId: string;
  version: string;
  definition: unknown;
}

export interface RunPayload {
  projectObjectId: string;
  workflowObjectId: string;
  datasetObjectId: string;
  pipelineManifestId: string;
  pipelineVersion: string;
  status: string;
  parameters?: unknown;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export type NeuroForgePayload =
  | ProjectPayload
  | WorkflowPayload
  | DatasetPayload
  | RunPayload
  | ArtifactManifestPayload
  | ReportPayload
  | PipelineTemplatePayload;

/**
 * The atomic unit of replication. Every domain object is a NeuroForgeObject.
 * - `objectId`: UUID assigned by the desktop at creation; the cloud never mints IDs.
 * - `revision`: monotonic counter; the cloud stores whatever revision it received.
 * - `contentHash`: SHA256 of the canonical JSON payload; used for dedup and verification.
 */
export interface NeuroForgeObject {
  objectId: string;
  objectType: NeuroForgeObjectType;
  revision: number;
  contentHash: string;
  createdAt: string;
  modifiedAt: string;
  payload: NeuroForgePayload;
}

// ── Typed event bus ──────────────────────────────────────────────────────────
//
// The WRE reacts to these events rather than polling directly.
// Deployment concerns (EC2, Caddy, sslip.io) live in WorkspaceInfrastructure
// and communicate with the WRE only through this bus.

export type WREEvent =
  | { type: "workspace:connected";       workspaceId: string }
  | { type: "workspace:snapshot-ready";  workspaceId: string; snapshot: WorkspaceSnapshot }
  | { type: "run:status-changed";        runObjectId: string; status: string; workspaceId: string }
  | { type: "artifact:available";        runObjectId: string; relativePath: string; workspaceId: string }
  | { type: "vm:shutdown-requested";     workspaceId: string };

// ── Replication manifest ─────────────────────────────────────────────────────
//
// Produced by a snapshot diff: compares desktop object store revisions against
// cloud VM snapshot. Tells the WRE exactly what to push and pull without
// fetching every object.

export interface ReplicationManifest {
  workspaceId: string;
  computedAt: string;
  toPush: NeuroForgeObject[];
  toPull: string[];
  inSync: string[];
}

export interface CloudObjectRef {
  objectId: string;
  objectType: NeuroForgeObjectType;
  revision: number;
  contentHash: string;
}

/** Response shape of GET /replication/snapshot on the cloud VM. */
export interface ReplicationSnapshot {
  workspaceId: string;
  objects: CloudObjectRef[];
}

// ── Type guards ──────────────────────────────────────────────────────────────

export function isNeuroForgeObjectType(v: unknown): v is NeuroForgeObjectType {
  return typeof v === "string" && [
    "project", "workflow", "dataset", "run",
    "artifact-manifest", "report", "pipeline-template",
  ].includes(v);
}

export function isNeuroForgeObject(v: unknown): v is NeuroForgeObject {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.objectId === "string" &&
    isNeuroForgeObjectType(o.objectType) &&
    typeof o.revision === "number" &&
    typeof o.contentHash === "string" &&
    typeof o.createdAt === "string" &&
    typeof o.modifiedAt === "string" &&
    o.payload !== undefined
  );
}

export function isTransportRef(v: unknown): v is TransportRef {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.strategy === "string" && typeof o.location === "string";
}

// ─── End WRE types ────────────────────────────────────────────────────────────

// ─── Execution Environment abstraction ───────────────────────────────────────
//
// "Execution Environment" is the generalization of "Cloud VM."
// Today that means an AWS EC2 instance. Tomorrow it could be a local Docker
// container, an Azure VM, a GCP instance, a Slurm job on university HPC,
// or any SSH-accessible Linux server.
//
// The WRE knows only about `environmentId` and `serverUrl`.
// Everything else is opaque `providerConfig`, interpreted by a provider plugin.
// Adding a new execution target requires implementing a provider plugin —
// zero changes to the WRE or replication protocol.

export type ExecutionEnvironmentType =
  | "ec2"       // AWS EC2 (today)
  | "docker"    // local Docker container
  | "azure-vm"  // Azure Virtual Machine
  | "gcp-vm"    // GCP Compute Engine
  | "slurm"     // HPC cluster with Slurm scheduler
  | "ssh"       // any Linux server reachable via SSH
  | "url";      // static URL with no lifecycle management (bare server)

export type EnvironmentLifecycleState =
  | "not-started"   // provisioned in profile but never launched
  | "starting"      // provider is booting the environment
  | "ready"         // reachable, WRE can connect
  | "stopping"      // shutdown fence running or provider stopping
  | "stopped"       // environment is off; data is on desktop
  | "unreachable"   // was running but can no longer be contacted
  | "unknown";      // provider query failed or timed out

/**
 * Provider-agnostic identity for an execution environment.
 * The WRE reads only `environmentId` and `serverUrl`.
 * All provider-specific configuration lives in `providerConfig`,
 * which is interpreted exclusively by the matching provider plugin.
 */
export interface ExecutionEnvironment {
  /** Stable local ID for this execution target (UUID, desktop-assigned). */
  environmentId: string;
  type: ExecutionEnvironmentType;
  name: string;
  /** Resolved server URL when the environment is running; null otherwise. */
  serverUrl: string | null;
  lifecycleState: EnvironmentLifecycleState;
  /**
   * Provider-specific configuration — opaque to everything above the provider
   * plugin layer. Examples:
   *   ec2:    { instanceId, region }
   *   docker: { containerId, image }
   *   slurm:  { host, partition, jobId }
   *   ssh:    { host, port, user }
   */
  providerConfig: unknown;
}

// ─── End Execution Environment abstraction ───────────────────────────────────

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
  /** When true, the shutdown fence + stop runs automatically after every completed run. Default: false. */
  autoStopAfterRun?: boolean;
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

// ─── WorkspaceSession ─────────────────────────────────────────────────────────
//
// The permanent representation of a researcher's work in one workspace.
// Survives VM deletion, NeuroForge restarts, and network interruptions.
//
// Key separation from WorkspaceProfile and WRE:
//   WorkspaceProfile = how to reach the execution environment
//   WRE              = how data moves between desktop and cloud
//   WorkspaceSession = the researcher's accumulated work and context
//
// The session is the source of truth for what the researcher sees.
// The WRE populates it via events; the session never calls WRE directly.

/**
 * Researcher annotation on a single workspace object.
 * Keyed by objectId (for WRE objects) or remoteKey (for synced resources).
 *
 * Intentionally open-ended: new annotation types (e.g. "starred", "reviewed")
 * are added as optional fields without schema migration or new arrays.
 */
export interface ResearcherAnnotation {
  pinned?:      boolean;
  bookmarked?:  boolean;
  favorite?:    boolean;
  note?:        string;
  tags?:        string[];
  // Open extension point: caller may store any additional fields.
  [key: string]:  unknown;
}

/**
 * Researcher-curated context for the workspace.
 * Distinct from sync state (WRE) and connection state (WorkspaceProfile).
 * This is where researcher meaning lives — not execution mechanics.
 */
export interface WorkspaceResearchContext {
  /**
   * Annotations keyed by objectId or remoteKey.
   * One entry per workspace object; grows incrementally as the researcher
   * annotates their work. Never cleared by sync or VM lifecycle events.
   */
  annotations: Record<string, ResearcherAnnotation>;

  /**
   * Ordered list of objectId / remoteKey strings, most recently viewed first.
   * Populated automatically as the researcher opens items. Capped at 100.
   */
  recentlyViewed: string[];

  /**
   * Scratch notes for the workspace as a whole (plain text).
   * Not synced to the cloud — this is the researcher's local context.
   */
  scratch: string;

  /**
   * Workspace-specific researcher preferences.
   * Examples: default viewer, preferred pipeline parameters, display density.
   * Intentionally untyped so new preferences never require a schema change.
   */
  preferences: Record<string, unknown>;
}

export interface SessionRunHistoryEntry {
  runId:          number;
  remoteKey:      string;
  pipelineId:     string;
  pipelineName:   string;
  datasetId:      number;
  status:         string;
  launchedAt:     string;
  finishedAt:     string | null;
  cacheState:     WorkspaceCacheState;
  artifactCount:  number;
  fenceComplete:  boolean;
}

export interface SessionPendingExecution {
  runId:      number;
  profileId:  string;
  pipelineId: string;
  launchedAt: string;
  autoStop:   boolean;
}

export interface SessionNotification {
  notificationId: string;
  type:           "run:complete" | "run:failed" | "artifact:ready" | "vm:stopped" | "sync:complete" | "sync:error";
  message:        string;
  timestamp:      string;
  runId:          number | null;
  read:           boolean;
}

export interface SessionUIState {
  activeView:         string;
  selectedProjectId:  string | null;
  selectedWorkflowId: string | null;
  selectedRunId:      number | null;
  openPanels:         string[];
  scrollPositions:    Record<string, number>;
}

export interface SessionViewerState {
  lastRunId:         number | null;
  openFiles:         string[];
  viewerPreference:  "freeview" | "mricrogl" | "neuroforge-viewer" | null;
}

export interface SessionSyncStatus {
  lastSyncAt:       string | null;
  lastOnlineAt:     string | null;
  pendingArtifacts: number;
  syncErrors:       string[];
}

export interface WorkspaceSession {
  // ── Identity ──────────────────────────────────────────────────────────────
  sessionId:    string;   // stable UUID; never changes across restarts or VM changes
  profileId:    string;   // which WorkspaceProfile this session belongs to
  workspaceId:  string | null;  // server identity from /api/workspace/identity
  createdAt:    string;
  lastActiveAt: string;

  // ── Last-known workspace state (survives offline) ──────────────────────────
  // Shallow summaries only — not full objects. Updated on every successful sync.
  projectSummaries:  Array<{ id: number; remoteKey: string; title: string }>;
  workflowSummaries: Array<{ id: number; remoteKey: string; name: string }>;
  datasetSummaries:  Array<{ id: number; remoteKey: string; name: string }>;

  // ── Persistent run history (append-only, never pruned) ────────────────────
  // Survives VM deletion. Accumulates across all VMs attached to this profile.
  runHistory: SessionRunHistoryEntry[];

  // ── Execution state ───────────────────────────────────────────────────────
  pendingExecutions: SessionPendingExecution[];

  // ── Notifications ─────────────────────────────────────────────────────────
  notifications: SessionNotification[];

  // ── UI continuity (ephemeral, but persisted so restarts feel seamless) ────
  uiState:     SessionUIState;
  viewerState: SessionViewerState;

  // ── Synchronization status ────────────────────────────────────────────────
  syncStatus: SessionSyncStatus;

  // ── Research context (permanent researcher annotations and meaning) ────────
  // This namespace is intentionally separate from all operational state above.
  // It is the researcher's space — never touched by sync, VM lifecycle, or WRE.
  researchContext: WorkspaceResearchContext;
}
