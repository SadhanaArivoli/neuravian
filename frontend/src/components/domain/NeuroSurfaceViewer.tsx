import { useEffect, useRef, useState } from "react";
import type { Niivue } from "@niivue/niivue";
import { fetchRunScopedSurface, validateFreeSurferSurface } from "../../lib/freesurferSurface";

export interface SurfaceLayer {
  url: string;
  name: string;
  hemisphere?: "left" | "right" | null;
  opacity?: number;
}

interface Props {
  surface: SurfaceLayer;
  onClose: () => void;
  onUnmount?: () => void;
}

const VIEWS = {
  lateral: [90, 0],
  medial: [-90, 0],
  dorsal: [0, 90],
  ventral: [0, -90],
} as const;

export default function NeuroSurfaceViewer({ surface, onClose, onUnmount }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nvRef = useRef<Niivue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opacity, setOpacity] = useState(surface.opacity ?? 1);
  const [visible, setVisible] = useState(true);
  const [shader, setShader] = useState("Phong");
  const [shaderNames, setShaderNames] = useState<string[]>([]);
  const [meshInfo, setMeshInfo] = useState({ vertices: 0, faces: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = new AbortController();
    let cancelled = false;
    let mounted: Niivue | null = null;
    setLoading(true);
    setError(null);
    import("@niivue/niivue").then(async ({ Niivue }) => {
      const buffer = await fetchRunScopedSurface(surface.url, controller.signal);
      const header = validateFreeSurferSurface(buffer);
      if (cancelled) return;
      const nv = new Niivue({ backColor: [0.04, 0.05, 0.08, 1], show3Dcrosshair: false });
      mounted = nv;
      nv.attachToCanvas(canvas);
      await nv.loadMeshes([{ url: surface.url, name: surface.name, buffer, opacity: surface.opacity ?? 1, rgba255: [205, 198, 240, 255] }]);
      if (cancelled) return;
      nv.setRenderAzimuthElevation(surface.hemisphere === "right" ? -90 : 90, 0);
      const names = nv.meshShaderNames(true);
      setShaderNames(names);
      setShader(names.includes("Phong") ? "Phong" : names[0] ?? "");
      setMeshInfo({ vertices: header.vertexCount, faces: header.faceCount });
      nvRef.current = nv;
      setLoading(false);
    }).catch((caught: unknown) => {
      if (cancelled) return;
      setError(caught instanceof Error ? caught.message : "Surface loading failed.");
      setLoading(false);
    });
    return () => {
      cancelled = true;
      controller.abort();
      nvRef.current = null;
      mounted?.cleanup?.();
      onUnmount?.();
    };
  }, [onUnmount, surface.hemisphere, surface.name, surface.opacity, surface.url]);

  function meshProperty(key: "opacity" | "visible", value: number | boolean) {
    const nv = nvRef.current;
    const mesh = nv?.meshes[0];
    if (!nv || !mesh) return;
    nv.setMeshProperty(mesh.id as unknown as number, key, value);
    nv.drawScene();
  }

  function setView(name: keyof typeof VIEWS) {
    const [azimuth, elevation] = VIEWS[name];
    nvRef.current?.setRenderAzimuthElevation(azimuth, elevation);
  }

  function reset() {
    const azimuth = surface.hemisphere === "right" ? -90 : 90;
    setOpacity(1); setVisible(true);
    meshProperty("opacity", 1); meshProperty("visible", true);
    nvRef.current?.setRenderAzimuthElevation(azimuth, 0);
  }

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="mx-4 flex h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-white/10 bg-[#0d0d0d] shadow-2xl" data-testid="shared-surface-viewer"><header className="flex items-center justify-between border-b border-white/10 px-4 py-2"><div><div className="text-xs font-medium text-slate-100">Surface inspection</div><div className="font-mono text-[10px] text-slate-500">{surface.name}{surface.hemisphere ? ` · ${surface.hemisphere} hemisphere` : ""}</div></div><button type="button" aria-label="Close surface viewer" onClick={onClose} className="rounded px-2 py-1 text-slate-400 hover:bg-white/5 hover:text-white">Close</button></header><div className="flex min-h-0 flex-1 flex-col lg:flex-row"><aside className="w-full shrink-0 space-y-4 border-b border-white/10 p-4 text-xs text-slate-300 lg:w-64 lg:border-b-0 lg:border-r"><section><h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Preset view</h3><div className="grid grid-cols-2 gap-1">{(Object.keys(VIEWS) as Array<keyof typeof VIEWS>).map((name) => <button key={name} type="button" onClick={() => setView(name)} className="rounded bg-white/5 px-2 py-1.5 capitalize hover:bg-violet-500/15">{name}</button>)}</div></section><section className="space-y-2"><label className="block">Opacity <span className="float-right">{Math.round(opacity * 100)}%</span><input aria-label="Surface opacity" type="range" min="0" max="1" step="0.01" value={opacity} onChange={(event) => { const value = Number(event.target.value); setOpacity(value); meshProperty("opacity", value); }} className="mt-1 w-full accent-violet-400" /></label><label className="flex items-center gap-2"><input aria-label="Show surface" type="checkbox" checked={visible} onChange={(event) => { setVisible(event.target.checked); meshProperty("visible", event.target.checked); }} /> Show surface</label><label className="block">Lighting<select aria-label="Surface lighting" value={shader} onChange={(event) => { setShader(event.target.value); const nv = nvRef.current; const mesh = nv?.meshes[0]; if (nv && mesh) nv.setMeshShader(mesh.id, event.target.value); }} className="mt-1 w-full rounded border border-white/10 bg-slate-900 px-2 py-1.5">{shaderNames.map((name) => <option key={name}>{name}</option>)}</select></label></section><section className="rounded border border-white/8 bg-white/[0.025] p-2 font-mono text-[10px] text-slate-500"><div>{meshInfo.vertices.toLocaleString()} vertices</div><div>{meshInfo.faces.toLocaleString()} faces</div><div>Scanner RAS geometry</div></section><button type="button" onClick={reset} className="rounded border border-white/10 px-2 py-1.5 text-slate-200">Reset surface</button><p className="text-[9px] leading-relaxed text-slate-600">Drag to rotate · Shift-drag to pan · Scroll to zoom. Interactive inspection only; no geometry is modified.</p></aside><div className="relative min-h-[300px] flex-1">{loading && <div className="absolute inset-0 z-10 grid place-items-center bg-[#0d0d0d] text-xs text-slate-400">Loading surface…</div>}{error && <div className="absolute inset-0 z-10 grid place-items-center bg-[#0d0d0d] p-6 text-center text-xs text-red-300">{error}</div>}<canvas ref={canvasRef} className="h-full w-full" data-testid="surface-canvas" /></div></div></div></div>;
}
