import { useEffect, useRef, useState } from "react";
import { createNiftiFromMgh, decompressMgz, isMghPath, parseMgh } from "../../lib/mgh";
import { VIEWER_RUNTIME_BUILD } from "../../../../desktop/src/preload/viewer-api-contract";

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

export function CloudNiivueViewer({ workspaceId, runId, layers, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingStep, setLoadingStep] = useState("Loading volumes…");
  const [overlayOpacity, setOverlayOpacity] = useState(0.7);
  const nvRef = useRef<{ setOpacity: (idx: number, opacity: number) => void } | null>(null);

  useEffect(() => {
    const aborted = { current: false };
    const desktop = window.neuroforgeDesktop!;

    async function init() {
      if (!canvasRef.current) return;
      if (desktop.viewerRuntimeBuild !== VIEWER_RUNTIME_BUILD || typeof desktop.readArtifact !== "function") {
        throw new Error("Viewer preload contract mismatch. Restart NeuroForge.");
      }

      const { Niivue, NVImage } = await import("@niivue/niivue");
      if (aborted.current) return;

      const nv = new Niivue({
        isColorbar: true,
        show3Dcrosshair: true,
        backColor: [0.07, 0.07, 0.07, 1],
        crosshairColor: [1, 0, 0, 1],
      });
      nv.attachToCanvas(canvasRef.current);
      nvRef.current = nv as typeof nvRef.current;

      const volumes: { url: ArrayBuffer; name: string; opacity: number; colormap: string }[] = [];

      for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        setLoadingStep(`Reading ${layer.label} (${i + 1}/${layers.length})…`);

        const rawBuffer = (await desktop.readArtifact({
          workspaceId,
          runId,
          relativePath: layer.relativePath,
        })) as Uint8Array;
        if (aborted.current) return;

        let url: ArrayBuffer;
        let name: string;

        if (isMghPath(layer.relativePath)) {
          const parsed = parseMgh(await decompressMgz(rawBuffer.buffer as ArrayBuffer));
          const nifti = createNiftiFromMgh(parsed, NVImage);
          url = nifti.buffer as ArrayBuffer;
          name = `${layer.label}.nii`;
        } else {
          url = rawBuffer.buffer as ArrayBuffer;
          name = layer.label;
        }

        volumes.push({
          url,
          name,
          opacity: layer.isOverlay ? (layer.opacity ?? 0.7) : 1,
          colormap: layer.isOverlay ? "roi_i256" : "gray",
        });
      }

      if (aborted.current) return;
      setLoadingStep("Rendering…");
      // NiiVue accepts ArrayBuffer at runtime despite TypeScript requiring string
      await nv.loadVolumes(volumes as unknown as Parameters<typeof nv.loadVolumes>[0]);
      nv.setSliceType(nv.sliceTypeMultiplanar);
      setLoading(false);
    }

    init().catch((err: unknown) => {
      if (!aborted.current) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    });

    return () => { aborted.current = true; };
  }, [workspaceId, runId]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleOpacityChange(value: number) {
    setOverlayOpacity(value);
    // Overlay is always index 1 when present
    if (nvRef.current && layers.length > 1) {
      nvRef.current.setOpacity(1, value);
    }
  }

  const hasOverlay = layers.some((l) => l.isOverlay);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#0d1117]" role="dialog" aria-label="NeuroForge Viewer">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 border-b border-white/8 px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-white">NeuroForge Viewer</span>
          {!loading && !error && (
            <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-0.5 text-[10px] text-emerald-300">
              {layers.map((l) => l.label).join(" + ")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          {hasOverlay && !loading && !error && (
            <label className="flex items-center gap-2 text-xs text-slate-400">
              Overlay opacity
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={overlayOpacity}
                onChange={(e) => handleOpacityChange(Number(e.target.value))}
                className="w-24 accent-cyan-400"
              />
              <span className="w-8 tabular-nums">{Math.round(overlayOpacity * 100)}%</span>
            </label>
          )}
          <button
            onClick={onClose}
            className="rounded-md border border-white/10 px-3 py-1 text-sm text-slate-300 transition-colors hover:text-white"
          >
            Close
          </button>
        </div>
      </div>

      {/* Canvas / status */}
      <div className="relative flex-1 overflow-hidden">
        {loading && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
            <p className="text-sm text-slate-400">{loadingStep}</p>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
            <p className="text-sm font-semibold text-red-400">Failed to load volumes</p>
            <p className="max-w-md text-xs text-slate-400">{error}</p>
          </div>
        )}
        <canvas
          ref={canvasRef}
          className={`h-full w-full ${loading || error ? "invisible" : ""}`}
        />
      </div>

      {/* Footer hints */}
      {!loading && !error && (
        <div className="border-t border-white/8 px-4 py-1.5 text-[10px] text-slate-600">
          Scroll to change slice · Click to move crosshair · Drag to pan
        </div>
      )}
    </div>
  );
}
