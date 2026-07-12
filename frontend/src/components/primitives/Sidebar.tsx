import { useState } from "react";
import { NavLink } from "react-router-dom";
import { AboutDialog } from "../onboarding/AboutDialog";
import { useOnboarding } from "../../context/OnboardingContext";
import { useHealth } from "../../hooks/useHealth";
import { StatusBadge } from "./StatusBadge";

const NAV_ITEMS = [
  { to: "/", label: "Home", end: true },
  { to: "/datasets", label: "Datasets", end: false },
  { to: "/pipelines", label: "Pipelines", end: false },
  { to: "/runs", label: "Runs", end: false },
  { to: "/workflows/new", label: "Workflows", end: true },
  { to: "/workflows/library", label: "Library", end: false },
] as const;

const WIZARD_ITEMS = [
  { to: "/wizard/dcm2bids", label: "DICOM Wizard", end: false },
] as const;

const SETTINGS_ITEMS = [
  { to: "/settings/remote-hosts", label: "Remote Hosts", end: false },
  { to: "/settings", label: "Settings", end: true },
] as const;

function NavItem({ to, label, end }: { to: string; label: string; end: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `rounded-md px-3 py-2 text-sm transition-colors ${
          isActive
            ? "bg-accent/20 text-accent font-medium"
            : "text-gray-400 hover:bg-surface-overlay hover:text-gray-100"
        }`
      }
    >
      {label}
    </NavLink>
  );
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
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0 text-gray-500">
            <path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z" />
          </svg>
          Restart Onboarding
        </button>

        <button
          role="menuitem"
          onClick={() => setShowShortcuts(true)}
          className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-surface-overlay hover:text-white transition-colors flex items-center gap-2.5"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0 text-gray-500">
            <path d="M0 2.75A2.75 2.75 0 0 1 2.75 0h10.5A2.75 2.75 0 0 1 16 2.75v10.5A2.75 2.75 0 0 1 13.25 16H2.75A2.75 2.75 0 0 1 0 13.25ZM2.75 1.5c-.69 0-1.25.56-1.25 1.25v10.5c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25V2.75c0-.69-.56-1.25-1.25-1.25ZM3.5 4.25a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1-.75-.75Zm4 0a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1-.75-.75Zm-4 4a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5A.75.75 0 0 1 3.5 8.25Zm4 0a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1-.75-.75Zm-4 4a.75.75 0 0 1 .75-.75h5.5a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1-.75-.75Z" />
          </svg>
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
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5 shrink-0 text-gray-500">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
          </svg>
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
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0 text-gray-500">
            <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" /><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
          </svg>
          Release Notes
        </a>

        <div className="my-1 border-t border-white/8" />

        <button
          role="menuitem"
          onClick={() => setShowAbout(true)}
          className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-surface-overlay hover:text-white transition-colors flex items-center gap-2.5"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0 text-gray-500">
            <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
          </svg>
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
        <h1 className="text-lg font-semibold tracking-tight text-white">NeuroForge</h1>
        <p className="mt-0.5 hidden text-xs text-muted sm:block">Neuroimaging orchestrator</p>
      </div>

      <nav className="flex flex-1 gap-1 overflow-x-auto md:flex-col md:overflow-visible">
        {NAV_ITEMS.map(({ to, label, end }) => (
          <NavItem key={to} to={to} label={label} end={end} />
        ))}

        <SectionLabel>Wizards</SectionLabel>
        {WIZARD_ITEMS.map(({ to, label, end }) => (
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
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
              <path fillRule="evenodd" d="M7.89 1.077a.75.75 0 0 1 .22 0l4.25.85a.75.75 0 0 1 .59.98l-1.5 4.5a.75.75 0 0 1-.71.51H9.25a.75.75 0 0 1-.71-.51L7.04 2.907a.75.75 0 0 1 .59-.98l.26-.05ZM8 2.675l-.97 2.9h1.94L8 2.675ZM2.625 7a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 .53 1.28l-1.72 1.72H6.5a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1-.53-1.28l1.72-1.72h-.315A.75.75 0 0 1 2.625 7Zm7.25 2a.75.75 0 0 1 .75-.75h2.75a.75.75 0 0 1 .55 1.26l-1.9 2.24H13.5a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1-.55-1.26l1.9-2.24H9.875A.75.75 0 0 1 9.875 9Z" clipRule="evenodd" />
            </svg>
            {label}
          </NavLink>
        ))}

        <SectionLabel>Settings</SectionLabel>
        {SETTINGS_ITEMS.map(({ to, label, end }) => (
          <NavItem key={to} to={to} label={label} end={end} />
        ))}
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
