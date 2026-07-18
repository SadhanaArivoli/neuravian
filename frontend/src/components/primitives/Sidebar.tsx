import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { AboutDialog } from "../onboarding/AboutDialog";
import { useOnboarding } from "../../context/OnboardingContext";
import { useHealth } from "../../hooks/useHealth";
import { StatusBadge } from "./StatusBadge";
import { WorkbenchIcons } from "../../lib/iconRegistry";
import { useWorkspace, type WorkspaceSelection } from "../../context/WorkspaceContext";

const NAV_ITEMS = [
  { to: "/", label: "Home", end: true, icon: WorkbenchIcons.home },
  { to: "/projects", label: "Projects", end: false, icon: WorkbenchIcons.project },
  { to: "/datasets", label: "Datasets", end: false, icon: WorkbenchIcons.dataset },
  { to: "/pipelines", label: "Pipelines", end: false, icon: WorkbenchIcons.pipeline },
  { to: "/runs", label: "Runs", end: false, icon: WorkbenchIcons.activity },
  { to: "/workflows/new", label: "Workflows", end: true, icon: WorkbenchIcons.workflow },
  { to: "/workflows/library", label: "Library", end: false, icon: WorkbenchIcons.library },
] as const;

const WIZARD_ITEMS = [
  { to: "/wizard/dcm2bids", label: "DICOM Wizard", end: false, icon: WorkbenchIcons.wizard },
] as const;

const SETTINGS_ITEMS = [
  { to: "/plugins", label: "Plugins", end: false, icon: WorkbenchIcons.plugin },
  { to: "/settings/remote-hosts", label: "Remote Hosts", end: false, icon: WorkbenchIcons.network },
  { to: "/settings", label: "Settings", end: true, icon: WorkbenchIcons.settings },
] as const;

const DESKTOP_NAV = [
  { view: "home", label: "Workspace", icon: WorkbenchIcons.home },
  { view: "projects", label: "Projects", icon: WorkbenchIcons.project },
  { view: "datasets", label: "Datasets", icon: WorkbenchIcons.dataset },
  { view: "workflows", label: "Workflows", icon: WorkbenchIcons.workflow },
  { view: "runs", label: "Runs", icon: WorkbenchIcons.activity },
  { view: "reports", label: "Reports", icon: WorkbenchIcons.library },
  { view: "settings", label: "Settings", icon: WorkbenchIcons.settings },
] as const;

function NavItem({ to, label, end, icon: Icon }: { to: string; label: string; end: boolean; icon: typeof WorkbenchIcons.home }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
          isActive
            ? "bg-accent/20 text-accent font-medium"
            : "text-gray-400 hover:bg-surface-overlay hover:text-gray-100"
        }`
      }
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {label}
    </NavLink>
  );
}

function DesktopNav() {
  const location = useLocation();
  const { selected } = useWorkspace();
  const activeView = new URLSearchParams(location.search).get("view") ?? "home";
  const localRoutes: Record<string, string> = {
    home: "/workspaces?scope=local", projects: "/projects", datasets: "/datasets",
    workflows: "/workflows/library", runs: "/runs",
    reports: "/workspaces?scope=local&view=reports", settings: "/settings",
  };
  const cloudScope = selected.startsWith("cloud:") ? `cloud:${selected.slice(6)}` : selected;
  return DESKTOP_NAV.map(({ view, label, icon: Icon }) => {
    const to = selected === "local"
      ? localRoutes[view]
      : `/workspaces?scope=${encodeURIComponent(cloudScope)}${view === "home" ? "" : `&view=${view}`}`;
    const active = location.pathname === new URL(to, "https://desktop.local").pathname &&
      (location.pathname !== "/workspaces" || activeView === view);
    return <Link key={to} to={to} className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
      active ? "bg-accent/20 font-medium text-accent" : "text-gray-400 hover:bg-surface-overlay hover:text-gray-100"
    }`}>
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {label}
    </Link>;
  });
}

