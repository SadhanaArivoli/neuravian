import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  useAssignDataset,
  useCreateNote,
  useDeleteNote,
  useManuscript,
  useProject,
  useProjectDatasets,
  useProjectNotes,
  useProjectSearch,
  useProjectStats,
  useProjectTimeline,
  usePublicationStatus,
  useUnassignDataset,
  useUpdateNote,
  useUpdateProject,
} from "../hooks/useProjects";
import { useDatasets } from "../hooks/useDatasets";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-white/8 bg-surface-raised p-5 space-y-3">
      <h2 className="text-sm font-semibold text-gray-300">{title}</h2>
      {children}
    </section>
  );
}

// ── Stats row ─────────────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="text-center">
      <p className="text-xl font-semibold text-gray-100 tabular-nums">{value}</p>
      <p className="text-[11px] text-gray-500 mt-0.5">{label}</p>
    </div>
  );
}

// ── Timeline ──────────────────────────────────────────────────────────────────

const EVENT_ICON: Record<string, string> = {
  dataset_imported: "📂",
  run_started: "▶️",
  run_finished: "✅",
  run_failed: "❌",
  report_generated: "📊",
  note_created: "📝",
};

function Timeline({ projectId }: { projectId: number }) {
  const { data: events, isLoading } = useProjectTimeline(projectId);
  if (isLoading) return <p className="text-xs text-gray-500">Loading timeline…</p>;
  if (!events || events.length === 0) return <p className="text-xs text-gray-500">No events yet. Start by assigning a dataset or running a pipeline.</p>;
  return (
    <ol className="space-y-2">
      {events.map((ev, i) => (
        <li key={i} className="flex gap-3 items-start text-xs">
          <span className="text-base leading-none mt-0.5">{EVENT_ICON[ev.event_type] ?? "•"}</span>
          <div className="flex-1 min-w-0">
            <p className="text-gray-300 leading-snug">{ev.label}</p>
            {ev.details && Object.keys(ev.details).length > 0 && <p className="text-gray-600 mt-0.5 truncate">{JSON.stringify(ev.details)}</p>}
          </div>
          <time className="text-gray-600 shrink-0">{fmt(ev.timestamp)}</time>
        </li>
      ))}
    </ol>
  );
}

// ── Datasets tab ──────────────────────────────────────────────────────────────

