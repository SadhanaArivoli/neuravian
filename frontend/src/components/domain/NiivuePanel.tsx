/**
 * NiivuePanel — inline (non-modal) NiiVue canvas for the Comparison Studio.
 *
 * Unlike NiivueViewer (which renders as a full-screen modal), this component
 * fills its parent container and exposes the Niivue instance via a ref so the
 * parent can call nv.broadcastTo() for linked-mode synchronisation.
 */
import { useEffect, useRef, useState } from "react";
import type { Niivue } from "@niivue/niivue";
import { ASEG_COLOR_MAP } from "../../lib/freesurferLut";
import type { NiivueLayer } from "./NiivueViewer";

export type { NiivueLayer };

async function loadNiivue() {
  const { Niivue, cmapper } = await import("@niivue/niivue");
  return { Niivue, cmapper };
}

interface Props {
  layers: NiivueLayer[];
  label: string;
  /** Called once Niivue is initialised — parent uses this to set up broadcastTo. */
  onReady?: (nv: Niivue) => void;
  /** Called when this panel's Niivue instance is torn down. */
  onUnmount?: () => void;
}

export default function NiivuePanel({ layers, label, onReady, onUnmount }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nvRef = useRef<Niivue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

        const needsLut = layers.some((l) => l.isSegmentation);
        const fsLut = needsLut ? cmapper.makeLabelLut(ASEG_COLOR_MAP) : null;

        const volumeOptions = layers.map((layer, idx) => ({
          url: layer.url,
          opacity: idx === 0 ? (layer.opacity ?? 1.0) : (layer.opacity ?? 0.7),
          colormap: layer.isSegmentation ? "" : (layer.colormap ?? "gray"),
          ...(layer.isSegmentation && fsLut ? { colormapLabel: fsLut } : {}),
        }));

        await nv.loadVolumes(volumeOptions);

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
  }, [layerKey]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Panel label */}
      <div className="shrink-0 flex items-center justify-between px-3 py-1.5 bg-gray-900 border-b border-white/10">
        <span className="text-xs text-gray-300 font-mono truncate">{label}</span>
        {loading && (
          <div className="h-3.5 w-3.5 rounded-full border-2 border-blue-500 border-t-transparent animate-spin shrink-0 ml-2" />
        )}
      </div>

      {/* Canvas area */}
      <div className="relative flex-1 min-h-0">
        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gray-950 z-10">
            <div className="h-5 w-5 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
            <span className="text-xs text-gray-400">Loading…</span>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-950 z-10 p-4">
            <div className="rounded border border-red-800 bg-red-950/50 px-4 py-3 text-xs text-red-300 text-center max-w-xs">
              {error}
            </div>
          </div>
        )}
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>

      {/* Scroll hint */}
      {!loading && !error && (
        <div className="shrink-0 px-3 py-1 bg-gray-900 border-t border-white/10 text-[10px] text-gray-600">
          Scroll — slice · Drag — pan · Right-drag — zoom
        </div>
      )}
    </div>
  );
}
