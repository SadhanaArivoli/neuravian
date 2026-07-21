interface RemoteOption { id: string; name: string }

export function WorkflowHandoffPanel({
  pipelineNames, artifactType, profiles, selectedProfileId, busy, error,
  onSelectProfile, onContinue,
}: {
  pipelineNames: string[];
  artifactType: string;
  profiles: RemoteOption[];
  selectedProfileId: string;
  busy: boolean;
  error?: string | null;
  onSelectProfile: (id: string) => void;
  onContinue: () => void;
}) {
  return (
    <section className="mt-5 rounded-lg border border-blue-500/30 bg-blue-500/10 p-5" aria-label="Cloud handoff">
      <h2 className="text-lg font-semibold text-white">This workflow now requires cloud execution.</h2>
      <p className="mt-1 text-sm text-blue-200">Completed local nodes will not be rerun.</p>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="text-gray-500">Remote pipelines</dt><dd className="mt-1 text-gray-200">{pipelineNames.join(", ")}</dd></div>
        <div><dt className="text-gray-500">Required input</dt><dd className="mt-1 text-gray-200">{artifactType}</dd></div>
        <div><dt className="text-gray-500">Synchronization size</dt><dd className="mt-1 text-gray-200">Calculated from the verified handoff manifest</dd></div>
        <div><dt className="text-gray-500">Runtime / cost</dt><dd className="mt-1 text-gray-200">No reliable estimate available</dd></div>
      </dl>
      <label className="mt-4 block max-w-md text-xs font-semibold uppercase tracking-widest text-gray-500">
        Remote host
        <select value={selectedProfileId} onChange={(event) => onSelectProfile(event.target.value)} className="mt-2 w-full rounded-md border border-white/10 bg-surface px-3 py-2 text-sm font-normal normal-case tracking-normal text-gray-100">
          <option value="">Choose a cloud workspace</option>
          {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
      </label>
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      <button type="button" onClick={onContinue} disabled={busy || !selectedProfileId} className="mt-4 rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-45">
        {busy ? "Synchronizing and continuing…" : "Continue in Cloud"}
      </button>
    </section>
  );
}
