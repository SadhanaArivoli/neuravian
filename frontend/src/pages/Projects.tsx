import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  useCreateProject,
  useDeleteProject,
  useProjects,
} from "../hooks/useProjects";
import type { ProjectCreate } from "../api/client";
import { EmptyState } from "../components/primitives/EmptyState";
import { WorkbenchIcons } from "../lib/iconRegistry";
import { useWorkspace } from "../context/WorkspaceContext";
import { useCloudWorkspace } from "../hooks/useCloudWorkspace";
import { useAllCloudSnapshots } from "../hooks/useAllCloudSnapshots";

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<string, string> = {
  active: "bg-green-500/12 text-green-300 border border-green-500/20",
  paused: "bg-amber-500/12 text-amber-300 border border-amber-500/20",
  completed: "bg-accent/12 text-accent border border-accent/20",
  archived: "bg-white/8 text-gray-500 border border-white/10",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${STATUS_STYLE[status] ?? STATUS_STYLE.active}`}>
      {status}
    </span>
  );
}

// ── Create project modal ──────────────────────────────────────────────────────

function CreateProjectModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const create = useCreateProject();
  const [form, setForm] = useState<ProjectCreate>({
    title: "",
    institution: "",
    lab: "",
    pi_name: "",
    description: "",
    collaborators: [],
    tags: [],
    status: "active",
  });
  const [collaboratorsRaw, setCollaboratorsRaw] = useState("");
  const [tagsRaw, setTagsRaw] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) { setError("Title is required."); return; }
    setError(null);
    try {
      const proj = await create.mutateAsync({
        ...form,
        collaborators: collaboratorsRaw.split(",").map(s => s.trim()).filter(Boolean),
        tags: tagsRaw.split(",").map(s => s.trim()).filter(Boolean),
      });
      onClose();
      navigate(`/projects/${proj.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function field(label: string, key: keyof ProjectCreate, placeholder = "") {
    return (
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">{label}</label>
        <input
          className="w-full rounded-md border border-white/15 bg-surface-overlay px-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-500 focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
          value={(form[key] as string) ?? ""}
          onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
          placeholder={placeholder}
        />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-white/10 bg-surface shadow-2xl p-6 space-y-4">
        <h2 className="text-lg font-semibold text-white">New Research Project</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          {field("Title *", "title", "e.g. Resting-state fMRI connectivity study")}
          {field("Principal Investigator", "pi_name", "e.g. Dr. Jane Smith")}
          {field("Institution", "institution", "e.g. Harvard University")}
          {field("Lab / Group", "lab", "e.g. Cognitive Neuroscience Lab")}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Description</label>
            <textarea
              className="w-full rounded-md border border-white/15 bg-surface-overlay px-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-500 focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none"
              rows={3}
              value={form.description ?? ""}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Brief description of research aims"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Collaborators (comma-separated)</label>
            <input
              className="w-full rounded-md border border-white/15 bg-surface-overlay px-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-500 focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
              value={collaboratorsRaw}
              onChange={e => setCollaboratorsRaw(e.target.value)}
              placeholder="Alice Chen, Bob Kim"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Tags (comma-separated)</label>
            <input
              className="w-full rounded-md border border-white/15 bg-surface-overlay px-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-500 focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
              value={tagsRaw}
              onChange={e => setTagsRaw(e.target.value)}
              placeholder="fMRI, connectivity, aging"
            />
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={create.isPending}
              className="flex-1 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50 transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50"
            >
              {create.isPending ? "Creating…" : "Create Project"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-white/15 px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors focus:outline-none"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Project card ──────────────────────────────────────────────────────────────

function ProjectCard({ project, onDelete }: {
  project: { id: number; title: string; description: string | null; institution: string | null; pi_name: string | null; tags: string[]; status: string; dataset_count: number; updated_at: string };
  onDelete: (id: number) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="rounded-lg border border-white/8 bg-surface-raised p-5 flex flex-col gap-3 hover:border-white/20 transition-colors">
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          <Link to={`/projects/${project.id}`} className="text-base font-semibold text-gray-100 hover:text-white transition-colors line-clamp-1">
            {project.title}
          </Link>
          {(project.pi_name || project.institution) && (
            <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">
              {[project.pi_name, project.institution].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
        <StatusBadge status={project.status} />
      </div>

      {project.description && (
        <p className="text-xs text-gray-400 leading-relaxed line-clamp-2">{project.description}</p>
      )}

      {project.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {project.tags.map(tag => (
            <span key={tag} className="rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-gray-500">{tag}</span>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-1 border-t border-white/8">
        <span className="text-[11px] text-gray-600 font-mono">
          {project.dataset_count} dataset{project.dataset_count !== 1 ? "s" : ""} · updated {new Date(project.updated_at).toLocaleDateString()}
        </span>
        <div className="flex items-center gap-2">
          <Link to={`/projects/${project.id}`} className="text-xs text-accent hover:text-accent-hover transition-colors">
            Open →
          </Link>
          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <button onClick={() => onDelete(project.id)} className="text-[10px] text-red-400 hover:text-red-300">Confirm</button>
              <button onClick={() => setConfirmDelete(false)} className="text-[10px] text-gray-500 hover:text-gray-300">Cancel</button>
            </div>
          ) : (
            <button onClick={() => setConfirmDelete(true)} className="text-[10px] text-gray-600 hover:text-red-400 transition-colors">Delete</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Projects() {
  const { selected, cloudProfiles } = useWorkspace();
  const { data: projects, isLoading, error } = useProjects();
  const deleteProject = useDeleteProject();
  const [showCreate, setShowCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [pushing, setPushing] = useState<Record<string, boolean>>({});
  const [pushErrors, setPushErrors] = useState<Record<string, string>>({});
  const isCloud = Boolean(window.neuroforgeDesktop) && selected.startsWith("cloud:");
  const isAll = Boolean(window.neuroforgeDesktop) && selected === "all";
  const cloud = useCloudWorkspace();
  const allCloud = useAllCloudSnapshots();

  const filtered = (projects ?? []).filter(p => statusFilter === "all" || p.status === statusFilter);

  async function handlePushToCloud(projectId: number, profileId: string) {
    const project = projects?.find(p => p.id === projectId);
    if (!project || !window.neuroforgeDesktop) return;
    const key = `${projectId}-${profileId}`;
    setPushing(prev => ({ ...prev, [key]: true }));
    setPushErrors(prev => { const n = { ...prev }; delete n[key]; return n; });
    try {
      await window.neuroforgeDesktop.pushCloudProject({
        profileId,
        project: {
          title: project.title,
          description: project.description ?? undefined,
          institution: project.institution ?? undefined,
          lab: project.lab ?? undefined,
          pi_name: project.pi_name ?? undefined,
          collaborators: project.collaborators ?? [],
          tags: project.tags ?? [],
          status: project.status,
        },
      });
    } catch (e) {
      setPushErrors(prev => ({ ...prev, [key]: e instanceof Error ? e.message : "Push failed" }));
    } finally {
      setPushing(prev => { const n = { ...prev }; delete n[key]; return n; });
    }
  }

  async function handleDelete(id: number) {
    await deleteProject.mutateAsync(id);
  }

  // ── All Workspaces branch ─────────────────────────────────────────────────
  if (isAll) {
    const localProjects = projects ?? [];
    const cloudLoading = allCloud.some((c) => c.loading && !c.snapshot);
    const allCloudProjects: Array<{ profileName: string; profileId: string; proj: Record<string, unknown> & { id: number; remoteKey: string } }> = [];
    for (const { profile, snapshot } of allCloud) {
      for (const p of snapshot?.projects ?? []) {
        allCloudProjects.push({ profileName: profile.name, profileId: profile.id, proj: p });
      }
    }

    return (
      <div className="p-6 max-w-5xl">
        {showCreate && <CreateProjectModal onClose={() => setShowCreate(false)} />}
        <div className="flex items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-gray-100">Research Projects</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              All Workspaces · {localProjects.length} local · {allCloudProjects.length} cloud
            </p>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors"
          >
            + New Project
          </button>
        </div>

        {cloudLoading && <p className="text-xs text-gray-500 animate-pulse mb-4">Syncing cloud projects…</p>}

        {localProjects.length === 0 && allCloudProjects.length === 0 && !isLoading && !cloudLoading && (
          <EmptyState
            icon={<WorkbenchIcons.project className="h-8 w-8 text-violet-300" aria-hidden="true" />}
            title="No research projects yet"
            description="Create a project to organize datasets, analyses, notes, and publication outputs."
            action={<button onClick={() => setShowCreate(true)} className="rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover">Create your first project</button>}
          />
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {/* Local projects */}
          {localProjects.map((p) => (
            <div key={`local-${p.id}`} className="rounded-lg border border-white/8 bg-surface-raised p-5 flex flex-col gap-3 hover:border-white/20 transition-colors">
              <div className="flex items-start justify-between gap-2 min-w-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link to={`/projects/${p.id}`} className="text-base font-semibold text-gray-100 hover:text-white transition-colors line-clamp-1">{p.title}</Link>
                    <span className="shrink-0 rounded-full border border-white/15 bg-white/8 px-2 py-0.5 text-[10px] text-gray-400">Local</span>
                  </div>
                  {(p.pi_name || p.institution) && (
                    <p className="text-xs text-gray-500 mt-0.5">{[p.pi_name, p.institution].filter(Boolean).join(" · ")}</p>
                  )}
                </div>
                <StatusBadge status={p.status} />
              </div>
              {p.description && <p className="text-xs text-gray-400 leading-relaxed line-clamp-2">{p.description}</p>}
              {p.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {p.tags.map(tag => <span key={tag} className="rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-gray-500">{tag}</span>)}
                </div>
              )}
              <div className="pt-1 border-t border-white/8 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-gray-600 font-mono">{p.dataset_count} dataset{p.dataset_count !== 1 ? "s" : ""}</span>
                  <Link to={`/projects/${p.id}`} className="text-xs text-accent hover:text-accent-hover transition-colors">Open →</Link>
                </div>
                {/* Push-to-cloud buttons */}
                {cloudProfiles.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {cloudProfiles.map((cp) => {
                      const key = `${p.id}-${cp.id}`;
                      return (
                        <div key={cp.id}>
                          <button
                            onClick={() => void handlePushToCloud(p.id, cp.id)}
                            disabled={pushing[key]}
                            className="rounded border border-accent/20 bg-accent/8 px-2 py-0.5 text-[10px] text-accent hover:bg-accent/15 disabled:opacity-40 transition-colors"
                          >
                            {pushing[key] ? "Pushing…" : `↑ ${cp.name}`}
                          </button>
                          {pushErrors[key] && <p className="text-[10px] text-red-400 mt-0.5">{pushErrors[key]}</p>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Cloud projects */}
          {allCloudProjects.map(({ profileName, proj }) => (
            <div key={`cloud-${proj.remoteKey}`} className="rounded-xl border border-accent/20 bg-surface-raised p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-semibold text-gray-100 text-sm line-clamp-2">
                  {(proj.name as string | undefined) ?? (proj.title as string | undefined) ?? `Project #${proj.id}`}
                </h3>
                <span className="shrink-0 rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-[10px] text-accent">Cloud · {profileName}</span>
              </div>
              {!!proj.description && <p className="text-xs text-gray-500 line-clamp-2">{String(proj.description)}</p>}
              {!!proj.status && (
                <span className="self-start rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-gray-400 capitalize">{String(proj.status)}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (isCloud) {
    const cloudProjects = cloud.snapshot?.projects ?? [];
    return (
      <div className="p-6 max-w-5xl">
        <div className="flex items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-gray-100">Research Projects</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              {cloud.profile?.name ?? "Cloud workspace"} ·{" "}
              {cloud.loading ? "Syncing…" : cloud.online ? "Online" : "Offline (cached)"} ·{" "}
              {cloudProjects.length} project{cloudProjects.length !== 1 ? "s" : ""}
            </p>
          </div>
          <button
            onClick={() => void cloud.sync()}
            disabled={cloud.loading}
            className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-400 hover:text-white disabled:opacity-40 transition-colors"
          >
            {cloud.loading ? "Syncing…" : "Sync now"}
          </button>
        </div>

        {cloud.error && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
            {cloud.error} — showing cached data.
          </div>
        )}

        {cloud.loading && !cloud.snapshot && (
          <p className="text-sm text-gray-500">Syncing cloud projects…</p>
        )}

        {!cloud.loading && cloudProjects.length === 0 && (
          <div className="rounded-lg border border-white/10 bg-surface-raised px-6 py-8 text-center">
            <p className="text-sm text-gray-400">No projects found in this cloud workspace.</p>
          </div>
        )}

        {cloudProjects.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {cloudProjects.map((p) => {
              const proj = p as Record<string, unknown>;
              return (
                <div key={p.id} className="rounded-xl border border-white/8 bg-surface-raised p-4">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-semibold text-gray-100 text-sm">
                      {(proj.name as string | undefined) ?? `Project #${p.id}`}
                    </h3>
                    <span className="shrink-0 rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-[10px] text-accent">Cloud</span>
                  </div>
                  {!!proj.description && (
                    <p className="mt-1.5 text-xs text-gray-500 line-clamp-2">{String(proj.description)}</p>
                  )}
                  <p className="mt-2 text-[10px] font-mono text-gray-600 break-all">{p.remoteKey}</p>
                  <div className="mt-3 flex items-center gap-2">
                    {!!proj.status && (
                      <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-gray-400 capitalize">
                        {String(proj.status)}
                      </span>
                    )}
                    {!!proj.pi_name && (
                      <span className="text-[10px] text-gray-500">{String(proj.pi_name)}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl">
      {showCreate && <CreateProjectModal onClose={() => setShowCreate(false)} />}

      {/* Header */}
      <div className="flex items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-100">Research Projects</h1>
          <p className="text-sm text-gray-500 mt-0.5">Each project organizes datasets, analyses, notes, and publication outputs.</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50"
        >
          + New Project
        </button>
      </div>

      {/* Filter tabs */}
      {projects && projects.length > 0 && (
        <div className="flex gap-1 mb-4">
          {["all", "active", "paused", "completed", "archived"].map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                statusFilter === s
                  ? "bg-accent/20 text-accent"
                  : "text-gray-500 hover:text-gray-300 hover:bg-white/8"
              }`}
            >
              {s === "all" ? `All (${projects.length})` : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-accent" />
          Loading projects…
        </div>
      )}
      {error && <p className="text-sm text-red-400">{(error as Error).message}</p>}

      {!isLoading && !error && (projects ?? []).length === 0 && (
        <EmptyState
          icon={<WorkbenchIcons.project className="h-8 w-8 text-violet-300" aria-hidden="true" />}
          title="No research projects yet"
          description="Create a project to organize datasets, analyses, notes, and publication outputs in one reproducible workspace."
          action={<button onClick={() => setShowCreate(true)} className="rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover">Create your first project</button>}
          hint="Projects keep scientific context and provenance together without moving source imaging data."
        />
      )}

      {!isLoading && filtered.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map(p => (
            <div key={p.id} className="flex flex-col gap-0">
              <ProjectCard project={p} onDelete={handleDelete} />
              {cloudProfiles.length > 0 && (
                <div className="flex flex-wrap gap-1 px-1 pt-1">
                  {cloudProfiles.map((cp) => {
                    const key = `${p.id}-${cp.id}`;
                    return (
                      <div key={cp.id}>
                        <button
                          onClick={() => void handlePushToCloud(p.id, cp.id)}
                          disabled={pushing[key]}
                          className="rounded border border-accent/20 bg-accent/8 px-2 py-0.5 text-[10px] text-accent hover:bg-accent/15 disabled:opacity-40 transition-colors"
                        >
                          {pushing[key] ? "Pushing…" : `↑ Push to ${cp.name}`}
                        </button>
                        {pushErrors[key] && <p className="text-[10px] text-red-400 mt-0.5">{pushErrors[key]}</p>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {!isLoading && filtered.length === 0 && (projects ?? []).length > 0 && (
        <p className="text-sm text-gray-500">No projects with status "{statusFilter}".</p>
      )}
    </div>
  );
}