function WorkspaceSwitcher() {
  const desktop = window.neuroforgeDesktop!;
  const navigate = useNavigate();
  const { selected, select, local, cloudProfiles } = useWorkspace();
  const [localCounts, setLocalCounts] = useState({ datasets: 0, runs: 0, workflows: 0 });
  const [cloudCounts, setCloudCounts] = useState<Record<string, { datasets: number; runs: number; workflows: number }>>({});

  useEffect(() => {
    void Promise.all([
      fetch("/api/datasets").then((response) => response.ok ? response.json() : []),
      fetch("/api/runs").then((response) => response.ok ? response.json() : []),
      fetch("/api/workflows").then((response) => response.ok ? response.json() : []),
    ]).then(([datasets, runs, workflows]) => setLocalCounts({
      datasets: datasets.length, runs: runs.length, workflows: workflows.length,
    }));
    for (const profile of cloudProfiles) {
      void desktop.syncWorkspace(profile.id).then(({ snapshot }) => setCloudCounts((current) => ({
        ...current, [profile.id]: {
          datasets: snapshot.datasets.length, runs: snapshot.runs.length, workflows: snapshot.workflows.length,
        },
      }))).catch(() => undefined);
    }
  }, [cloudProfiles, desktop]);

  const selectedLabel = useMemo(() => selected === "local" ? "Local NeuroForge"
    : selected === "all" ? "All Workspaces"
      : cloudProfiles.find((profile) => `cloud:${profile.id}` === selected)?.name ?? "Cloud workspace",
  [selected, cloudProfiles]);

  function change(value: WorkspaceSelection) {
    select(value);
    navigate(`/workspaces?scope=${encodeURIComponent(value)}`);
  }

  const activeCloud = selected.startsWith("cloud:") ? cloudProfiles.find((profile) => profile.id === selected.slice(6)) : null;
  const activeCounts = activeCloud ? cloudCounts[activeCloud.id] : null;
  return <div className="mb-3 rounded-lg border border-white/8 bg-slate-950/35 p-2">
    <label className="text-[9px] font-semibold uppercase tracking-widest text-slate-500" htmlFor="workspace-selector">Workspaces</label>
    <select id="workspace-selector" value={selected} onChange={(event) => change(event.target.value as WorkspaceSelection)}
      className="mt-1 w-full rounded border border-white/10 bg-slate-950 px-2 py-1.5 text-xs font-semibold text-white">
      <option value="local">Local NeuroForge</option>
      {cloudProfiles.map((profile) => <option key={profile.id} value={`cloud:${profile.id}`}>{profile.name}</option>)}
      <option value="all">All Workspaces</option>
    </select>
    <p className="mt-2 truncate text-[10px] font-medium text-slate-300">{selectedLabel}</p>
    {selected === "local" && <p className="mt-0.5 text-[9px] text-emerald-300">Local · {localCounts.datasets} datasets · {localCounts.workflows} workflows · {localCounts.runs} runs · Available offline</p>}
    {activeCloud && <p className="mt-0.5 text-[9px] text-cyan-300">{activeCloud.connectionState === "connected" ? "Connected" : activeCloud.connectionState} · {activeCounts?.datasets ?? "—"} datasets · {activeCounts?.runs ?? "—"} runs</p>}
    {selected === "all" && <p className="mt-0.5 text-[9px] text-slate-400">{local ? "Local + connected cloud metadata" : "Discovering workspaces…"}</p>}
  </div>;
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="hidden md:mb-1 md:mt-4 md:block md:px-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-600">{children}</p>
    </div>
  );
}

// ── Help menu ─────────────────────────────────────────────────────────────────

const KEYBOARD_SHORTCUTS = [
  { key: "Esc",         action: "Close overlay / cancel" },
  { key: "→ / ↓",      action: "Next tour step" },
  { key: "← / ↑",      action: "Previous tour step" },
  { key: "?",           action: "Open Help menu" },
];

function KeyboardShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div className="relative z-10 w-full max-w-xs rounded-2xl border border-white/10 bg-surface shadow-2xl p-5">
        <h2 className="text-sm font-bold text-white mb-4">Keyboard Shortcuts</h2>
        <div className="space-y-2">
          {KEYBOARD_SHORTCUTS.map(({ key, action }) => (
            <div key={key} className="flex items-center justify-between gap-4">
              <kbd className="rounded bg-surface-overlay px-2 py-0.5 text-xs font-mono text-gray-300 border border-white/10">{key}</kbd>
              <span className="text-xs text-gray-400 flex-1 text-right">{action}</span>
            </div>
          ))}
        </div>
        <button
          onClick={onClose}
          className="mt-5 w-full rounded-md bg-surface-overlay px-4 py-1.5 text-sm text-gray-300 hover:text-white transition-colors focus:outline-none focus:ring-2 focus:ring-white/20"
          autoFocus
        >
          Close
        </button>
      </div>
    </div>
  );
}

