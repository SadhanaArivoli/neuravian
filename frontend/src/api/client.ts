const BASE_URL = import.meta.env.VITE_API_URL ?? "/api";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, init);
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error((detail as { detail?: string }).detail ?? res.statusText);
  }
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
  positional_index?: number;
  multiple?: boolean;
  mount?: boolean;
}

export interface PipelineKnownError {
  pattern: string;
  explanation: string;
  fix_hint?: string;
}

export type ComputeProfile = "local-ok" | "local-slow" | "local-unsafe";
export type PipelineCategory = "conversion" | "validation" | "quality_control" | "segmentation" | "preprocessing" | "deidentification";
export type PipelineInputType = "dicom" | "nifti" | "bids_dataset";

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

export interface RunSummary {
  id: number;
  pipeline_manifest_id: string;
  pipeline_version: string;
  dataset_id: number;
  status: "pending" | "running" | "success" | "failed";
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
}

export interface RunResults {
  reports: RunResultFile[];
  metrics: RunResultFile[];
  niftis?: RunResultFile[];
  artifacts: RunArtifact[];
  metadata?: RunMetadata;
}

export function fetchRunResults(runId: number): Promise<RunResults> {
  return apiFetch<RunResults>(`/runs/${runId}/results`);
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

