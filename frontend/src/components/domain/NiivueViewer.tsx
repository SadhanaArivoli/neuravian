/**
 * NiivueViewer — full-screen modal NiiVue viewer with overlay controls.
 *
 * Visualization defaults are pulled from niivueTheme.ts.
 * Supports publication mode (clean export-ready appearance), PNG export,
 * multiplanar mosaic layout, and per-overlay opacity/visibility controls.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Niivue } from "@niivue/niivue";
import { ASEG_COLOR_MAP } from "../../lib/freesurferLut";
import {
  NIIVUE_MULTIPLANAR_OPTIONS,
  OVERLAY_LAYER_OPACITY,
  SLICE_TYPE_MULTIPLANAR,
  STAT_MAP_COLORMAP,
  STAT_MAP_UNIT,
  type StatMapType,
} from "../../lib/niivueTheme";

// Niivue is a large WebGL library — dynamic import keeps it out of the main bundle
// and avoids issues in test environments that have no canvas/WebGL.
async function loadNiivue() {
  const { Niivue, cmapper } = await import("@niivue/niivue");
  return { Niivue, cmapper };
}

export interface NiivueLayer {
  url: string;
  name: string;
  /** When true, renders using the FreeSurfer aseg color LUT (label overlay). */
  isSegmentation?: boolean;
  /** NiiVue built-in colormap name for non-segmentation overlays (e.g. "hot", "green").
   *  Ignored when isSegmentation is true. Defaults to "gray" for the base layer. */
  colormap?: string;
  /** Initial opacity (0–1). Defaults to 1.0 for the base layer, 0.7 for overlays. */
  opacity?: number;
}

interface Props {
  layers: NiivueLayer[];
  /** Semantic type of the primary stat-map — drives default colormap and unit. */
  mapType?: StatMapType;
  /** Use three-plane mosaic layout (sagittal + coronal + axial). Default: true. */
  multiplanar?: boolean;
  onClose: () => void;
}