function DatasetsTab({ projectId }: { projectId: number }) {
  const { data: projectDatasets } = useProjectDatasets(projectId);
  const { data: allDatasets } = useDatasets();
  const assign = useAssignDataset();
  const unassign = useUnassignDataset();
  const [selectedId, setSelectedId] = useState<number | "">("");

  const assignedIds = new Set((projectDatasets ?? []).map(d => d.id));
  const unassigned = (allDatasets ?? []).filter(d => !assignedIds.has(d.id));

  return (
    <div className="space-y-4">
      {/* Assign */}
      <div className="flex gap-2">
        <select
          className="flex-1 rounded-md border border-white/12 bg-surface-overlay px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-accent/60"
          value={selectedId}
          onChange={e => setSelectedId(Number(e.target.value) || "")}
        >
          <option value="">— Select a dataset to assign —</option>
          {unassigned.map(d => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
        <button
          disabled={!selectedId || assign.isPending}
          onClick={() => {
            if (selectedId) assign.mutate({ projectId, datasetId: Number(selectedId) }, { onSuccess: () => setSelectedId("") });
          }}
          className="rounded-md bg-accent px-4 py-1.5 text-sm text-white hover:bg-accent-hover disabled:opacity-40 transition-colors"
        >
          Assign
        </button>
      </div>
      {/* List */}
      {(projectDatasets ?? []).length === 0 && (
        <p className="text-xs text-gray-500">No datasets assigned to this project yet.</p>
      )}
      <ul className="space-y-2">
        {(projectDatasets ?? []).map(ds => (
          <li key={ds.id} className="flex items-center justify-between gap-3 rounded border border-white/8 bg-surface px-4 py-2.5">
            <div>
              <Link to={`/datasets/${ds.id}`} className="text-sm text-gray-200 hover:text-white transition-colors">{ds.name}</Link>
              <p className="text-[11px] text-gray-600 mt-0.5 font-mono">{ds.path}</p>
            </div>
            <button
              onClick={() => unassign.mutate({ projectId, datasetId: ds.id })}
              className="text-xs text-gray-600 hover:text-red-400 transition-colors"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Notes tab ─────────────────────────────────────────────────────────────────

function NotesTab({ projectId }: { projectId: number }) {
  const { data: notes } = useProjectNotes(projectId);
  const createNote = useCreateNote();
  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();
  const [editing, setEditing] = useState<{ id: number; title: string; content_md: string } | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [showNew, setShowNew] = useState(false);

  function handleCreate() {
    if (!newTitle.trim()) return;
    createNote.mutate({ projectId, title: newTitle.trim(), content_md: newContent }, {
      onSuccess: () => { setNewTitle(""); setNewContent(""); setShowNew(false); },
    });
  }

  function handleUpdate() {
    if (!editing) return;
    updateNote.mutate({ projectId, noteId: editing.id, payload: { title: editing.title, content_md: editing.content_md } }, {
      onSuccess: () => setEditing(null),
    });
  }

  return (
    <div className="space-y-4">
      <button
        onClick={() => setShowNew(v => !v)}
        className="text-sm text-accent hover:text-accent-hover transition-colors"
      >
        {showNew ? "Cancel" : "+ New note"}
      </button>

      {showNew && (
        <div className="rounded-lg border border-white/10 bg-surface p-4 space-y-3">
          <input
            className="w-full rounded border border-white/12 bg-surface-overlay px-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-accent/60"
            placeholder="Note title"
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
          />
          <textarea
            className="w-full rounded border border-white/12 bg-surface-overlay px-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-accent/60 resize-y font-mono"
            rows={6}
            placeholder="Markdown content…"
            value={newContent}
            onChange={e => setNewContent(e.target.value)}
          />
          <button
            onClick={handleCreate}
            disabled={!newTitle.trim() || createNote.isPending}
            className="rounded bg-accent px-4 py-1.5 text-sm text-white hover:bg-accent-hover disabled:opacity-40 transition-colors"
          >
            {createNote.isPending ? "Saving…" : "Save Note"}
          </button>
        </div>
      )}

      {(notes ?? []).length === 0 && !showNew && (
        <p className="text-xs text-gray-500">No notes yet. Use notes to record decisions, observations, and analysis rationale.</p>
      )}

      <ul className="space-y-3">
        {(notes ?? []).map(note => (
          <li key={note.id} className="rounded-lg border border-white/8 bg-surface p-4 space-y-2">
            {editing?.id === note.id ? (
              <>
                <input
                  className="w-full rounded border border-white/12 bg-surface-overlay px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-accent/60"
                  value={editing.title}
                  onChange={e => setEditing(ed => ed ? { ...ed, title: e.target.value } : null)}
                />
                <textarea
                  className="w-full rounded border border-white/12 bg-surface-overlay px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-accent/60 resize-y font-mono"
                  rows={6}
                  value={editing.content_md}
                  onChange={e => setEditing(ed => ed ? { ...ed, content_md: e.target.value } : null)}
                />
                <div className="flex gap-2">
                  <button onClick={handleUpdate} disabled={updateNote.isPending} className="text-xs text-accent hover:text-accent-hover">Save</button>
                  <button onClick={() => setEditing(null)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-gray-200">{note.title}</p>
                  <div className="flex gap-3 text-[11px]">
                    <button onClick={() => setEditing({ id: note.id, title: note.title, content_md: note.content_md })} className="text-gray-500 hover:text-gray-300">Edit</button>
                    <button onClick={() => deleteNote.mutate({ projectId, noteId: note.id })} className="text-gray-600 hover:text-red-400">Delete</button>
                  </div>
                </div>
                <pre className="text-xs text-gray-400 whitespace-pre-wrap font-sans leading-relaxed line-clamp-6">{note.content_md || <span className="italic text-gray-600">Empty note</span>}</pre>
                <p className="text-[10px] text-gray-600">Updated {fmt(note.updated_at)}</p>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Publication tab ───────────────────────────────────────────────────────────

function PublicationTab({ projectId }: { projectId: number }) {
  const { data: pub } = usePublicationStatus(projectId);
  const { data: ms, refetch, isFetching } = useManuscript(projectId);

  function download() {
    if (!ms) return;
    const blob = new Blob([ms.content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = ms.filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      {/* Checklist */}
      <div className="space-y-2">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium text-gray-400">Publication Readiness</p>
          <p className="text-xs text-gray-500">{pub?.completion_pct ?? 0}% complete</p>
        </div>
        <div className="h-1.5 rounded-full bg-white/8 overflow-hidden mb-3">
          <div
            className="h-full rounded-full bg-accent transition-all duration-300"
            style={{ width: `${pub?.completion_pct ?? 0}%` }}
          />
        </div>
        {(pub?.checklist ?? []).map(item => (
          <div key={item.key} className="flex items-start gap-3">
            <span className={`mt-0.5 text-sm ${item.done ? "text-green-400" : "text-gray-600"}`}>
              {item.done ? "✓" : "○"}
            </span>
            <div>
              <p className={`text-xs ${item.done ? "text-gray-300" : "text-gray-500"}`}>{item.label}</p>
              {!item.done && item.detail && <p className="text-[11px] text-gray-600 mt-0.5">{item.detail}</p>}
            </div>
          </div>
        ))}
      </div>

      {/* Manuscript export */}
      <div className="border-t border-white/8 pt-4 space-y-3">
        <p className="text-xs font-medium text-gray-400">Manuscript Draft Export</p>
        <p className="text-xs text-gray-500">Generates a Markdown document with methods section, pipeline provenance, and your notes.</p>
        <div className="flex gap-2">
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="rounded border border-white/12 px-3 py-1.5 text-xs text-gray-300 hover:text-white transition-colors disabled:opacity-40"
          >
            {isFetching ? "Generating…" : "Generate"}
          </button>
          {ms && (
            <button
              onClick={download}
              className="rounded bg-accent px-3 py-1.5 text-xs text-white hover:bg-accent-hover transition-colors"
            >
              Download .md
            </button>
          )}
        </div>
        {ms && (
          <pre className="rounded border border-white/8 bg-surface p-3 text-[11px] text-gray-400 font-mono whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">{ms.content.slice(0, 1200)}{ms.content.length > 1200 ? "\n…" : ""}</pre>
        )}
      </div>
    </div>
  );
}

// ── Search tab ────────────────────────────────────────────────────────────────

function SearchTab({ projectId }: { projectId: number }) {
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const { data: results, isLoading } = useProjectSearch(projectId, submitted);

  return (
    <div className="space-y-4">
      <form
        onSubmit={e => { e.preventDefault(); setSubmitted(q); }}
        className="flex gap-2"
      >
        <input
          className="flex-1 rounded-md border border-white/12 bg-surface-overlay px-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-accent/60"
          placeholder="Search datasets, runs, notes, reports…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        <button type="submit" className="rounded-md bg-accent px-4 py-1.5 text-sm text-white hover:bg-accent-hover transition-colors">Search</button>
      </form>
      {isLoading && <p className="text-xs text-gray-500">Searching…</p>}
      {results && (
        <div className="space-y-4">
          {results.total === 0 && <p className="text-xs text-gray-500">No results for "{submitted}".</p>}
          {results.results.notes.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-400 mb-1">Notes ({results.results.notes.length})</p>
              <ul className="space-y-1">
                {results.results.notes.map(n => (
                  <li key={n.id} className="text-xs text-gray-300 rounded bg-white/4 px-3 py-2">
                    <span className="font-medium">{n.title}</span>
                    {n.snippet && <span className="text-gray-500"> — {n.snippet}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {results.results.datasets.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-400 mb-1">Datasets ({results.results.datasets.length})</p>
              <ul className="space-y-1">
                {results.results.datasets.map(d => (
                  <li key={d.id} className="text-xs text-gray-300 rounded bg-white/4 px-3 py-2">
                    <Link to={`/datasets/${d.id}`} className="font-medium hover:text-white">{d.name}</Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {results.results.runs.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-400 mb-1">Runs ({results.results.runs.length})</p>
              <ul className="space-y-1">
                {results.results.runs.map(r => (
                  <li key={r.id} className="text-xs text-gray-300 rounded bg-white/4 px-3 py-2">
                    <Link to={`/runs/${r.id}`} className="hover:text-white">Run #{r.id}</Link>
                    <span className="text-gray-600 ml-2">{r.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Edit project inline ───────────────────────────────────────────────────────

function EditProjectPanel({ project, onClose }: {
  project: { id: number; title: string; description: string | null; institution: string | null; lab: string | null; pi_name: string | null; collaborators: string[]; tags: string[]; status: string };
  onClose: () => void;
}) {
  const update = useUpdateProject();
  const [form, setForm] = useState({
    title: project.title,
    description: project.description ?? "",
    institution: project.institution ?? "",
    lab: project.lab ?? "",
    pi_name: project.pi_name ?? "",
    status: project.status,
    collaboratorsRaw: project.collaborators.join(", "),
    tagsRaw: project.tags.join(", "),
  });

  async function handleSave() {
    await update.mutateAsync({
      id: project.id,
      payload: {
        title: form.title,
        description: form.description,
        institution: form.institution,
        lab: form.lab,
        pi_name: form.pi_name,
        status: form.status,
        collaborators: form.collaboratorsRaw.split(",").map(s => s.trim()).filter(Boolean),
        tags: form.tagsRaw.split(",").map(s => s.trim()).filter(Boolean),
      },
    });
    onClose();
  }

  function f(label: string, key: keyof typeof form) {
    return (
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">{label}</label>
        <input
          className="w-full rounded border border-white/12 bg-surface-overlay px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-accent/60"
          value={form[key]}
          onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {f("Title", "title")}
      {f("PI Name", "pi_name")}
      {f("Institution", "institution")}
      {f("Lab", "lab")}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">Description</label>
        <textarea
          className="w-full rounded border border-white/12 bg-surface-overlay px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-accent/60 resize-none"
          rows={3}
          value={form.description}
          onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
        />
      </div>
      {f("Collaborators (comma-separated)", "collaboratorsRaw")}
      {f("Tags (comma-separated)", "tagsRaw")}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">Status</label>
        <select
          className="w-full rounded border border-white/12 bg-surface-overlay px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-accent/60"
          value={form.status}
          onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
        >
          {["active", "paused", "completed", "archived"].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="flex gap-2 pt-1">
        <button onClick={handleSave} disabled={update.isPending} className="rounded bg-accent px-4 py-1.5 text-sm text-white hover:bg-accent-hover disabled:opacity-40 transition-colors">
          {update.isPending ? "Saving…" : "Save changes"}
        </button>
        <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-300">Cancel</button>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const TABS = ["Overview", "Datasets", "Notes", "Publication", "Search"] as const;
type Tab = typeof TABS[number];

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const projectId = id ? Number(id) : undefined;
  const { data: project, isLoading, error } = useProject(projectId);
  const { data: stats } = useProjectStats(projectId);
  const [tab, setTab] = useState<Tab>("Overview");
  const [editing, setEditing] = useState(false);

  if (isLoading) return <div className="p-6 text-sm text-gray-400">Loading project…</div>;
  if (error || !project) return (
    <div className="p-6">
      <p className="text-sm text-red-400 mb-2">Project not found.</p>
      <Link to="/projects" className="text-sm text-accent hover:text-accent-hover">← Back to Projects</Link>
    </div>
  );

  return (
    <div className="p-6 max-w-5xl space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <Link to="/projects" className="hover:text-gray-300 transition-colors">Projects</Link>
        <span>/</span>
        <span className="text-gray-300 truncate">{project.title}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-gray-100 break-words">{project.title}</h1>
          {(project.pi_name || project.institution) && (
            <p className="text-sm text-gray-500 mt-1">{[project.pi_name, project.institution, project.lab].filter(Boolean).join(" · ")}</p>
          )}
          {project.description && <p className="text-sm text-gray-400 mt-2 max-w-2xl">{project.description}</p>}
          {project.collaborators.length > 0 && (
            <p className="text-xs text-gray-600 mt-1">Collaborators: {project.collaborators.join(", ")}</p>
          )}
          {project.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {project.tags.map(t => <span key={t} className="rounded bg-white/6 px-1.5 py-0.5 text-[10px] text-gray-500">{t}</span>)}
            </div>
          )}
        </div>
        <button onClick={() => setEditing(v => !v)} className="shrink-0 rounded border border-white/12 px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors">
          {editing ? "Cancel" : "Edit"}
        </button>
      </div>

      {/* Inline edit */}
      {editing && (
        <Section title="Edit Project">
          <EditProjectPanel project={project} onClose={() => setEditing(false)} />
        </Section>
      )}

      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-4 gap-3 rounded-lg border border-white/8 bg-surface-raised p-4">
          <Stat label="Datasets" value={stats.dataset_count} />
          <Stat label="Runs" value={stats.run_count} />
          <Stat label="Successful" value={stats.success_run_count} />
          <Stat label="Notes" value={stats.note_count} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-white/8">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              tab === t
                ? "border-b-2 border-accent text-accent"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div>
        {tab === "Overview" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Section title="Recent Pipelines">
              {!stats || Object.keys(stats.pipeline_breakdown).length === 0
                ? <p className="text-xs text-gray-500">No pipelines run yet.</p>
                : <ul className="space-y-1">
                    {Object.entries(stats.pipeline_breakdown).map(([name, count]) => (
                      <li key={name} className="flex justify-between text-xs">
                        <span className="text-gray-300 font-mono">{name}</span>
                        <span className="text-gray-500">{count} run{count !== 1 ? "s" : ""}</span>
                      </li>
                    ))}
                  </ul>
              }
            </Section>
            <Section title="Activity Timeline">
              <Timeline projectId={project.id} />
            </Section>
          </div>
        )}
        {tab === "Datasets" && (
          <Section title="Project Datasets">
            <DatasetsTab projectId={project.id} />
          </Section>
        )}
        {tab === "Notes" && (
          <Section title="Lab Notebook">
            <NotesTab projectId={project.id} />
          </Section>
        )}
        {tab === "Publication" && (
          <Section title="Publication Readiness">
            <PublicationTab projectId={project.id} />
          </Section>
        )}
        {tab === "Search" && (
          <Section title="Search Project">
            <SearchTab projectId={project.id} />
          </Section>
        )}
      </div>
    </div>
  );
}
