import { usePlugins } from "../hooks/usePlugins";
import type { PluginInfo } from "../api/client";

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: PluginInfo["status"] }) {
  const styles: Record<PluginInfo["status"], string> = {
    ok: "bg-green-900/60 text-green-300 border border-green-700/40",
    disabled: "bg-gray-700/60 text-gray-400 border border-gray-600/40",
    error: "bg-red-900/60 text-red-300 border border-red-700/40",
  };
  const labels: Record<PluginInfo["status"], string> = {
    ok: "Active",
    disabled: "Disabled",
    error: "Error",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

// ── Plugin card ───────────────────────────────────────────────────────────────

function PluginCard({ plugin }: { plugin: PluginInfo }) {
  return (
    <div className="rounded-lg border border-white/10 bg-surface-overlay p-5 space-y-3">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-gray-100 truncate">{plugin.name}</h2>
            <StatusBadge status={plugin.status} />
          </div>
          <p className="text-xs text-gray-500 mt-0.5 font-mono">
            {plugin.id} &middot; v{plugin.version}
          </p>
        </div>
        {plugin.homepage && (
          <a
            href={plugin.homepage}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-xs text-accent hover:underline"
          >
            Docs ↗
          </a>
        )}
      </div>

      {/* Description */}
      <p className="text-xs text-gray-400 leading-relaxed">{plugin.description}</p>

      {/* Error message */}
      {plugin.error && (
        <div className="rounded-md bg-red-900/30 border border-red-700/40 px-3 py-2 text-xs text-red-300">
          <span className="font-medium">Load error: </span>{plugin.error}
        </div>
      )}

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        <div>
          <span className="text-gray-500">Author</span>
          <p className="text-gray-300 truncate">{plugin.author}</p>
        </div>
        {plugin.license && (
          <div>
            <span className="text-gray-500">License</span>
            <p className="text-gray-300">{plugin.license}</p>
          </div>
        )}
        {plugin.neuroforge_version && (
          <div>
            <span className="text-gray-500">Requires NeuroForge</span>
            <p className="text-gray-300">{plugin.neuroforge_version}</p>
          </div>
        )}
      </div>

      {/* Registered content */}
      {plugin.status === "ok" && (
        <div className="space-y-2 pt-1 border-t border-white/5">
          {plugin.pipeline_ids.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 mb-1">
                Pipelines ({plugin.pipeline_ids.length})
              </p>
              <div className="flex flex-wrap gap-1">
                {plugin.pipeline_ids.map((id) => (
                  <span
                    key={id}
                    className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono bg-accent/10 text-accent/80 border border-accent/20"
                  >
                    {id}
                  </span>
                ))}
              </div>
            </div>
          )}

          {plugin.artifact_type_slugs.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 mb-1">
                Artifact types ({plugin.artifact_type_slugs.length})
              </p>
              <div className="flex flex-wrap gap-1">
                {plugin.artifact_type_slugs.map((slug) => (
                  <span
                    key={slug}
                    className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono bg-white/5 text-gray-400 border border-white/10"
                  >
                    {slug}
                  </span>
                ))}
              </div>
            </div>
          )}

          {plugin.pipeline_ids.length === 0 && plugin.artifact_type_slugs.length === 0 && (
            <p className="text-xs text-gray-600">No pipelines or artifact types registered.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Plugins() {
  const { data: plugins, isLoading, error } = usePlugins();

  const active = plugins?.filter((p) => p.status === "ok") ?? [];
  const disabled = plugins?.filter((p) => p.status === "disabled") ?? [];
  const errored = plugins?.filter((p) => p.status === "error") ?? [];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 border-b border-white/10 px-6 py-4">
        <h1 className="text-lg font-semibold text-gray-100">Plugins</h1>
        <p className="text-xs text-gray-500 mt-0.5">
          Extend NeuroForge with additional pipelines by adding a plugin directory to{" "}
          <code className="font-mono text-gray-400">plugins/</code>.
        </p>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading && (
          <p className="text-sm text-gray-500">Loading plugins…</p>
        )}

        {error && (
          <div className="rounded-md bg-red-900/30 border border-red-700/40 px-4 py-3 text-sm text-red-300">
            Could not load plugin list: {(error as Error).message}
          </div>
        )}

        {!isLoading && !error && plugins?.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-3">
            <p className="text-sm text-gray-400">No plugins installed.</p>
            <p className="text-xs text-gray-600 max-w-sm">
              Drop a plugin directory into <code className="font-mono text-gray-500">plugins/</code> at
              the NeuroForge project root. Each plugin must contain a{" "}
              <code className="font-mono text-gray-500">plugin.yaml</code> file.
            </p>
          </div>
        )}

        {!isLoading && !error && plugins && plugins.length > 0 && (
          <div className="space-y-6 max-w-3xl">
            {errored.length > 0 && (
              <section>
                <h2 className="text-xs font-medium text-red-400 uppercase tracking-wider mb-3">
                  Load errors ({errored.length})
                </h2>
                <div className="space-y-3">
                  {errored.map((p) => <PluginCard key={p.id} plugin={p} />)}
                </div>
              </section>
            )}

            {active.length > 0 && (
              <section>
                <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
                  Active ({active.length})
                </h2>
                <div className="space-y-3">
                  {active.map((p) => <PluginCard key={p.id} plugin={p} />)}
                </div>
              </section>
            )}

            {disabled.length > 0 && (
              <section>
                <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
                  Disabled ({disabled.length})
                </h2>
                <div className="space-y-3">
                  {disabled.map((p) => <PluginCard key={p.id} plugin={p} />)}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
