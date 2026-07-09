import { NavLink } from "react-router-dom";
import { useHealth } from "../../hooks/useHealth";
import { StatusBadge } from "./StatusBadge";

const NAV_ITEMS = [
  { to: "/", label: "Home", end: true },
  { to: "/datasets", label: "Datasets", end: false },
  { to: "/pipelines", label: "Pipelines", end: false },
  { to: "/runs", label: "Runs", end: false },
] as const;

const WIZARD_ITEMS = [
  { to: "/wizard/dcm2bids", label: "DICOM Wizard", end: false },
] as const;

export function Sidebar() {
  const { isSuccess, isLoading } = useHealth();

  return (
    <aside className="flex h-screen w-52 flex-col bg-surface-raised border-r border-white/5 py-4 px-3 shrink-0">
      <div className="mb-6 px-2">
        <h1 className="text-lg font-semibold tracking-tight text-white">NeuroForge</h1>
        <p className="text-xs text-muted mt-0.5">Neuroimaging orchestrator</p>
      </div>

      <nav className="flex flex-col gap-1 flex-1">
        {NAV_ITEMS.map(({ to, label, end }) => (
          <NavLink
            key={to}
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
        ))}

        <div className="mt-4 mb-1 px-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-600">Wizards</p>
        </div>
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
      </nav>

      <div className="px-2 pt-4 border-t border-white/5">
        <StatusBadge connected={isSuccess} loading={isLoading} />
      </div>
    </aside>
  );
}
