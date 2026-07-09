import { NavLink } from "react-router-dom";
import { useHealth } from "../../hooks/useHealth";
import { StatusBadge } from "./StatusBadge";

const NAV_ITEMS = [
  { to: "/", label: "Home", end: true },
  { to: "/datasets", label: "Datasets", end: false },
  { to: "/pipelines", label: "Pipelines", end: false },
  { to: "/runs", label: "Runs", end: false },
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
      </nav>

      <div className="px-2 pt-4 border-t border-white/5">
        <StatusBadge connected={isSuccess} loading={isLoading} />
      </div>
    </aside>
  );
}
