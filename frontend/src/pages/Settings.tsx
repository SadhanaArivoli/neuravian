import { useOnboarding } from "../context/OnboardingContext";

export default function Settings() {
  const { state, restart, setHints } = useOnboarding();

  return (
    <div className="p-8 max-w-lg">
      <h2 className="text-2xl font-semibold mb-1">Settings</h2>
      <p className="text-sm text-gray-400 mb-8">Application preferences and onboarding controls.</p>

      {/* Onboarding */}
      <section className="mb-8">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-4">Onboarding</h3>
        <div className="rounded-lg border border-white/8 bg-surface-raised divide-y divide-white/5">
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-sm font-medium text-gray-200">Tour status</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {state.completed
                  ? `Completed ${state.completedAt ? new Date(state.completedAt).toLocaleDateString() : ""}`
                  : state.skipped
                  ? "Skipped"
                  : "Not started"}
              </p>
            </div>
            <button
              onClick={restart}
              className="rounded-md border border-white/15 px-3 py-1.5 text-sm text-gray-300 hover:border-white/30 hover:text-white transition-colors focus:outline-none focus:ring-2 focus:ring-white/20"
            >
              Restart tour
            </button>
          </div>

          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-sm font-medium text-gray-200">Contextual hints</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Show inline tips on empty pages
              </p>
            </div>
            <button
              role="switch"
              aria-checked={state.hintsEnabled}
              onClick={() => setHints(!state.hintsEnabled)}
              className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-surface cursor-pointer ${
                state.hintsEnabled ? "bg-accent" : "bg-surface-overlay"
              }`}
            >
              <span className="sr-only">Toggle contextual hints</span>
              <span
                className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform duration-200 ease-in-out ${
                  state.hintsEnabled ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          </div>
        </div>
      </section>

      {/* Version info */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-4">About</h3>
        <div className="rounded-lg border border-white/8 bg-surface-raised px-4 py-3 space-y-1.5">
          {[
            { label: "Version", value: "0.1.0-alpha" },
            { label: "License", value: "Apache 2.0" },
          ].map(({ label, value }) => (
            <div key={label} className="flex items-center justify-between">
              <span className="text-xs text-gray-500">{label}</span>
              <span className="text-xs text-gray-300 font-mono">{value}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-600 mt-3">
          For full version details, open <span className="text-gray-500">Help → About NeuroForge</span>.
        </p>
      </section>
    </div>
  );
}
