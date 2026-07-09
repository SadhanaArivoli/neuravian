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

export interface PipelineSummary {
  id: string;
  display_name: string;
  description: string;
  homepage?: string;
  container: PipelineContainer;
  compute_profile?: ComputeProfile;
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

export interface RunResults {
  reports: RunResultFile[];
  metrics: RunResultFile[];
}

export function fetchRunResults(runId: number): Promise<RunResults> {
  return apiFetch<RunResults>(`/runs/${runId}/results`);
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
