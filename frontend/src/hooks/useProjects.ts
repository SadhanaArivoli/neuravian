import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  assignDatasetToProject,
  createProject,
  createProjectNote,
  deleteProject,
  deleteProjectNote,
  fetchManuscript,
  fetchProject,
  fetchProjectDatasets,
  fetchProjectNotes,
  fetchProjectStats,
  fetchProjectTimeline,
  fetchProjects,
  fetchPublicationStatus,
  searchProject,
  unassignDatasetFromProject,
  updateProject,
  updateProjectNote,
  type ProjectCreate,
  type ProjectUpdate,
} from "../api/client";

export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: fetchProjects, staleTime: 10_000 });
}

export function useProject(id: number | undefined) {
  return useQuery({
    queryKey: ["project", id],
    queryFn: () => fetchProject(id!),
    enabled: id != null,
    staleTime: 10_000,
  });
}

export function useProjectDatasets(projectId: number | undefined) {
  return useQuery({
    queryKey: ["project-datasets", projectId],
    queryFn: () => fetchProjectDatasets(projectId!),
    enabled: projectId != null,
    staleTime: 10_000,
  });
}

export function useProjectNotes(projectId: number | undefined) {
  return useQuery({
    queryKey: ["project-notes", projectId],
    queryFn: () => fetchProjectNotes(projectId!),
    enabled: projectId != null,
    staleTime: 5_000,
  });
}

export function useProjectStats(projectId: number | undefined) {
  return useQuery({
    queryKey: ["project-stats", projectId],
    queryFn: () => fetchProjectStats(projectId!),
    enabled: projectId != null,
    staleTime: 15_000,
  });
}

export function useProjectTimeline(projectId: number | undefined) {
  return useQuery({
    queryKey: ["project-timeline", projectId],
    queryFn: () => fetchProjectTimeline(projectId!),
    enabled: projectId != null,
    staleTime: 15_000,
  });
}

export function usePublicationStatus(projectId: number | undefined) {
  return useQuery({
    queryKey: ["publication-status", projectId],
    queryFn: () => fetchPublicationStatus(projectId!),
    enabled: projectId != null,
    staleTime: 30_000,
  });
}

export function useProjectSearch(projectId: number | undefined, q: string) {
  return useQuery({
    queryKey: ["project-search", projectId, q],
    queryFn: () => searchProject(projectId!, q),
    enabled: projectId != null && q.trim().length > 0,
    staleTime: 5_000,
  });
}

export function useManuscript(projectId: number | undefined) {
  return useQuery({
    queryKey: ["manuscript", projectId],
    queryFn: () => fetchManuscript(projectId!),
    enabled: projectId != null,
    staleTime: 30_000,
  });
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ProjectCreate) => createProject(payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: ProjectUpdate }) => updateProject(id, payload),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["project", id] });
    },
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => deleteProject(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export function useAssignDataset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, datasetId }: { projectId: number; datasetId: number }) =>
      assignDatasetToProject(projectId, datasetId),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: ["project-datasets", projectId] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["project-stats", projectId] });
    },
  });
}

export function useUnassignDataset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, datasetId }: { projectId: number; datasetId: number }) =>
      unassignDatasetFromProject(projectId, datasetId),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: ["project-datasets", projectId] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["project-stats", projectId] });
    },
  });
}

export function useCreateNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, title, content_md }: { projectId: number; title: string; content_md: string }) =>
      createProjectNote(projectId, title, content_md),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: ["project-notes", projectId] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["project-timeline", projectId] });
    },
  });
}

export function useUpdateNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      noteId,
      payload,
    }: {
      projectId: number;
      noteId: number;
      payload: { title?: string; content_md?: string };
    }) => updateProjectNote(projectId, noteId, payload),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: ["project-notes", projectId] });
    },
  });
}

export function useDeleteNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, noteId }: { projectId: number; noteId: number }) =>
      deleteProjectNote(projectId, noteId),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: ["project-notes", projectId] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });
}