export default function NiivueViewer({
  layers,
  mapType,
  multiplanar = true,
  onClose,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nvRef = useRef<Niivue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPubMode, setIsPubMode] = useState(false);

  // Overlay state (layers[1..n] only; base volume has no UI controls)
  const [overlayOpacities, setOverlayOpacities] = useState<number[]>(
    () => layers.slice(1).map((l) => l.opacity ?? OVERLAY_LAYER_OPACITY)
  );
  const [overlayVisible, setOverlayVisible] = useState<boolean[]>(
    () => layers.slice(1).map(() => true)
  );

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Apply publication-mode crosshair toggle without reloading volumes
  useEffect(() => {
    const nv = nvRef.current;
    if (!nv) return;
    nv.opts.crosshairWidth = isPubMode ? 0 : NIIVUE_MULTIPLANAR_OPTIONS.crosshairWidth;
    nv.drawScene?.();
  }, [isPubMode]);

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
          ...NIIVUE_MULTIPLANAR_OPTIONS,
          isColorbar: true,
        });
        nv.attachToCanvas(canvas);

        // Build FreeSurfer LUT once for any segmentation layer
        const needsLut = layers.some((l) => l.isSegmentation);
        const fsLut = needsLut ? cmapper.makeLabelLut(ASEG_COLOR_MAP) : null;

        // Resolved colormap for overlay layers that don't specify one explicitly.
        // For stat-map types the base layer IS the map — apply mapType colormap there too.
        const resolvedMapColormap = mapType ? STAT_MAP_COLORMAP[mapType] : "warm";
        const baseColormap =
          mapType && mapType !== "anatomical" && mapType !== "default" && mapType !== "segmentation"
            ? resolvedMapColormap
            : "gray";

        const isStatMapType =
          !!mapType && mapType !== "anatomical" && mapType !== "default" && mapType !== "segmentation";

        const volumeOptions = layers.map((layer, idx) => ({
          url: layer.url,
          opacity: idx === 0 ? (layer.opacity ?? 1.0) : (layer.opacity ?? OVERLAY_LAYER_OPACITY),
          colormap: layer.isSegmentation
            ? ""
            : (layer.colormap ?? (idx === 0 ? baseColormap : resolvedMapColormap)),
          ...(layer.isSegmentation && fsLut ? { colormapLabel: fsLut } : {}),
          // For stat maps, honour the header's cal_min/cal_max (backend writes cal_min=0
          // so that background zeros map to the colormap minimum, not the maximum).
          ...(isStatMapType && idx === 0 ? { trustCalMinMax: true } : {}),
        }));

        await nv.loadVolumes(volumeOptions);

        // Override cal_min=0 for stat maps so background zeros map to the
        // colormap minimum (dark) instead of wrapping to the maximum (yellow).
        if (isStatMapType && nv.volumes.length > 0) {
          nv.volumes[0].cal_min = 0;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (nv as any).updateGLVolume?.(nv.volumes[0]);
        }

        if (multiplanar) {
          nv.setSliceType(SLICE_TYPE_MULTIPLANAR);
        }

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

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerKey, multiplanar]);

  function handleOpacityChange(overlayIdx: number, newOpacity: number) {
    setOverlayOpacities((prev) => {
      const next = [...prev]; next[overlayIdx] = newOpacity; return next;
    });
    if (overlayVisible[overlayIdx] && nvRef.current) {
      nvRef.current.setOpacity(overlayIdx + 1, newOpacity);
    }
  }

  function handleVisibilityToggle(overlayIdx: number) {
    const nowVisible = !overlayVisible[overlayIdx];
    setOverlayVisible((prev) => {
      const next = [...prev]; next[overlayIdx] = nowVisible; return next;
    });
    if (nvRef.current) {
      nvRef.current.setOpacity(overlayIdx + 1, nowVisible ? overlayOpacities[overlayIdx] : 0);
    }
  }

  const handleExport = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const baseName = layers[0]?.name ?? "niivue";
    const link = document.createElement("a");
    link.download = `${baseName.replace(/[^a-zA-Z0-9_-]/g, "_")}_${isPubMode ? "pub" : "view"}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  }, [layers, isPubMode]);

  const overlayLayers = layers.slice(1);
  const baseLabel = layers[0]?.name ?? "Scan";
  const unitLabel = mapType ? STAT_MAP_UNIT[mapType] : "";

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Modal */}
      <div className="relative w-full max-w-5xl mx-4 rounded-xl overflow-hidden bg-[#0d0d0d] shadow-2xl flex flex-col border border-white/8">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#111] border-b border-white/8">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-[11px] text-gray-200 font-mono truncate tracking-wide">
              {baseLabel}
            </span>
            {unitLabel && (
              <span className="text-[10px] text-gray-500 shrink-0">[{unitLabel}]</span>
            )}
            {mapType && mapType !== "default" && mapType !== "anatomical" && (
              <span className="text-[10px] rounded-full px-2 py-0.5 bg-white/6 text-gray-400 shrink-0 border border-white/10">
                {mapType.replace(/_/g, " ")}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0 ml-4">
            {/* Publication mode toggle */}
            <button
              type="button"
              onClick={() => setIsPubMode((v) => !v)}
              title={isPubMode ? "Exit publication mode" : "Publication mode — clean export view"}
              className={`text-[10px] px-2 py-1 rounded border transition-colors font-medium ${
                isPubMode
                  ? "border-indigo-400/60 bg-indigo-500/15 text-indigo-300"
                  : "border-white/12 text-gray-500 hover:text-gray-300 hover:border-white/20"
              }`}
            >
              {isPubMode ? "📐 PUB" : "PUB"}
            </button>
            {/* Export */}
            {!loading && !error && (
              <button
                type="button"
                onClick={handleExport}
                title="Export PNG"
                className="text-[10px] px-2 py-1 rounded border border-white/12 text-gray-500 hover:text-gray-300 hover:border-white/20 transition-colors"
              >
                ↓ PNG
              </button>
            )}
            {/* Close */}
            <button
              onClick={onClose}
              className="ml-1 text-gray-500 hover:text-white text-lg leading-none focus:outline-none transition-colors"
              aria-label="Close viewer"
            >
              ✕
            </button>
          </div>
        </div>

        {/* ── Canvas ──────────────────────────────────────────────────────── */}
        <div className="relative" style={{ height: "68vh" }}>
          {loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0d0d0d] z-10">
              <div className="h-6 w-6 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
              <span className="text-sm text-gray-400">
                {layers.length > 1 ? `Loading ${layers.length} layers…` : "Loading scan…"}
              </span>
              <span className="text-xs text-gray-600">Large files may take a moment</span>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#0d0d0d] z-10">
              <div className="rounded-lg border border-red-800/60 bg-red-950/40 px-6 py-4 text-sm text-red-300 max-w-md text-center">
                {error}
              </div>
            </div>
          )}
          <canvas ref={canvasRef} className="w-full h-full" data-testid="niivue-canvas" />
        </div>

        {/* ── Overlay layer controls ───────────────────────────────────────── */}
        {overlayLayers.length > 0 && !loading && !error && !isPubMode && (
          <div className="bg-[#111] border-t border-white/8 px-4 py-2.5 space-y-2">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5">Overlay layers</p>
            {overlayLayers.map((layer, idx) => (
              <div key={layer.url} className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => handleVisibilityToggle(idx)}
                  className={`shrink-0 w-4 h-4 rounded border text-[9px] flex items-center justify-center transition-colors focus:outline-none ${
                    overlayVisible[idx]
                      ? "border-blue-400/60 bg-blue-500/15 text-blue-300"
                      : "border-white/12 bg-transparent text-gray-600"
                  }`}
                  aria-label={overlayVisible[idx] ? "Hide layer" : "Show layer"}
                >
                  {overlayVisible[idx] ? "●" : "○"}
                </button>
                <span className="text-[11px] text-gray-300 font-mono truncate w-44" title={layer.name}>
                  {layer.name}
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={overlayOpacities[idx]}
                  onChange={(e) => handleOpacityChange(idx, Number(e.target.value))}
                  disabled={!overlayVisible[idx]}
                  className="flex-1 accent-blue-400 disabled:opacity-25 h-1"
                  aria-label={`Opacity for ${layer.name}`}
                />
                <span className="text-[10px] text-gray-500 w-7 text-right tabular-nums">
                  {Math.round(overlayOpacities[idx] * 100)}%
                </span>
              </div>
            ))}
          </div>
        )}

        {/* ── Footer: controls hint (hidden in pub mode) ───────────────────── */}
        {!loading && !error && !isPubMode && (
          <div className="px-4 py-2 bg-[#111] border-t border-white/8 text-[9px] text-gray-600 flex gap-6">
            <span>Scroll — change slice</span>
            <span>Drag — pan</span>
            <span>Right-drag — zoom</span>
            <span>Esc — close</span>
          </div>
        )}
      </div>
    </div>
  );
}
