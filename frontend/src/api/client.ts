const BASE_URL = import.meta.env.VITE_API_URL ?? "/api";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, init);
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error((detail as { detail?: string }).detail ?? res.statusText);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

// ------------------------------------------------------------------ //
// Health                                                               //
// ------------------------------------------------------------------ //

export interface HealthResponse {
  status: string;
  service: string;
}

export function fetchHealth(): Promise<HealthResponse> {
  return apiFetch<HealthResponse>("/health");
}

// ------------------------------------------------------------------ //
// Datasets                                                             //
// ------------------------------------------------------------------ //

export interface ValidationIssue {
  code: string;
  message: string;
  friendly: string;
  fix_hint: string | null;
  files: string[];
}

export interface ValidationIssues {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface IndexedMetadata {
  name: string | null;
  bids_version: string | null;
  subjects: string[];
  sessions: string[];
  tasks: string[];
  datatypes: string[];
  suffixes: string[];
  file_count: number;
}

export interface DatasetSummary {
  id: number;
  name: string | null;
  path: string;
  validation_status: string;
  bids_version: string | null;
  subject_count: number;
  created_at: string;
}

export interface Dataset extends DatasetSummary {
  validation_issues: ValidationIssues | null;
  indexed_metadata: IndexedMetadata | null;
  updated_at: string;
}

export function registerDataset(path: string): Promise<Dataset> {
  return apiFetch<Dataset>("/datasets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

export function fetchDatasets(): Promise<DatasetSummary[]> {
  return apiFetch<DatasetSummary[]>("/datasets");
}

export function fetchDataset(id: number): Promise<Dataset> {
  return apiFetch<Dataset>(`/datasets/${id}`);
}

export interface DatasetScan {
  subject: string;
  session: string | null;
  datatype: string | null;
  suffix: string;
  path: string;
}

export interface DatasetScans {
  scans: DatasetScan[];
}

export function fetchDatasetScans(datasetId: number): Promise<DatasetScans> {
  return apiFetch<DatasetScans>(`/datasets/${datasetId}/scans`);
}

// ------------------------------------------------------------------ //
// Pipelines                                                            //
// ------------------------------------------------------------------ //

export interface PipelineContainer {
  image: string;
  tag: string;
  digest?: string;
  engine: string;
}

export interface PipelineParameter {
  name: string;
  type: "string" | "integer" | "float" | "boolean" | "file_path" | "directory_path" | "multiselect" | "select";
  required?: boolean;
  default?: unknown;
  options?: string[];
  help?: string;
  advanced?: boolean;
  internal?: boolean;
  positional_index?: number;
  multiple?: boolean;
  mount?: boolean;
}

export interface PipelineAcceptSlot {
  type: string;
  param?: string;
  dataset_slot?: boolean;
  label?: string;
  description?: string;
}

export interface PipelineProduceSlot {
  type: string;
  label?: string;
  description?: string;
  path_hint?: string | null;
  source_param?: string;
  multiple?: boolean;
}

export interface PipelineKnownError {
  pattern: string;
  explanation: string;
  fix_hint?: string;
}

export type ComputeProfile = "local-ok" | "local-slow" | "local-unsafe";
export type PipelineCategory = "conversion" | "validation" | "quality_control" | "segmentation" | "preprocessing" | "deidentification" | "connectivity";
export type PipelineInputType = "dicom" | "nifti" | "bids_dataset" | "matrix";

export interface PipelineSummary {
  id: string;
  display_name: string;
  description: string;
  homepage?: string;
  container: PipelineContainer | null;
  compute_profile?: ComputeProfile;
  category?: PipelineCategory;
  input_type?: PipelineInputType;
}

export interface Pipeline extends PipelineSummary {
  inputs: string[];
  outputs: string[];
  accepts?: PipelineAcceptSlot[];
  produces?: PipelineProduceSlot[];
  parameters: PipelineParameter[];
  known_errors?: PipelineKnownError[];
  command_template?: string;
}

export function fetchPipelines(): Promise<PipelineSummary[]> {
  return apiFetch<PipelineSummary[]>("/pipelines");
}

export function fetchPipeline(id: string): Promise<Pipeline> {
  return apiFetch<Pipeline>(`/pipelines/${id}`);
}

// ------------------------------------------------------------------ //
// Runs                                                                 //
// ------------------------------------------------------------------ //

export interface ResourceWarning {
  level: string;
  message: string;
}

export type RunStatus = "queued" | "pending" | "running" | "success" | "failed" | "cancelled" | "interrupted";

export interface RunSummary {
  id: number;
  pipeline_manifest_id: string;
  pipeline_version: string;
  dataset_id: number;
  status: RunStatus;
  source_run_id: number | null;
  remote_host_id: number | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface RunProgress {
  percent: number;
  current: number;
  total: number;
  elapsed_seconds: number;
  eta_seconds: number;
  rate: number;
  rate_unit: string;
  last_updated: string; // ISO UTC
}

export interface Run extends RunSummary {
  params: Record<string, unknown>;
  command_preview: string | null;
  output_dir: string | null;
  error_message: string | null;
  resource_warnings: ResourceWarning[];
  progress?: RunProgress | null;
}

export interface RunCreate {
  pipeline_id: string;
  dataset_id: number;
  params: Record<string, unknown>;
  lineage?: RunLineage | null;
  remote_host_id?: number | null;
}

export function createRun(body: RunCreate): Promise<Run> {
  return apiFetch<Run>("/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function fetchRuns(): Promise<RunSummary[]> {
  return apiFetch<RunSummary[]>("/runs");
}

export function fetchRun(id: number): Promise<Run> {
  return apiFetch<Run>(`/runs/${id}`);
}

export interface RunResultFile {
  name: string;
  path: string;
}

export interface RunArtifact {
  type: string;
  label: string;
  description: string;
  resolved: boolean;
  multiple: boolean;
  resolution_source: string;
  paths: string[];
  host_paths: string[];
}

/** Ephemeral prefill context passed via React Router state from Run Next → Pipelines. */
export interface PrefillContext {
  runId: number;
  /** Manifest ID of the upstream pipeline, e.g. "brainchop". */
  sourcePipelineId: string;
  /** Display name of the upstream pipeline, e.g. "BrainChop". */
  sourceDisplayName: string;
  /** Artifact type string, e.g. "skull_stripped_t1". */
  artifactType: string;
  /** Label of the artifact being passed, e.g. "Skull-Stripped Brain". */
  artifactLabel: string;
  /** Parameter name to pre-fill, e.g. "t1". Null when accept_dataset_slot is true. */
  param: string | null;
  /** Host-accessible path to pre-fill. Null when accept_dataset_slot is true. */
  path: string | null;
  /** True when the pipeline receives the dataset via the dataset selector, not a named param. */
  isDatasetSlot: boolean;
}

export interface RunLineage {
  upstream_run_id: number;
  upstream_pipeline_id: string;
  upstream_pipeline_display_name: string | null;
  artifact_type: string;
  artifact_label: string;
  injected_param: string | null;
  injected_path: string | null;
}

export interface RunMetadata {
  run_id: number;
  pipeline_id: string;
  pipeline_display_name: string | null;
  pipeline_version: string;
  status: string;
  compute_profile: string | null;
  execution_type: "docker" | "native";
  container_image: string | null;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  runtime_seconds: number | null;
  dataset_id: number;
  dataset_name: string | null;
  dataset_path: string | null;
  output_dir: string | null;
  command_preview: string | null;
  params: Record<string, unknown>;
  lineage: RunLineage | null;
  registered_dataset_id?: number | null;
  registered_dataset_name?: string | null;
}

export interface RunResults {
  reports: RunResultFile[];
  metrics: RunResultFile[];
  group_tables?: RunResultFile[];
  images?: RunResultFile[];
  connectivity_matrices?: RunResultFile[];
  timeseries?: RunResultFile[];
  connectivity_metadata?: RunResultFile[];
  roi_statistics?: RunResultFile[];
  roi_extraction?: RunResultFile[];
  group_summary?: Record<string, unknown> | null;
  niftis?: RunResultFile[];
  artifacts: RunArtifact[];
  metadata?: RunMetadata;
}

export function fetchRunResults(runId: number): Promise<RunResults> {
  return apiFetch<RunResults>(`/runs/${runId}/results`);
}

export interface QueueEntry {
  run_id: number;
  position: number;
}

export interface QueueStatus {
  running_run_id: number | null;
  queued: QueueEntry[];
}

export function fetchQueue(): Promise<QueueStatus> {
  return apiFetch<QueueStatus>("/runs/queue");
}

export function cancelRun(runId: number): Promise<{ cancelled: boolean; was_queued?: boolean; cancel_requested?: boolean }> {
  return apiFetch(`/runs/${runId}/cancel`, { method: "POST" });
}

export function retryRun(runId: number): Promise<Run> {
  return apiFetch<Run>(`/runs/${runId}/retry`, { method: "POST" });
}

export function rerunRun(runId: number): Promise<Run> {
  return apiFetch<Run>(`/runs/${runId}/rerun`, { method: "POST" });
}

export async function deleteRun(runId: number): Promise<void> {
  const res = await fetch(`${BASE_URL}/runs/${runId}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error((detail as { detail?: string }).detail ?? res.statusText);
  }
}

export interface CompatiblePipeline {
  pipeline_id: string;
  display_name: string;
  category: string | null;
  input_type: string | null;
  compute_profile: ComputeProfile | null;
  pipeline_description: string | null;
  accept_type: string | null;
  accept_param: string | null;
  accept_dataset_slot: boolean;
  accept_label: string | null;
  accept_description: string | null;
}

export function fetchCompatiblePipelines(artifactType: string): Promise<CompatiblePipeline[]> {
  return apiFetch<CompatiblePipeline[]>(`/pipelines/compatible?artifact_type=${encodeURIComponent(artifactType)}`);
}

export function fetchRunFile<T>(runId: number, filePath: string): Promise<T> {
  return apiFetch<T>(`/runs/${runId}/files/${filePath}`);
}

export async function fetchRunTextFile(runId: number, filePath: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/runs/${runId}/files/${filePath}`);
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error((detail as { detail?: string }).detail ?? res.statusText);
  }
  return res.text();
}

export interface ProvenanceEvent {
  event_type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface RunProvenance {
  run_id: number;
  pipeline_version: string;
  container_digest: string | null;
  params: Record<string, unknown>;
  status: string;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  events: ProvenanceEvent[];
}

export function fetchRunProvenance(runId: number): Promise<RunProvenance> {
  return apiFetch<RunProvenance>(`/runs/${runId}/provenance`);
}

// ------------------------------------------------------------------ //
// Remote Hosts                                                         //
// ------------------------------------------------------------------ //

export interface RemoteHost {
  id: number;
  display_name: string;
  hostname: string;
  ssh_port: number;
  username: string;
  key_path: string;
  remote_work_root: string;
  docker_host: string | null;
  enabled: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface RemoteHostCreate {
  display_name: string;
  hostname: string;
  ssh_port?: number;
  username: string;
  key_path: string;
  remote_work_root: string;
  docker_host?: string | null;
  enabled?: boolean;
  notes?: string | null;
}

export interface PreflightCheck {
  name: string;
  passed: boolean;
  value: string | null;
  detail: string | null;
}

export interface PreflightResult {
  connected: boolean;
  checks: PreflightCheck[];
  errors: string[];
  warnings: string[];
}

export function fetchRemoteHosts(): Promise<RemoteHost[]> {
  return apiFetch<RemoteHost[]>("/remote-hosts");
}

export function createRemoteHost(body: RemoteHostCreate): Promise<RemoteHost> {
  return apiFetch<RemoteHost>("/remote-hosts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function updateRemoteHost(id: number, body: Partial<RemoteHostCreate>): Promise<RemoteHost> {
  return apiFetch<RemoteHost>(`/remote-hosts/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteRemoteHost(id: number): Promise<void> {
  return apiFetch<void>(`/remote-hosts/${id}`, { method: "DELETE" });
}

export function testRemoteHostConnection(id: number): Promise<PreflightResult> {
  return apiFetch<PreflightResult>(`/remote-hosts/${id}/preflight`, { method: "POST" });
}

// ------------------------------------------------------------------ //
// Wizard — DICOM Mapping                                               //
// ------------------------------------------------------------------ //

export interface WizardSeriesClassification {
  modality: string;
  confidence: "high" | "medium" | "low";
  reason: string;
  suggested_datatype: string | null;
  suggested_suffix: string | null;
  skip_recommended: boolean;
}

export interface WizardDiscoveredSeries {
  series_number: number | null;
  acquisition_time: string | null;
  series_description: string | null;
  protocol_name: string | null;
  image_type: string[] | null;
  tr: number | null;
  te: number | null;
  inversion_time: number | null;
  flip_angle: number | null;
  echo_number: number | null;
  phase_encoding_direction: string | null;
  manufacturer: string | null;
  manufacturers_model_name: string | null;
  magnetic_field_strength: number | null;
  slice_thickness: number | null;
  raw_sidecar: Record<string, unknown>;
  classification: WizardSeriesClassification;
}

export interface WizardScoutResponse {
  series: WizardDiscoveredSeries[];
  dicom_path: string;
  participant_id: string;
  session_id: string | null;
  helper_log: string;
}

export function scoutDicom(
  dicomPath: string,
  participantId: string,
  sessionId?: string,
): Promise<WizardScoutResponse> {
  return apiFetch<WizardScoutResponse>("/wizard/dcm2bids/scout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dicom_path: dicomPath,
      participant_id: participantId,
      session_id: sessionId || null,
    }),
  });
}


export interface WizardLaunchResponse {
  run_id: number;
  config_path: string;
}

export function launchDcm2bids(
  dicomPath: string,
  participantId: string,
  sessionId: string | null,
  datasetName: string,
  config: Record<string, unknown>,
): Promise<WizardLaunchResponse> {
  return apiFetch<WizardLaunchResponse>("/wizard/dcm2bids/launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dicom_path: dicomPath,
      participant_id: participantId,
      session_id: sessionId || null,
      dataset_name: datasetName || null,
      config,
    }),
  });
}


// ── Dashboard types ───────────────────────────────────────────────────────────

export interface DashboardRunCounts {
  total: number;
  success: number;
  failed: number;
  running: number;
  pending: number;
  success_rate: number;
}

export interface DashboardRunStats {
  most_recent_run_id: number | null;
  most_recent_run_status: string | null;
  most_recent_pipeline: string | null;
  most_recent_finished_at: string | null;
  most_common_pipeline: string | null;
  pipeline_run_counts: Record<string, number>;
}

export interface DashboardRuntimeStats {
  total_seconds: number;
  median_seconds: number | null;
  slowest_run_id: number | null;
  slowest_run_seconds: number | null;
  fastest_run_id: number | null;
  fastest_run_seconds: number | null;
  by_pipeline: Record<string, number>;
}

export interface DashboardStorage {
  total_bytes: number;
  by_pipeline: Record<string, number>;
  artifact_count: number;
  largest_run_id: number | null;
  largest_run_bytes: number;
}

export interface DashboardRecentRun {
  id: number;
  pipeline_manifest_id: string;
  pipeline_version: string;
  dataset_id: number;
  status: string;
  source_run_id: number | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface DatasetDashboard {
  dataset: Dataset;
  run_counts: DashboardRunCounts;
  run_stats: DashboardRunStats;
  runtime_stats: DashboardRuntimeStats;
  storage: DashboardStorage;
  recent_runs: DashboardRecentRun[];
}

export function fetchDatasetDashboard(datasetId: number): Promise<DatasetDashboard> {
  return apiFetch<DatasetDashboard>(`/datasets/${datasetId}/dashboard`);
}

// ── Artifact types ────────────────────────────────────────────────────────────

export interface DatasetArtifact {
  run_id: number;
  pipeline_id: string;
  pipeline_version: string;
  run_status: string;
  run_started_at: string | null;
  run_finished_at: string | null;
  source_run_id: number | null;
  type: string;
  label: string;
  description: string;
  resolution_source: string;
  multiple: boolean;
  path: string;
  is_directory: boolean;
  size_bytes: number;
  output_dir: string;
  atlas_metadata?: {
    atlas_id?: string | null;
    atlas?: string | null;
    n_rois?: number | null;
    matrix_shape?: [number, number] | null;
    correlation_method?: string | null;
  } | null;
}

export function fetchDatasetArtifacts(datasetId: number): Promise<DatasetArtifact[]> {
  return apiFetch<DatasetArtifact[]>(`/datasets/${datasetId}/artifacts`);
}

// ------------------------------------------------------------------ //
// Saved Workflows                                                      //
// ------------------------------------------------------------------ //

export const WORKFLOW_SCHEMA_VERSION = "neuroforge-workflow-v1";

export interface WorkflowSummary {
  id: number;
  name: string;
  description: string | null;
  dataset_id: number | null;
  tags: string[];
  schema_version: string;
  is_template: boolean;
  is_favorite: boolean;
  is_archived: boolean;
  template_source_id: number | null;
  node_count: number;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRead extends WorkflowSummary {
  state: Record<string, unknown>;
}

export interface WorkflowCreate {
  name: string;
  description?: string | null;
  dataset_id?: number | null;
  tags?: string[];
  state: Record<string, unknown>;
  schema_version?: string;
  is_template?: boolean;
  is_favorite?: boolean;
  is_archived?: boolean;
  template_source_id?: number | null;
}

export interface WorkflowUpdate {
  name?: string;
  description?: string | null;
  dataset_id?: number | null;
  tags?: string[];
  state?: Record<string, unknown>;
  is_template?: boolean;
  is_favorite?: boolean;
  is_archived?: boolean;
}

export function fetchWorkflows(): Promise<WorkflowSummary[]> {
  return apiFetch<WorkflowSummary[]>("/workflows");
}

export function fetchWorkflow(id: number): Promise<WorkflowRead> {
  return apiFetch<WorkflowRead>(`/workflows/${id}`);
}

export function createWorkflow(body: WorkflowCreate): Promise<WorkflowRead> {
  return apiFetch<WorkflowRead>("/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema_version: WORKFLOW_SCHEMA_VERSION, ...body }),
  });
}

export function updateWorkflow(id: number, body: WorkflowUpdate): Promise<WorkflowRead> {
  return apiFetch<WorkflowRead>(`/workflows/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteWorkflow(id: number): Promise<void> {
  return apiFetch<void>(`/workflows/${id}`, { method: "DELETE" });
}

export function duplicateWorkflow(id: number): Promise<WorkflowRead> {
  return apiFetch<WorkflowRead>(`/workflows/${id}/duplicate`, { method: "POST" });
}

export function promoteWorkflowToTemplate(id: number): Promise<WorkflowRead> {
  return apiFetch<WorkflowRead>(`/workflows/${id}/promote-template`, { method: "POST" });
}

// ------------------------------------------------------------------ //
// Reports                                                              //
// ------------------------------------------------------------------ //

export interface ReportSummary {
  id: number;
  dataset_id: number;
  status: "generating" | "ready" | "failed";
  error_message: string | null;
  html_path: string | null;
  md_path: string | null;
  json_path: string | null;
  zip_path: string | null;
  pdf_path: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface ReportPipelineDiff {
  pipeline: string;
  change: "added" | "removed" | "modified";
  details?: {
    version?: { a: string | null; b: string | null };
    artifact_count?: { a: number; b: number };
    params?: Record<string, { a: unknown; b: unknown }>;
  };
}

export interface ReportComparison {
  report_a: { id: number; created_at: string; total_runs: number; success_runs: number };
  report_b: { id: number; created_at: string; total_runs: number; success_runs: number };
  runs: { added: number[]; removed: number[] };
  pipelines: ReportPipelineDiff[];
  warnings: { added: string[]; removed: string[] };
  artifacts: { a: number; b: number; delta: number };
}

export function generateReport(datasetId: number): Promise<{ report_id: number; status: string; created_at: string }> {
  return apiFetch(`/datasets/${datasetId}/reports`, { method: "POST" });
}

export function listReports(datasetId: number): Promise<ReportSummary[]> {
  return apiFetch<ReportSummary[]>(`/datasets/${datasetId}/reports`);
}

export function getReport(datasetId: number, reportId: number): Promise<ReportSummary> {
  return apiFetch<ReportSummary>(`/datasets/${datasetId}/reports/${reportId}`);
}

export function deleteReport(datasetId: number, reportId: number): Promise<void> {
  return apiFetch(`/datasets/${datasetId}/reports/${reportId}`, { method: "DELETE" });
}

export function retryReport(datasetId: number, reportId: number): Promise<{ report_id: number; status: string }> {
  return apiFetch(`/datasets/${datasetId}/reports/${reportId}/retry`, { method: "POST" });
}

export function compareReports(datasetId: number, a: number, b: number): Promise<ReportComparison> {
  return apiFetch<ReportComparison>(`/datasets/${datasetId}/reports/compare?a=${a}&b=${b}`);
}

export function reportDownloadUrl(datasetId: number, reportId: number, fmt: "html" | "md" | "json" | "zip" | "pdf"): string {
  return `${BASE_URL}/datasets/${datasetId}/reports/${reportId}/download/${fmt}`;
}

export function reportViewUrl(datasetId: number, reportId: number): string {
  return `${BASE_URL}/datasets/${datasetId}/reports/${reportId}/view`;
}

// ------------------------------------------------------------------ //
// Projects                                                             //
// ------------------------------------------------------------------ //

export interface ProjectSummary {
  id: number;
  title: string;
  description: string | null;
  institution: string | null;
  lab: string | null;
  pi_name: string | null;
  collaborators: string[];
  tags: string[];
  status: string;
  dataset_count: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectRead extends ProjectSummary {
  note_count: number;
}

export interface ProjectCreate {
  title: string;
  description?: string | null;
  institution?: string | null;
  lab?: string | null;
  pi_name?: string | null;
  collaborators?: string[];
  tags?: string[];
  status?: string;
}

export interface ProjectUpdate {
  title?: string;
  description?: string | null;
  institution?: string | null;
  lab?: string | null;
  pi_name?: string | null;
  collaborators?: string[];
  tags?: string[];
  status?: string;
}

export interface ProjectNote {
  id: number;
  project_id: number;
  title: string;
  content_md: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectStats {
  dataset_count: number;
  run_count: number;
  success_run_count: number;
  report_count: number;
  note_count: number;
  pipeline_breakdown: Record<string, number>;
  storage_bytes: number;
}

export interface TimelineEvent {
  event_type: string;
  label: string;
  details: Record<string, unknown>;
  timestamp: string;
}

export interface PublicationCheckItem {
  key: string;
  label: string;
  done: boolean;
  detail: string | null;
}

export interface PublicationStatus {
  checklist: PublicationCheckItem[];
  completion_pct: number;
}

export interface ProjectDataset {
  id: number;
  name: string | null;
  path: string;
  validation_status: string;
  created_at: string;
}

export interface SearchResults {
  query: string;
  total: number;
  results: {
    datasets: Array<{ id: number; name: string | null; path: string }>;
    runs: Array<{ id: number; pipeline: string; status: string; created_at: string; dataset_id: number }>;
    notes: Array<{ id: number; title: string; snippet: string; updated_at: string }>;
    reports: Array<{ id: number; dataset_id: number; dataset_name: string; status: string; created_at: string }>;
  };
}

export function fetchProjects(): Promise<ProjectSummary[]> {
  return apiFetch<ProjectSummary[]>("/projects");
}

export function fetchProject(id: number): Promise<ProjectRead> {
  return apiFetch<ProjectRead>(`/projects/${id}`);
}

export function createProject(payload: ProjectCreate): Promise<ProjectRead> {
  return apiFetch<ProjectRead>("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function updateProject(id: number, payload: ProjectUpdate): Promise<ProjectRead> {
  return apiFetch<ProjectRead>(`/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function deleteProject(id: number): Promise<void> {
  return apiFetch<void>(`/projects/${id}`, { method: "DELETE" });
}

export function fetchProjectDatasets(projectId: number): Promise<ProjectDataset[]> {
  return apiFetch<ProjectDataset[]>(`/projects/${projectId}/datasets`);
}

export function assignDatasetToProject(projectId: number, datasetId: number): Promise<void> {
  return apiFetch<void>(`/projects/${projectId}/datasets/${datasetId}`, { method: "POST" });
}

export function unassignDatasetFromProject(projectId: number, datasetId: number): Promise<void> {
  return apiFetch<void>(`/projects/${projectId}/datasets/${datasetId}`, { method: "DELETE" });
}

export function fetchProjectNotes(projectId: number): Promise<ProjectNote[]> {
  return apiFetch<ProjectNote[]>(`/projects/${projectId}/notes`);
}

export function createProjectNote(projectId: number, title: string, content_md: string): Promise<ProjectNote> {
  return apiFetch<ProjectNote>(`/projects/${projectId}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, content_md }),
  });
}

export function updateProjectNote(projectId: number, noteId: number, payload: { title?: string; content_md?: string }): Promise<ProjectNote> {
  return apiFetch<ProjectNote>(`/projects/${projectId}/notes/${noteId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function deleteProjectNote(projectId: number, noteId: number): Promise<void> {
  return apiFetch<void>(`/projects/${projectId}/notes/${noteId}`, { method: "DELETE" });
}

export function fetchProjectStats(projectId: number): Promise<ProjectStats> {
  return apiFetch<ProjectStats>(`/projects/${projectId}/stats`);
}

export function fetchProjectTimeline(projectId: number): Promise<TimelineEvent[]> {
  return apiFetch<TimelineEvent[]>(`/projects/${projectId}/timeline`);
}

export function fetchPublicationStatus(projectId: number): Promise<PublicationStatus> {
  return apiFetch<PublicationStatus>(`/projects/${projectId}/publication-status`);
}

export function searchProject(projectId: number, q: string): Promise<SearchResults> {
  return apiFetch<SearchResults>(`/projects/${projectId}/search?q=${encodeURIComponent(q)}`);
}

export function fetchManuscript(projectId: number): Promise<{ content: string; filename: string }> {
  return apiFetch<{ content: string; filename: string }>(`/projects/${projectId}/manuscript`);
}