function HelpMenu({ onClose }: { onClose: () => void }) {
  const { restart } = useOnboarding();
  const [showAbout, setShowAbout] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);

  if (showAbout) {
    return <AboutDialog onClose={() => { setShowAbout(false); onClose(); }} />;
  }
  if (showShortcuts) {
    return <KeyboardShortcutsDialog onClose={() => { setShowShortcuts(false); onClose(); }} />;
  }

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />
      <div
        role="menu"
        className="absolute bottom-10 left-2 z-50 w-52 rounded-xl border border-white/10 bg-surface-raised shadow-2xl shadow-black/50 py-1 overflow-hidden"
      >
        <button
          role="menuitem"
          onClick={() => { restart(); onClose(); }}
          className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-surface-overlay hover:text-white transition-colors flex items-center gap-2.5"
        >
          <WorkbenchIcons.reset className="h-3.5 w-3.5 shrink-0 text-gray-500" aria-hidden="true" />
          Restart Onboarding
        </button>

        <button
          role="menuitem"
          onClick={() => setShowShortcuts(true)}
          className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-surface-overlay hover:text-white transition-colors flex items-center gap-2.5"
        >
          <WorkbenchIcons.keyboard className="h-3.5 w-3.5 shrink-0 text-gray-500" aria-hidden="true" />
          Keyboard Shortcuts
        </button>

        <div className="my-1 border-t border-white/8" />

        <a
          role="menuitem"
          href="https://github.com/SadhanaArivoli/neuroforge"
          target="_blank"
          rel="noopener noreferrer"
          onClick={onClose}
          className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-surface-overlay hover:text-white transition-colors flex items-center gap-2.5"
        >
          <WorkbenchIcons.github className="h-3.5 w-3.5 shrink-0 text-gray-500" aria-hidden="true" />
          GitHub
        </a>

        <a
          role="menuitem"
          href="https://github.com/SadhanaArivoli/neuroforge/releases"
          target="_blank"
          rel="noopener noreferrer"
          onClick={onClose}
          className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-surface-overlay hover:text-white transition-colors flex items-center gap-2.5"
        >
          <WorkbenchIcons.info className="h-3.5 w-3.5 shrink-0 text-gray-500" aria-hidden="true" />
          Release Notes
        </a>

        <div className="my-1 border-t border-white/8" />

        <button
          role="menuitem"
          onClick={() => setShowAbout(true)}
          className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-surface-overlay hover:text-white transition-colors flex items-center gap-2.5"
        >
          <WorkbenchIcons.info className="h-3.5 w-3.5 shrink-0 text-gray-500" aria-hidden="true" />
          About NeuroForge
        </button>
      </div>
    </>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

export function Sidebar() {
  const { isSuccess, isLoading } = useHealth();
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <aside className="flex shrink-0 flex-col gap-3 border-b border-white/5 bg-surface-raised px-3 py-3 md:h-screen md:w-52 md:border-b-0 md:border-r md:py-4">
      <div className="px-2 md:mb-3">
        <div className="text-lg font-semibold tracking-tight text-white">NeuroForge</div>
        <p className="mt-0.5 hidden text-xs text-muted sm:block">Neuroimaging orchestrator</p>
      </div>

      <nav className="flex flex-1 gap-1 overflow-x-auto md:flex-col md:overflow-visible">
        {window.neuroforgeDesktop ? <><WorkspaceSwitcher /><DesktopNav /></> : <>
          {NAV_ITEMS.map(({ to, label, end, icon }) => (
            <NavItem key={to} to={to} label={label} end={end} icon={icon} />
          ))}

          <SectionLabel>Wizards</SectionLabel>
          {WIZARD_ITEMS.map(({ to, label, end, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `rounded-md px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
                  isActive
                    ? "bg-accent/20 text-accent font-medium"
                    : "text-gray-400 hover:bg-surface-overlay hover:text-gray-100"
                }`
              }
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {label}
            </NavLink>
          ))}

          <SectionLabel>Settings</SectionLabel>
          {SETTINGS_ITEMS.map(({ to, label, end, icon }) => (
            <NavItem key={to} to={to} label={label} end={end} icon={icon} />
          ))}
        </>}
      </nav>

      <div className="hidden border-t border-white/5 px-2 pt-3 md:block space-y-2">
        <StatusBadge connected={isSuccess} loading={isLoading} />

        {/* Help button */}
        <div className="relative">
          <button
            onClick={() => setHelpOpen((v) => !v)}
            aria-label="Help menu"
            aria-expanded={helpOpen}
            className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-gray-500 hover:text-gray-300 hover:bg-surface-overlay transition-colors focus:outline-none focus:ring-2 focus:ring-white/20"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
              <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
            </svg>
            Help
          </button>
          {helpOpen && <HelpMenu onClose={() => setHelpOpen(false)} />}
        </div>
      </div>
    </aside>
  );
}
