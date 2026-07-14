/**
 * NiivuePanel — inline (non-modal) NiiVue canvas.
 *
 * Used by Comparison Studio, RunResults, and any page that embeds a viewer
 * inside a fixed-height container.  Exposes the Niivue instance via onReady
 * so parents can set up broadcastTo() linked-mode synchronisation.
 *
 * Visualization defaults are pulled from niivueTheme.ts so every viewer in
 * NeuroForge is consistent with publication-quality settings.
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
import type { NiivueLayer } from "./NiivueViewer";

export type { NiivueLayer };

async function loadNiivue() {
  const { Niivue, cmapper } = await import("@niivue/niivue");
  return { Niivue, cmapper };
}

interface Props {
  layers: NiivueLayer[];
  label: string;
  /**
   * Semantic map type — drives the default colormap and colorbar unit label.
   * Only applies to the first overlay layer (layers[1]).  Layers that already
   * have an explicit `colormap` field take precedence.
   */
  mapType?: StatMapType;
  /**
   * When true the viewer switches to three-plane (sagittal + coronal + axial)
   * mosaic layout.  Defaults to true for stat maps, false for pure anatomy.
   */
  multiplanar?: boolean;
  /**
   * Show the NiiVue internal color scale bar.  Defaults to true.
   */
  showColorbar?: boolean;
  /**
   * Publication mode: hides the scroll-hint footer and uses a cleaner label.
   */
  pubMode?: boolean;
  /** Called once Niivue is initialised — parent uses this to set up broadcastTo. */
  onReady?: (nv: Niivue) => void;
  /** Called when this panel's Niivue instance is torn down. */
  onUnmount?: () => void;
}

export default function NiivuePanel({
  layers,
  label,
  mapType,
  multiplanar = true,
  showColorbar = true,
  pubMode = false,
  onReady,
  onUnmount,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nvRef = useRef<Niivue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPubMode, setIsPubMode] = useState(pubMode);

  const layerKey = layers.map((l) => l.url).join("\0");

  // Apply publication-mode crosshair toggle without reloading volumes
  useEffect(() => {
    const nv = nvRef.current;
    if (!nv) return;
    nv.opts.crosshairWidth = isPubMode ? 0 : NIIVUE_MULTIPLANAR_OPTIONS.crosshairWidth;
    nv.drawScene?.();
  }, [isPubMode]);

  const handleExport = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `${label.replace(/[^a-zA-Z0-9_-]/g, "_")}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  }, [label]);

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
          isColorbar: showColorbar,
          crosshairWidth: isPubMode ? 0 : NIIVUE_MULTIPLANAR_OPTIONS.crosshairWidth,
        });
        nv.attachToCanvas(canvas);

        // FreeSurfer LUT for segmentation layers
        const needsLut = layers.some((l) => l.isSegmentation);
        const fsLut = needsLut ? cmapper.makeLabelLut(ASEG_COLOR_MAP) : null;

        // Resolve per-layer colormap: explicit prop wins, else mapType-derived, else gray.
        // For stat-map types (alff, reho, etc.) the base layer IS the map — use the
        // mapType colormap there too, not gray.
        const resolvedMapColormap = mapType ? STAT_MAP_COLORMAP[mapType] : "gray";
        const baseColormap =
          mapType && mapType !== "anatomical" && mapType !== "default" && mapType !== "segmentation"
            ? resolvedMapColormap
            : "gray";

        const volumeOptions = layers.map((layer, idx) => ({
          url: layer.url,
          opacity:
            idx === 0 ? (layer.opacity ?? 1.0) : (layer.opacity ?? OVERLAY_LAYER_OPACITY),
          colormap: layer.isSegmentation
            ? ""
            : (layer.colormap ?? (idx === 0 ? baseColormap : resolvedMapColormap)),
          ...(layer.isSegmentation && fsLut ? { colormapLabel: fsLut } : {}),
        }));

        await nv.loadVolumes(volumeOptions);

        // Switch to three-plane mosaic after volumes are loaded
        if (multiplanar) {
          nv.setSliceType(SLICE_TYPE_MULTIPLANAR);
        }

        if (!cancelled) {
          nvRef.current = nv;
          setLoading(false);
          onReady?.(nv);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? `Failed to load: ${err.message}` : "Failed to load scan."
          );
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      onUnmount?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerKey, multiplanar, showColorbar]);

  const unitLabel = mapType ? STAT_MAP_UNIT[mapType] : "";

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#111] rounded overflow-hidden">
      {/* Panel header */}
      <div className="shrink-0 flex items-center justify-between px-3 py-1.5 bg-[#0d0d0d] border-b border-white/8">
        <span className="text-[11px] text-gray-300 font-mono truncate tracking-wide">
          {label}
          {unitLabel && (
            <span className="ml-2 text-gray-500 font-sans">[{unitLabel}]</span>
          )}
        </span>

        <div className="flex items-center gap-2 shrink-0 ml-2">
          {loading && (
            <div className="h-3 w-3 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
          )}
          {!loading && !error && (
            <>
              {/* Publication mode toggle */}
              <button
                type="button"
                onClick={() => setIsPubMode((v) => !v)}
                title={isPubMode ? "Exit publication mode" : "Publication mode"}
                className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                  isPubMode
                    ? "border-indigo-400/60 bg-indigo-500/15 text-indigo-300"
                    : "border-white/10 text-gray-500 hover:text-gray-300"
                }`}
              >
                PUB
              </button>
              {/* PNG export */}
              <button
                type="button"
                onClick={handleExport}
                title="Export PNG"
                className="text-[10px] px-1.5 py-0.5 rounded border border-white/10 text-gray-500 hover:text-gray-300 transition-colors"
              >
                ↓PNG
              </button>
            </>
          )}
        </div>
      </div>

      {/* Canvas */}
      <div className="relative flex-1 min-h-0">
        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#0d0d0d] z-10">
            <div className="h-5 w-5 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
            <span className="text-xs text-gray-400">Loading…</span>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0d0d0d] z-10 p-4">
            <div className="rounded border border-red-800/60 bg-red-950/40 px-4 py-3 text-xs text-red-300 text-center max-w-xs">
              {error}
            </div>
          </div>
        )}
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>

      {/* Footer: scroll hint (hidden in pub mode) */}
      {!loading && !error && !isPubMode && (
        <div className="shrink-0 px-3 py-1 bg-[#0d0d0d] border-t border-white/8 text-[9px] text-gray-600 flex gap-4">
          <span>Scroll — slice</span>
          <span>Drag — pan</span>
          <span>Right-drag — zoom</span>
        </div>
      )}
    </div>
  );
}
