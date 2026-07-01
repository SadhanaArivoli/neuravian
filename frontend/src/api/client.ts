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
}

export interface PipelineKnownError {
  pattern: string;
  explanation: string;
  fix_hint?: string;
}

export interface PipelineSummary {
  id: string;
  display_name: string;
  description: string;
  homepage?: string;
  container: PipelineContainer;
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
