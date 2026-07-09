import { useEffect, useRef, useState } from "react";
import type { Niivue } from "@niivue/niivue";
import { ASEG_COLOR_MAP } from "../../lib/freesurferLut";

// Niivue is a large WebGL library — dynamic import keeps it out of the main bundle
// and avoids issues in test environments that have no canvas/WebGL.
async function loadNiivue() {
  const { Niivue, cmapper } = await import("@niivue/niivue");
  return { Niivue, cmapper };
}

export interface NiivueLayer {
  url: string;
  name: string;
  /** When true, renders using the FreeSurfer aseg color LUT instead of grayscale. */
  isSegmentation?: boolean;
  /** Initial opacity (0–1). Defaults to 1.0 for the base layer, 0.7 for overlays. */
  opacity?: number;
}

interface Props {
  layers: NiivueLayer[];
  onClose: () => void;
}

// TODO: surface mesh rendering (.surf, .pial, .white) is not yet implemented.
// NiiVue supports it via nv.loadMeshes() — add it as a future enhancement once
// we have a tested FastSurfer surface output path to validate against.

export default function NiivueViewer({ layers, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nvRef = useRef<Niivue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Overlay state (layers[1..n] only; base volume has no UI controls)
  const [overlayOpacities, setOverlayOpacities] = useState<number[]>(
    () => layers.slice(1).map((l) => l.opacity ?? 0.7)
  );
  const [overlayVisible, setOverlayVisible] = useState<boolean[]>(
    () => layers.slice(1).map(() => true)
  );

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Stable dep: re-run only when the actual file URLs change, not on every render
  const layerKey = layers.map((l) => l.url).join("\0");

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    let cancelled = false;

    setLoading(true);
    setError(null);
    nvRef.current = null;

    loadNiivue()
      .then(async ({ Niivue, cmapper }) => {
        if (cancelled) return;

        const nv = new Niivue({
          backColor: [0.05, 0.05, 0.05, 1],
          show3Dcrosshair: true,
        });
        nv.attachToCanvas(canvas);

        // Build FreeSurfer LUT once for any segmentation layer
        const needsLut = layers.some((l) => l.isSegmentation);
        const fsLut = needsLut ? cmapper.makeLabelLut(ASEG_COLOR_MAP) : null;

        const volumeOptions = layers.map((layer, idx) => ({
          url: layer.url,
          opacity: idx === 0 ? (layer.opacity ?? 1.0) : (layer.opacity ?? 0.7),
          colormap: layer.isSegmentation ? "" : "gray",
          ...(layer.isSegmentation && fsLut ? { colormapLabel: fsLut } : {}),
        }));

        await nv.loadVolumes(volumeOptions);

        if (!cancelled) {
          nvRef.current = nv;
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? `Failed to load scan: ${err.message}`
              : "Failed to load scan."
          );
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerKey]);

  function handleOpacityChange(overlayIdx: number, newOpacity: number) {
    setOverlayOpacities((prev) => {
      const next = [...prev];
      next[overlayIdx] = newOpacity;
      return next;
    });
    if (overlayVisible[overlayIdx] && nvRef.current) {
      nvRef.current.setOpacity(overlayIdx + 1, newOpacity);
    }
  }

  function handleVisibilityToggle(overlayIdx: number) {
    const nowVisible = !overlayVisible[overlayIdx];
    setOverlayVisible((prev) => {
      const next = [...prev];
      next[overlayIdx] = nowVisible;
      return next;
    });
    if (nvRef.current) {
      nvRef.current.setOpacity(overlayIdx + 1, nowVisible ? overlayOpacities[overlayIdx] : 0);
    }
  }

  const overlayLayers = layers.slice(1);
  const baseLabel = layers[0]?.name ?? "Scan";

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Modal */}
      <div className="relative w-full max-w-5xl mx-4 rounded-xl overflow-hidden bg-gray-950 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-gray-900 border-b border-white/10">
          <span className="text-sm text-gray-300 font-mono truncate">{baseLabel}</span>
          <button
            onClick={onClose}
            className="ml-4 shrink-0 text-gray-400 hover:text-white text-lg leading-none focus:outline-none"
            aria-label="Close viewer"
          >
            ✕
          </button>
        </div>

        {/* Canvas area */}
        <div className="relative" style={{ height: "70vh" }}>
          {loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gray-950 z-10">
              <div className="h-6 w-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
              <span className="text-sm text-gray-400">
                {layers.length > 1 ? `Loading ${layers.length} layers…` : "Loading scan…"}
              </span>
              <span className="text-xs text-gray-400">Large files may take a moment</span>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-950 z-10">
              <div className="rounded-lg border border-red-800 bg-red-950/50 px-6 py-4 text-sm text-red-300 max-w-md text-center">
                {error}
              </div>
            </div>
          )}
          <canvas
            ref={canvasRef}
            className="w-full h-full"
            data-testid="niivue-canvas"
          />
        </div>

        {/* Overlay layer controls — only when there are overlay layers and canvas is ready */}
        {overlayLayers.length > 0 && !loading && !error && (
          <div className="bg-gray-900 border-t border-white/10 px-4 py-2 space-y-1.5">
            <p className="text-xs text-gray-500 mb-1.5">Overlay layers</p>
            {overlayLayers.map((layer, idx) => (
              <div key={layer.url} className="flex items-center gap-3">
                {/* Visibility toggle */}
                <button
                  type="button"
                  onClick={() => handleVisibilityToggle(idx)}
                  className={`shrink-0 w-5 h-5 rounded border text-xs flex items-center justify-center transition-colors focus:outline-none ${
                    overlayVisible[idx]
                      ? "border-blue-400 bg-blue-500/20 text-blue-300"
                      : "border-gray-600 bg-transparent text-gray-600"
                  }`}
                  aria-label={overlayVisible[idx] ? "Hide layer" : "Show layer"}
                  title={overlayVisible[idx] ? "Hide" : "Show"}
                >
                  {overlayVisible[idx] ? "●" : "○"}
                </button>

                {/* Layer name */}
                <span className="text-xs text-gray-300 font-mono truncate w-40" title={layer.name}>
                  {layer.name}
                </span>

                {/* Opacity slider */}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={overlayOpacities[idx]}
                  onChange={(e) => handleOpacityChange(idx, Number(e.target.value))}
                  disabled={!overlayVisible[idx]}
                  className="flex-1 accent-blue-400 disabled:opacity-30"
                  aria-label={`Opacity for ${layer.name}`}
                />

                {/* Opacity percentage */}
                <span className="text-xs text-gray-400 w-8 text-right tabular-nums">
                  {Math.round(overlayOpacities[idx] * 100)}%
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Controls hint */}
        {!loading && !error && (
          <div className="px-4 py-2 bg-gray-900 border-t border-white/10 text-xs text-gray-500 flex gap-6">
            <span>Scroll — change slice</span>
            <span>Click + drag — pan</span>
            <span>Right-click + drag — zoom</span>
            <span>Esc — close</span>
          </div>
        )}
      </div>
    </div>
  );
}
