import { useEffect, useRef, useState } from "react";

// Niivue is a large WebGL library — dynamic import keeps it out of the main bundle
// and avoids issues in test environments that have no canvas/WebGL.
async function loadNiivue() {
  const { Niivue } = await import("@niivue/niivue");
  return Niivue;
}

interface Props {
  fileUrl: string;
  fileName: string;
  onClose: () => void;
}

export default function NiivueViewer({ fileUrl, fileName, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    let cancelled = false;

    setLoading(true);
    setError(null);

    loadNiivue()
      .then(async (Niivue) => {
        if (cancelled) return;
        const nv = new Niivue({
          backColor: [0.05, 0.05, 0.05, 1],
          show3Dcrosshair: true,
        });
        nv.attachToCanvas(canvas);
        await nv.loadVolumes([{ url: fileUrl }]);
        if (!cancelled) setLoading(false);
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
  }, [fileUrl]);

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
          <span className="text-sm text-gray-300 font-mono truncate">{fileName}</span>
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
              <span className="text-sm text-gray-400">Loading scan…</span>
              <span className="text-xs text-gray-400">
                Large files may take a moment
              </span>
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
