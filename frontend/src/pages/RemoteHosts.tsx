import { useState } from "react";
import {
  type PreflightResult,
  type RemoteHost,
  type RemoteHostCreate,
  createRemoteHost,
  deleteRemoteHost,
  fetchRemoteHosts,
  testRemoteHostConnection,
  updateRemoteHost,
} from "../api/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

// ── Helpers ───────────────────────────────────────────────────────────────────

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full shrink-0 ${ok ? "bg-green-400" : "bg-red-400"}`}
    />
  );
}

// ── Preflight Panel ───────────────────────────────────────────────────────────

function PreflightPanel({ result }: { result: PreflightResult }) {
  const CHECK_LABELS: Record<string, string> = {
    architecture: "Remote architecture",
    docker: "Docker daemon",
    remote_work_root_writable: "Work root writable",
    disk_space_gb: "Disk space",
  };

  return (
    <div className="mt-4 rounded-lg border border-white/10 bg-surface-overlay p-4 space-y-3">
      <div className="flex items-center gap-2">
        <StatusDot ok={result.connected} />
        <span className={`text-sm font-medium ${result.connected ? "text-green-300" : "text-red-300"}`}>
          {result.connected ? "SSH connection established" : "SSH connection failed"}
        </span>
      </div>

      {result.checks.length > 0 && (
        <div className="space-y-1.5">
          {result.checks.map((c) => (
            <div key={c.name} className="flex items-start gap-2">
              <StatusDot ok={c.passed} />
              <div className="min-w-0 flex-1">
                <span className="text-xs text-gray-300">{CHECK_LABELS[c.name] ?? c.name}</span>
                {c.value && (
                  <span className="ml-2 text-xs text-gray-500 font-mono">{c.value}</span>
                )}
                {c.detail && !c.passed && (
                  <p className="text-xs text-red-400 mt-0.5">{c.detail}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {result.errors.length > 0 && (
        <div className="space-y-1">
          {result.errors.map((e, i) => (
            <p key={i} className="text-xs text-red-400">{e}</p>
          ))}
        </div>
      )}

      {result.warnings.length > 0 && (
        <div className="space-y-1">
          {result.warnings.map((w, i) => (
            <p key={i} className="text-xs text-yellow-400">{w}</p>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Host Form ─────────────────────────────────────────────────────────────────

const EMPTY_FORM: RemoteHostCreate = {
  display_name: "",
  hostname: "",
  ssh_port: 22,
  username: "",
  key_path: "",
  remote_work_root: "",
  docker_host: "",
  enabled: true,
  notes: "",
};

function inputCls(err?: boolean) {
  return `w-full rounded-md border ${
    err ? "border-red-500/60" : "border-white/15"
  } bg-surface-overlay px-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-500 focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/50`;
}

function HostForm({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial: RemoteHostCreate;
  onSave: (data: RemoteHostCreate) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<RemoteHostCreate>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function set(field: keyof RemoteHostCreate, value: unknown) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: "" }));
  }

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!form.display_name.trim()) e.display_name = "Required";
    if (!form.hostname.trim()) e.hostname = "Required";
    if (!form.username.trim()) e.username = "Required";
    if (!form.key_path.trim()) e.key_path = "Required";
    if (!form.key_path.startsWith("/")) e.key_path = "Must be an absolute path";
    if (!form.remote_work_root.trim()) e.remote_work_root = "Required";
    if (!form.remote_work_root.startsWith("/")) e.remote_work_root = "Must be an absolute path";
    if (!form.ssh_port || form.ssh_port < 1 || form.ssh_port > 65535) e.ssh_port = "1–65535";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (validate()) onSave(form);
  }

  const labelCls = "block text-xs font-medium text-gray-400 mb-1";
  const errCls = "mt-0.5 text-xs text-red-400";

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Display name */}
        <div className="sm:col-span-2">
          <label className={labelCls}>Display name</label>
          <input
            value={form.display_name}
            onChange={(e) => set("display_name", e.target.value)}
            placeholder="e.g. Lab GPU Server"
            className={inputCls(!!errors.display_name)}
          />
          {errors.display_name && <p className={errCls}>{errors.display_name}</p>}
        </div>

        {/* Hostname */}
        <div>
          <label className={labelCls}>Hostname / IP</label>
          <input
            value={form.hostname}
            onChange={(e) => set("hostname", e.target.value)}
            placeholder="e.g. 10.0.0.1"
            className={inputCls(!!errors.hostname)}
          />
          {errors.hostname && <p className={errCls}>{errors.hostname}</p>}
        </div>

        {/* SSH Port */}
        <div>
          <label className={labelCls}>SSH port</label>
          <input
            type="number"
            min={1}
            max={65535}
            value={form.ssh_port}
            onChange={(e) => set("ssh_port", parseInt(e.target.value, 10) || 22)}
            className={inputCls(!!errors.ssh_port)}
          />
          {errors.ssh_port && <p className={errCls}>{errors.ssh_port}</p>}
        </div>

        {/* Username */}
        <div>
          <label className={labelCls}>SSH username</label>
          <input
            value={form.username}
            onChange={(e) => set("username", e.target.value)}
            placeholder="e.g. ubuntu"
            className={inputCls(!!errors.username)}
          />
          {errors.username && <p className={errCls}>{errors.username}</p>}
        </div>

        {/* Key path */}
        <div>
          <label className={labelCls}>
            Private key path{" "}
            <span className="font-normal text-gray-500">(on the backend server)</span>
          </label>
          <input
            value={form.key_path}
            onChange={(e) => set("key_path", e.target.value)}
            placeholder="/home/user/.ssh/id_ed25519"
            className={inputCls(!!errors.key_path)}
          />
          {errors.key_path && <p className={errCls}>{errors.key_path}</p>}
        </div>

        {/* Remote work root */}
        <div className="sm:col-span-2">
          <label className={labelCls}>Remote work root</label>
          <input
            value={form.remote_work_root}
            onChange={(e) => set("remote_work_root", e.target.value)}
            placeholder="/scratch/neuroforge"
            className={inputCls(!!errors.remote_work_root)}
          />
          {errors.remote_work_root && <p className={errCls}>{errors.remote_work_root}</p>}
          <p className="mt-0.5 text-xs text-gray-500">
            Directory on the remote host where NeuroForge stages run inputs and outputs.
          </p>
        </div>

        {/* Docker host (optional) */}
        <div className="sm:col-span-2">
          <label className={labelCls}>
            Docker socket override{" "}
            <span className="font-normal text-gray-500">(optional)</span>
          </label>
          <input
            value={form.docker_host ?? ""}
            onChange={(e) => set("docker_host", e.target.value || null)}
            placeholder="unix:///var/run/docker.sock"
            className={inputCls()}
          />
        </div>

        {/* Notes */}
        <div className="sm:col-span-2">
          <label className={labelCls}>Notes <span className="font-normal text-gray-500">(optional)</span></label>
          <textarea
            rows={2}
            value={form.notes ?? ""}
            onChange={(e) => set("notes", e.target.value || null)}
            placeholder="e.g. Lab workstation; requires VPN"
            className={`${inputCls()} resize-none`}
          />
        </div>

        {/* Enabled */}
        <div className="sm:col-span-2 flex items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={form.enabled}
            onClick={() => set("enabled", !form.enabled)}
            className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 ${
              form.enabled ? "bg-accent" : "bg-white/15"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                form.enabled ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
          <span className="text-xs text-gray-400">Enabled</span>
        </div>
      </div>

      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50 transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50"
        >
          {saving ? "Saving…" : "Save host"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-white/15 px-4 py-1.5 text-sm text-gray-300 hover:border-white/30 hover:text-gray-100 transition-colors focus:outline-none"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Host Card ─────────────────────────────────────────────────────────────────

function HostCard({
  host,
  onEdit,
  onDelete,
}: {
  host: RemoteHost;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  async function handleTest() {
    setTesting(true);
    setPreflight(null);
    try {
      const result = await testRemoteHostConnection(host.id);
      setPreflight(result);
    } catch (err) {
      setPreflight({
        connected: false,
        checks: [],
        errors: [(err as Error).message],
        warnings: [],
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className={`rounded-lg border p-4 transition-colors ${host.enabled ? "border-white/10 bg-surface-raised" : "border-white/5 bg-surface opacity-60"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-gray-100 text-sm">{host.display_name}</h3>
            {!host.enabled && (
              <span className="rounded-full bg-white/8 px-2 py-0.5 text-xs text-gray-500 border border-white/10">
                disabled
              </span>
            )}
          </div>
          <p className="text-xs text-gray-400 font-mono mt-0.5">
            {host.username}@{host.hostname}:{host.ssh_port}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">
            Work root: <span className="font-mono">{host.remote_work_root}</span>
          </p>
          {host.notes && <p className="text-xs text-gray-500 mt-0.5">{host.notes}</p>}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="rounded-md border border-white/15 px-2.5 py-1 text-xs text-gray-300 hover:border-white/30 hover:text-gray-100 transition-colors disabled:opacity-50 focus:outline-none"
          >
            {testing ? "Testing…" : "Test connection"}
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="rounded-md border border-white/15 px-2.5 py-1 text-xs text-gray-300 hover:border-white/30 hover:text-gray-100 transition-colors focus:outline-none"
          >
            Edit
          </button>
          {deleteConfirm ? (
            <>
              <button
                type="button"
                onClick={onDelete}
                className="rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/20 transition-colors focus:outline-none"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => setDeleteConfirm(false)}
                className="rounded-md border border-white/15 px-2.5 py-1 text-xs text-gray-400 hover:text-gray-200 transition-colors focus:outline-none"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setDeleteConfirm(true)}
              className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-gray-500 hover:border-red-500/30 hover:text-red-400 transition-colors focus:outline-none"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {preflight && <PreflightPanel result={preflight} />}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

type EditingState = { mode: "add" } | { mode: "edit"; host: RemoteHost };

export default function RemoteHosts() {
  const qc = useQueryClient();
  const { data: hosts = [], isLoading, error } = useQuery({
    queryKey: ["remote-hosts"],
    queryFn: fetchRemoteHosts,
  });

  const [editing, setEditing] = useState<EditingState | null>(null);

  const createMut = useMutation({
    mutationFn: createRemoteHost,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["remote-hosts"] }); setEditing(null); },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<RemoteHostCreate> }) =>
      updateRemoteHost(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["remote-hosts"] }); setEditing(null); },
  });

  const deleteMut = useMutation({
    mutationFn: deleteRemoteHost,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["remote-hosts"] }),
  });

  function handleSave(data: RemoteHostCreate) {
    if (!editing) return;
    if (editing.mode === "add") {
      createMut.mutate(data);
    } else {
      updateMut.mutate({ id: editing.host.id, data });
    }
  }

  const saving = createMut.isPending || updateMut.isPending;
  const saveError = createMut.error ?? updateMut.error;

  return (
    <div className="p-6 sm:p-8 max-w-3xl mx-auto">
      <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">Remote Hosts</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Configure SSH hosts for running pipelines remotely. Ideal for{" "}
            <span className="text-amber-400">local-slow</span> and{" "}
            <span className="text-red-400">cloud-recommended</span> pipelines.
          </p>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing({ mode: "add" })}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50"
          >
            + Add host
          </button>
        )}
      </div>

      {/* Add / edit form */}
      {editing && (
        <div className="mb-6 rounded-lg border border-accent/30 bg-surface-raised p-5">
          <h2 className="text-sm font-semibold text-gray-200 mb-4">
            {editing.mode === "add" ? "Add remote host" : `Edit — ${editing.host.display_name}`}
          </h2>
          <HostForm
            initial={
              editing.mode === "add"
                ? EMPTY_FORM
                : {
                    display_name: editing.host.display_name,
                    hostname: editing.host.hostname,
                    ssh_port: editing.host.ssh_port,
                    username: editing.host.username,
                    key_path: editing.host.key_path,
                    remote_work_root: editing.host.remote_work_root,
                    docker_host: editing.host.docker_host,
                    enabled: editing.host.enabled,
                    notes: editing.host.notes,
                  }
            }
            onSave={handleSave}
            onCancel={() => setEditing(null)}
            saving={saving}
          />
          {saveError && (
            <p className="mt-2 text-xs text-red-400">{(saveError as Error).message}</p>
          )}
        </div>
      )}

      {/* Host list */}
      {isLoading && <p className="text-sm text-gray-500">Loading hosts…</p>}
      {error && <p className="text-sm text-red-400">{(error as Error).message}</p>}

      {!isLoading && !error && hosts.length === 0 && !editing && (
        <div className="rounded-lg border border-white/10 bg-surface-raised px-6 py-10 text-center">
          <p className="text-sm text-gray-400">No remote hosts configured.</p>
          <p className="text-xs text-gray-500 mt-1">
            Add a host to run{" "}
            <span className="text-amber-400">local-slow</span> and{" "}
            <span className="text-red-400">cloud-recommended</span> pipelines on a remote machine
            via SSH.
          </p>
        </div>
      )}

      {hosts.length > 0 && (
        <div className="space-y-3">
          {hosts.map((h) => (
            <HostCard
              key={h.id}
              host={h}
              onEdit={() => setEditing({ mode: "edit", host: h })}
              onDelete={() => deleteMut.mutate(h.id)}
            />
          ))}
        </div>
      )}

      {/* Key note */}
      <div className="mt-8 rounded-lg border border-white/8 bg-surface-overlay p-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
          SSH key setup
        </h3>
        <p className="text-xs text-gray-500 leading-relaxed">
          NeuroForge uses key-based SSH authentication. Place your private key on the machine
          running the NeuroForge backend and enter its absolute path here. The key is never
          stored in the database — only the path is recorded. The remote user must be in the
          <code className="mx-1 font-mono text-gray-400">docker</code> group so NeuroForge can
          run containers without <code className="font-mono text-gray-400">sudo</code>.
        </p>
      </div>
    </div>
  );
}
