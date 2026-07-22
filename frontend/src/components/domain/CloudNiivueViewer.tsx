import { useEffect, useState } from "react";
import { VIEWER_RUNTIME_BUILD } from "../../../../desktop/src/preload/viewer-api-contract";
import NiivueViewer, { type NiivueLayer } from "./NiivueViewer";

export interface CloudViewerLayer {
  relativePath: string;
  label: string;
  isOverlay?: boolean;
  opacity?: number;
}

interface Props {
  workspaceId: string;
  runId: number;
  layers: CloudViewerLayer[];
  onClose: () => void;
}

/**
 * Compatibility transport for synchronized workspaces.
 *
 * Artifact bytes remain behind the validated desktop cache boundary. Once
 * authorized bytes are materialized as short-lived object URLs, rendering is
 * delegated to the same NiivueViewer/NeuroImageViewer used by local runs.
 */
export function CloudNiivueViewer({ workspaceId, runId, layers, onClose }: Props) {
  const [resolved, setResolved] = useState<NiivueLayer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingLabel, setLoadingLabel] = useState("Preparing artifact…");

  useEffect(() => {
    const urls: string[] = [];
    const controller = new AbortController();
    const desktop = window.neuravianDesktop;

    async function materialize() {
      if (!desktop || desktop.viewerRuntimeBuild !== VIEWER_RUNTIME_BUILD || typeof desktop.readArtifact !== "function") {
        throw new Error("The secure artifact reader is unavailable. Restart Neuravian Desktop and try again.");
      }
      const output: NiivueLayer[] = [];
      for (let index = 0; index < layers.length; index += 1) {
        const layer = layers[index];
        setLoadingLabel(`Preparing ${layer.label} (${index + 1}/${layers.length})…`);
        const bytes = await desktop.readArtifact({ workspaceId, runId, relativePath: layer.relativePath });
        if (controller.signal.aborted) return;
        const owned = Uint8Array.from(bytes);
        const url = URL.createObjectURL(new Blob([owned.buffer]));
        urls.push(url);
        output.push({
          url,
          name: layer.relativePath,
          isSegmentation: !!layer.isOverlay,
          opacity: layer.isOverlay ? (layer.opacity ?? 0.7) : 1,
        });
      }
      setResolved(output);
    }

    void materialize().catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "The artifact could not be prepared.");
      }
    });
    return () => {
      controller.abort();
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [layers, runId, workspaceId]);

  if (resolved) return <NiivueViewer layers={resolved} onClose={onClose} />;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[#0d1117]" role="dialog" aria-modal="true" aria-label="Neuravian Viewer">
      <div className="max-w-md px-8 text-center">
        {error ? (
          <>
            <p className="text-sm font-semibold text-red-400">Artifact temporarily unavailable</p>
            <p className="mt-2 text-xs text-slate-400">{error}</p>
            <p className="mt-2 text-xs text-slate-500">Reconnect the workspace or synchronize the artifact, then try again.</p>
          </>
        ) : (
          <>
            <div className="mx-auto h-5 w-5 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
            <p className="mt-3 text-sm text-slate-400">{loadingLabel}</p>
          </>
        )}
        <button onClick={onClose} className="mt-5 rounded-md border border-white/10 px-3 py-1 text-sm text-slate-300 hover:text-white">Close</button>
      </div>
    </div>
  );
}
