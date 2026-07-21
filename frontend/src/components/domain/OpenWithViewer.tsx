import { useEffect, useMemo, useState } from "react";
import type { ArtifactViewModel } from "../../lib/neuroArtifactView";
import {
  browserViewerAvailability,
  compatibleViewers,
  createLaunchPreset,
  type ViewerId,
} from "../../lib/viewerPlugins";

const PREFERENCE_KEY = "neuroforge.preferredViewer";

export default function OpenWithViewer({
  runId,
  artifact,
  candidates,
  onOpenNeuroForge,
}: {
  runId: number;
  artifact: ArtifactViewModel;
  candidates: ArtifactViewModel[];
  onOpenNeuroForge: () => void;
}) {
  const plugins = useMemo(() => compatibleViewers(artifact), [artifact]);
  const [preferred, setPreferred] = useState<ViewerId>(() =>
    (localStorage.getItem(PREFERENCE_KEY) as ViewerId | null) ?? "neuroforge");
  const [detections, setDetections] = useState<Record<string, { installed: boolean; reason: string | null }>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [localWorkspaceId, setLocalWorkspaceId] = useState<string | null>(null);
  const desktop = window.neuroforgeDesktop;

  useEffect(() => {
    if (!desktop) return;
    void Promise.all([desktop.detectViewers(), desktop.getLocalWorkspaceIdentity()]).then(([values, identity]) => {
      setDetections(Object.fromEntries(values.map((value) => [value.viewerId, value])));
      setLocalWorkspaceId(identity.workspaceId);
    });
  }, [desktop]);

  async function choose(viewerId: ViewerId) {
    setPreferred(viewerId);
    localStorage.setItem(PREFERENCE_KEY, viewerId);
    setMessage(null);
    if (viewerId === "neuroforge") { onOpenNeuroForge(); return; }
    if (!desktop) {
      setMessage(browserViewerAvailability(plugins.find((plugin) => plugin.id === viewerId)!).reason);
      return;
    }
    if (!detections[viewerId]?.installed) {
      setMessage(detections[viewerId]?.reason ?? `${viewerId} is not installed.`);
      return;
    }
    if (!localWorkspaceId) {
      setMessage("Local workspace identity is not ready.");
      return;
    }
    const preset = createLaunchPreset(artifact, candidates);
    await desktop.launchLocalViewer({
      viewerId,
      workspaceId: localWorkspaceId,
      runId,
      files: preset.files.map((file, index) => ({ relativePath: file.path, overlay: index > 0 })),
      opacity: preset.opacity,
      freesurferLut: preset.lut === "freesurfer",
    });
    setMessage(`Run #${runId} opened directly from its existing local artifact.`);
  }

  return (
    <div className="relative">
      <label className="sr-only" htmlFor={`viewer-${runId}-${artifact.path}`}>Open With</label>
      <select
        id={`viewer-${runId}-${artifact.path}`}
        aria-label={`Open ${artifact.name} with viewer`}
        value={preferred}
        onChange={(event) => { void choose(event.target.value as ViewerId); }}
        className="rounded border border-white/10 bg-slate-950 px-2 py-1 text-[10px] text-slate-200"
      >
        {plugins.map((plugin) => {
          const disabled = plugin.localOnly && (!desktop || detections[plugin.id]?.installed === false);
          return <option key={plugin.id} value={plugin.id} disabled={disabled}>
            {plugin.id === "neuroforge" ? "Open With: NeuroForge Viewer" : plugin.displayName}
          </option>;
        })}
      </select>
      {!desktop && plugins.some((plugin) => plugin.localOnly) && (
        <p className="mt-1 max-w-xs text-[9px] text-slate-500">
          Desktop viewers are unavailable in the browser. Use NeuroForge Desktop to synchronize and launch them.
        </p>
      )}
      {message && <p role="status" className="mt-1 max-w-xs text-[9px] text-amber-300">{message}</p>}
    </div>
  );
}
