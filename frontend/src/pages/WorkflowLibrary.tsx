import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  fetchWorkflow,
  fetchWorkflows,
  promoteWorkflowToTemplate,
  updateWorkflow,
  type WorkflowSummary,
  WORKFLOW_SCHEMA_VERSION,
} from "../api/client";
import { parseWorkflowImport } from "../lib/workflowPersistence";
import { useWorkspace } from "../context/WorkspaceContext";
import { useAllCloudSnapshots } from "../hooks/useAllCloudSnapshots";

type Tab = "recent" | "favorites" | "templates" | "archived" | "drafts";

function parseUtc(iso: string): Date {
  return new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
}

function relativeTime(iso: string): string {
  const diff = Date.now() - parseUtc(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return parseUtc(iso).toLocaleDateString();
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function TagChip({ tag }: { tag: string }) {
  return (
    <span className="rounded-full border border-white/8 bg-surface px-2 py-0.5 text-[10px] text-gray-500">
      {tag}
    </span>
  );
}

function WorkflowCard({
  wf,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
  onExport,
  onToggleFavorite,
  onArchive,
  onPromote,
}: {
  wf: WorkflowSummary;
  onOpen: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onExport: () => void;
  onToggleFavorite: () => void;
  onArchive: () => void;
  onPromote: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);

  return (
    <article className="flex flex-col rounded-xl border border-white/8 bg-surface-raised p-5 transition-colors hover:border-white/15">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {wf.is_template && (
              <span className="rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-accent">
                Template
              </span>
            )}
            {wf.is_favorite && (
              <span className="text-amber-400 text-sm">★</span>
            )}
          </div>
          <h3 className="mt-1 truncate text-base font-semibold text-white">{wf.name}</h3>
          {wf.description && (
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-400">{wf.description}</p>
          )}
        </div>

        {/* Overflow menu */}
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded-md border border-white/8 bg-surface px-2 py-1 text-xs text-gray-500 transition-colors hover:border-white/20 hover:text-gray-300 focus:outline-none"
          >
            ···
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-8 z-20 w-44 rounded-lg border border-white/10 bg-surface-overlay py-1 shadow-xl">
              {[
                { label: "Rename", action: onRename },
                { label: "Duplicate", action: onDuplicate },
                { label: wf.is_favorite ? "Unfavorite" : "Favorite", action: onToggleFavorite },
                { label: wf.is_archived ? "Unarchive" : "Archive", action: onArchive },
                ...(!wf.is_template ? [{ label: "Promote to Template", action: onPromote }] : []),
                { label: "Export JSON", action: onExport },
                { label: "Delete", action: onDelete, danger: true },
              ].map(({ label, action, danger }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => { setMenuOpen(false); action(); }}
                  className={classNames(
                    "block w-full px-4 py-2 text-left text-xs transition-colors hover:bg-white/5",
                    danger ? "text-red-400" : "text-gray-300",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Meta row */}
      <div className="mt-4 grid grid-cols-2 gap-2 rounded-lg border border-white/5 bg-surface px-3 py-2.5 text-xs text-gray-500">
        <div>
          <span className="block font-semibold uppercase tracking-widest text-gray-600">Steps</span>
          <span className="mt-0.5 block text-gray-300">{wf.node_count}</span>
        </div>
        <div>
          <span className="block font-semibold uppercase tracking-widest text-gray-600">Updated</span>
          <span className="mt-0.5 block text-gray-300">{relativeTime(wf.updated_at)}</span>
        </div>
      </div>

      {/* Tags */}
      {wf.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {wf.tags.map((t) => <TagChip key={t} tag={t} />)}
        </div>
      )}

      {/* Open button */}
      <button
        type="button"
        onClick={onOpen}
        className="mt-4 w-full rounded-md border border-accent/30 bg-accent/10 px-4 py-2 text-sm font-medium text-accent transition-colors hover:border-accent/50 hover:bg-accent/15 focus:outline-none focus:ring-2 focus:ring-accent/50"
      >
        Open
      </button>
    </article>
  );
}

function EmptyState({ tab }: { tab: Tab }) {
  const msg: Record<Tab, string> = {
    recent: "No workflows yet. Build one in the Workflow Builder.",
    favorites: "No favorite workflows. Star a workflow card to add it here.",
    templates: "No saved templates. Promote a workflow to a template to see it here.",
    archived: "No archived workflows.",
    drafts: "No drafts. Workflows without a linked dataset appear here.",
  };
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-surface py-16 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-xl border border-white/8 bg-surface-overlay text-xl font-bold text-gray-600">
        WF
      </div>
      <p className="mt-4 text-sm text-gray-500">{msg[tab]}</p>
      <Link
        to="/workflows/new"
        className="mt-4 rounded-md border border-accent/30 bg-accent/10 px-4 py-2 text-sm font-medium text-accent hover:border-accent/50 hover:bg-accent/15"
      >
        Open Workflow Builder
      </Link>
    </div>
  );
}

export default function WorkflowLibrary() {
  const navigate = useNavigate();
  const { selected, cloudProfiles } = useWorkspace();
  const isAll = Boolean(window.neuroforgeDesktop) && selected === "all";
  const allCloud = useAllCloudSnapshots();
  const [pushing, setPushing] = useState<Record<string, boolean>>({});
  const [pushErrors, setPushErrors] = useState<Record<string, string>>({});
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("recent");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"updated" | "created" | "name">("updated");
  const [actionError, setActionError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);

  async function handlePushWorkflow(wf: WorkflowSummary, profileId: string) {
    const key = `${wf.id}-${profileId}`;
    setPushing((p) => ({ ...p, [key]: true }));
    setPushErrors((e) => { const n = { ...e }; delete n[key]; return n; });
    try {
      const detail = await fetchWorkflow(wf.id);
      await window.neuroforgeDesktop!.pushCloudWorkflow({
        profileId,
        workflow: {
          name: detail.name,
          description: detail.description ?? "",
          tags: detail.tags,
          state: detail.state as Record<string, unknown>,
          schema_version: detail.schema_version ?? WORKFLOW_SCHEMA_VERSION,
        },
      });
    } catch (e) {
      setPushErrors((prev) => ({ ...prev, [key]: e instanceof Error ? e.message : "Push failed" }));
    } finally {
      setPushing((p) => { const n = { ...p }; delete n[key]; return n; });
    }
  }

  function load() {
    setLoading(true);
    fetchWorkflows()
      .then(setWorkflows)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load workflows."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  // ── Filtering & sorting ────────────────────────────────────────────────────

  const filtered = workflows
    .filter((wf) => {
      const q = search.toLowerCase();
      const matchesSearch =
        !q || wf.name.toLowerCase().includes(q) || (wf.description ?? "").toLowerCase().includes(q) || wf.tags.some((t) => t.toLowerCase().includes(q));
      if (!matchesSearch) return false;
      if (activeTab === "favorites") return wf.is_favorite && !wf.is_archived;
      if (activeTab === "templates") return wf.is_template && !wf.is_archived;
      if (activeTab === "archived") return wf.is_archived;
      if (activeTab === "drafts") return !wf.dataset_id && !wf.is_archived && !wf.is_template;
      // recent: all non-archived
      return !wf.is_archived;
    })
    .sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);
      if (sortBy === "created") return parseUtc(b.created_at).getTime() - parseUtc(a.created_at).getTime();
      return parseUtc(b.updated_at).getTime() - parseUtc(a.updated_at).getTime();
    });

  // ── Actions ────────────────────────────────────────────────────────────────

  function withReload(fn: () => Promise<void>) {
    return () => {
      setActionError(null);
      fn().then(load).catch((e) => setActionError(e instanceof Error ? e.message : "Action failed."));
    };
  }

  function handleOpen(wf: WorkflowSummary) {
    navigate(`/workflows/new?open=${wf.id}`);
  }

  function handleExport(wf: WorkflowSummary) {
    fetchWorkflows()
      .then((all) => {
        const full = all.find((w) => w.id === wf.id);
        if (!full) return;
        fetchWorkflow(wf.id).then((detail) => {
            const envelope = {
              export_format: "neuroforge-workflow-export-v1",
              exported_at: new Date().toISOString(),
              name: detail.name,
              description: detail.description,
              tags: detail.tags,
              state: detail.state,
            };
            const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${detail.name.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_workflow.json`;
            a.click();
            URL.revokeObjectURL(url);
          });
      });
  }

  function handleRenameStart(wf: WorkflowSummary) {
    setRenaming({ id: wf.id, value: wf.name });
  }

  function handleRenameCommit() {
    if (!renaming) return;
    const { id, value } = renaming;
    const trimmed = value.trim();
    setRenaming(null);
    if (!trimmed) return;
    updateWorkflow(id, { name: trimmed }).then(load).catch((e) => setActionError(e instanceof Error ? e.message : "Rename failed."));
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImportError(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const result = parseWorkflowImport(text);
      if (!result.valid || !result.envelope) {
        setImportError(result.errors.join(" | "));
        return;
      }
      const env = result.envelope;
      createWorkflow({
        name: env.name,
        description: env.description,
        tags: env.tags,
        state: env.state as unknown as Record<string, unknown>,
        schema_version: WORKFLOW_SCHEMA_VERSION,
      })
        .then(load)
        .catch((e) => setImportError(e instanceof Error ? e.message : "Import failed."));
    };
    reader.readAsText(file);
  }

  // ── Tab counts ─────────────────────────────────────────────────────────────

  const counts: Record<Tab, number> = {
    recent: workflows.filter((w) => !w.is_archived).length,
    favorites: workflows.filter((w) => w.is_favorite && !w.is_archived).length,
    templates: workflows.filter((w) => w.is_template && !w.is_archived).length,
    archived: workflows.filter((w) => w.is_archived).length,
    drafts: workflows.filter((w) => !w.dataset_id && !w.is_archived && !w.is_template).length,
  };

  const TABS: { id: Tab; label: string }[] = [
    { id: "recent", label: "Recent" },
    { id: "favorites", label: "Favorites" },
    { id: "templates", label: "Templates" },
    { id: "drafts", label: "Drafts" },
    { id: "archived", label: "Archived" },
  ];

  return (
    <div className="min-h-full text-gray-100">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">

        {/* Header */}
        <header className="mb-6 border-b border-white/5 pb-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <span className="inline-block h-4 w-1.5 rounded-full bg-accent" />
                <span className="rounded-full border border-accent/25 bg-accent/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-accent">
                  Workflow Library
                </span>
              </div>
              <h1 className="mt-3 text-2xl font-bold tracking-tight text-white">Saved Workflows</h1>
              <p className="mt-1 text-sm text-gray-400">
                Open, duplicate, rename, or export your planning workflows. Nothing runs from here.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {/* Import */}
              <input
                ref={importRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={handleImportFile}
              />
              <button
                type="button"
                onClick={() => importRef.current?.click()}
                className="rounded-md border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-gray-300 transition-colors hover:border-white/30 hover:text-white"
              >
                Import JSON
              </button>

              <Link
                to="/workflows/new"
                className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover"
              >
                New Workflow
              </Link>
            </div>
          </div>

          {importError && (
            <p className="mt-3 rounded-md border border-red-800 bg-red-900/30 px-4 py-2 text-sm text-red-300">
              Import failed: {importError}
            </p>
          )}
          {actionError && (
            <p className="mt-3 rounded-md border border-red-800 bg-red-900/30 px-4 py-2 text-sm text-red-300">
              {actionError}
            </p>
          )}
        </header>

        {/* Tabs + search + sort */}
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <nav className="flex gap-1 rounded-lg border border-white/8 bg-surface p-1">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={classNames(
                  "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  activeTab === tab.id
                    ? "bg-accent/20 text-accent"
                    : "text-gray-500 hover:text-gray-300",
                )}
              >
                {tab.label}
                {counts[tab.id] > 0 && (
                  <span className="ml-1.5 rounded-full bg-white/8 px-1.5 py-0.5 text-[10px]">
                    {counts[tab.id]}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <input
            type="search"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-48 rounded-md border border-white/10 bg-surface px-3 py-1.5 text-sm text-gray-200 outline-none transition-colors focus:border-accent/50 placeholder:text-gray-600"
          />

          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            className="rounded-md border border-white/10 bg-surface px-3 py-1.5 text-sm text-gray-400 outline-none"
          >
            <option value="updated">Last updated</option>
            <option value="created">Date created</option>
            <option value="name">Name</option>
          </select>
        </div>

        {/* Rename modal */}
        {renaming && (
          <div className="mb-4 flex items-center gap-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3">
            <span className="text-sm text-gray-400">Rename:</span>
            <input
              autoFocus
              value={renaming.value}
              onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") handleRenameCommit(); if (e.key === "Escape") setRenaming(null); }}
              className="flex-1 rounded-md border border-white/15 bg-surface px-3 py-1.5 text-sm text-white outline-none focus:border-accent/50"
            />
            <button type="button" onClick={handleRenameCommit} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover">Save</button>
            <button type="button" onClick={() => setRenaming(null)} className="text-sm text-gray-500 hover:text-gray-300">Cancel</button>
          </div>
        )}

        {/* Content */}
        {loading ? (
          <p className="text-sm text-gray-500 animate-pulse">Loading workflows…</p>
        ) : error ? (
          <p className="text-sm text-red-400">{error}</p>
        ) : filtered.length === 0 ? (
          <EmptyState tab={activeTab} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {filtered.map((wf) => (
              <div key={wf.id} className="flex flex-col gap-2">
                <WorkflowCard
                  wf={wf}
                  onOpen={() => handleOpen(wf)}
                  onRename={() => handleRenameStart(wf)}
                  onDuplicate={withReload(() => duplicateWorkflow(wf.id).then(() => {}))}
                  onDelete={withReload(() => {
                    if (!window.confirm(`Delete "${wf.name}"? This cannot be undone.`)) return Promise.resolve();
                    return deleteWorkflow(wf.id);
                  })}
                  onExport={() => handleExport(wf)}
                  onToggleFavorite={withReload(() => updateWorkflow(wf.id, { is_favorite: !wf.is_favorite }).then(() => {}))}
                  onArchive={withReload(() => updateWorkflow(wf.id, { is_archived: !wf.is_archived }).then(() => {}))}
                  onPromote={withReload(() => promoteWorkflowToTemplate(wf.id).then(() => {}))}
                />
                {/* Push-to-cloud buttons when cloud profiles exist */}
                {cloudProfiles.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {cloudProfiles.map((cp) => {
                      const key = `${wf.id}-${cp.id}`;
                      return (
                        <div key={cp.id} className="flex flex-col gap-0.5">
                          <button
                            type="button"
                            disabled={pushing[key]}
                            onClick={() => void handlePushWorkflow(wf, cp.id)}
                            className="rounded-md border border-sky-500/25 bg-sky-500/5 px-2 py-1 text-[11px] text-sky-300 hover:border-sky-400/40 hover:bg-sky-500/10 disabled:opacity-40 transition-colors"
                          >
                            {pushing[key] ? "Pushing…" : `↑ ${cp.name}`}
                          </button>
                          {pushErrors[key] && (
                            <p className="text-[10px] text-red-400 truncate max-w-[140px]">{pushErrors[key]}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Cloud workflows section (All Workspaces mode) */}
        {isAll && allCloud.some((c) => (c.snapshot?.workflows?.length ?? 0) > 0) && (
          <div className="mt-10">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-500">Cloud Workflows</h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {allCloud.flatMap(({ profile, snapshot }) =>
                (snapshot?.workflows ?? []).map((wf) => {
                  const w = wf as Record<string, unknown>;
                  return (
                    <div
                      key={`cloud-${profile.id}-${w.id as number}`}
                      className="flex flex-col rounded-xl border border-sky-500/20 bg-surface-raised p-5"
                    >
                      <div className="flex items-start gap-2 mb-1">
                        <h3 className="flex-1 truncate text-base font-semibold text-white">{w.name as string}</h3>
                        <span className="shrink-0 rounded-full border border-sky-400/20 bg-sky-400/10 px-2 py-0.5 text-[10px] text-sky-300">Cloud · {profile.name}</span>
                      </div>
                      {!!w.description && <p className="text-xs text-gray-400 line-clamp-2">{String(w.description)}</p>}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
