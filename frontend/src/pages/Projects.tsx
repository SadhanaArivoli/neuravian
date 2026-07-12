import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FlaskConical } from "lucide-react";
import {
  useCreateProject,
  useDeleteProject,
  useProjects,
} from "../hooks/useProjects";
import type { ProjectCreate } from "../api/client";

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<string, string> = {
  active: "bg-green-500/12 text-green-300 border border-green-500/20",
  paused: "bg-amber-500/12 text-amber-300 border border-amber-500/20",
  completed: "bg-blue-500/12 text-blue-300 border border-blue-500/20",
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
          className="w-full rounded-md border border-white/12 bg-surface-overlay px-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-600 focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
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
              className="w-full rounded-md border border-white/12 bg-surface-overlay px-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-600 focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none"
              rows={3}
              value={form.description ?? ""}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Brief description of research aims"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Collaborators (comma-separated)</label>
            <input
              className="w-full rounded-md border border-white/12 bg-surface-overlay px-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-600 focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
              value={collaboratorsRaw}
              onChange={e => setCollaboratorsRaw(e.target.value)}
              placeholder="Alice Chen, Bob Kim"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Tags (comma-separated)</label>
            <input
              className="w-full rounded-md border border-white/12 bg-surface-overlay px-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-600 focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
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
              className="rounded-md border border-white/12 px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors focus:outline-none"
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
    <div className="rounded-lg border border-white/8 bg-surface-raised p-5 flex flex-col gap-3 hover:border-white/16 transition-colors">
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
            <span key={tag} className="rounded bg-white/6 px-1.5 py-0.5 text-[10px] text-gray-500">{tag}</span>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-1 border-t border-white/6">
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
  const { data: projects, isLoading, error } = useProjects();
  const deleteProject = useDeleteProject();
  const [showCreate, setShowCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const filtered = (projects ?? []).filter(p => statusFilter === "all" || p.status === statusFilter);

  async function handleDelete(id: number) {
    await deleteProject.mutateAsync(id);
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
                  : "text-gray-500 hover:text-gray-300 hover:bg-white/6"
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
        <div className="rounded-xl border border-white/8 bg-surface-raised px-8 py-16 text-center">
          <FlaskConical className="mx-auto mb-4 h-10 w-10 text-gray-600" />
          <h2 className="text-lg font-semibold text-gray-200 mb-2">No research projects yet</h2>
          <p className="text-sm text-gray-500 mb-6 max-w-sm mx-auto">
            Create a project to organize your datasets, analyses, notes, and manuscript drafts in one place.
          </p>
          <button
            onClick={() => setShowCreate(true)}
            className="rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent-hover transition-colors"
          >
            Create your first project
          </button>
        </div>
      )}

      {!isLoading && filtered.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map(p => (
            <ProjectCard key={p.id} project={p} onDelete={handleDelete} />
          ))}
        </div>
      )}

      {!isLoading && filtered.length === 0 && (projects ?? []).length > 0 && (
        <p className="text-sm text-gray-500">No projects with status "{statusFilter}".</p>
      )}
    </div>
  );
}
