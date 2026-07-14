import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Niivue } from "@niivue/niivue";
import { ASEG_COLOR_MAP } from "../../lib/freesurferLut";
import {
  NIIVUE_MULTIPLANAR_OPTIONS,
  SLICE_TYPE_MULTIPLANAR,
  STAT_MAP_COLORMAP,
  STAT_MAP_UNIT,
  type StatMapType,
} from "../../lib/niivueTheme";
import {
  computeDisplayStatistics,
  selectDisplayProfile,
  type DisplayProfile,
} from "../../lib/scientificDisplayProfiles";
import { checkVolumeCompatibility, volumeGeometry } from "../../lib/volumeCompatibility";

export interface NiivueLayer {
  url: string;
  name: string;
  isSegmentation?: boolean;
  colormap?: string;
  opacity?: number;
  artifactType?: string;
  pipelineId?: string;
  metadata?: Record<string, unknown>;
}

export interface NeuroImageViewerProps {
  layers: NiivueLayer[];
  label: string;
  mapType?: StatMapType;
  multiplanar?: boolean;
  showColorbar?: boolean;
  pubMode?: boolean;
  modal?: boolean;
  onClose?: () => void;
  onReady?: (nv: Niivue) => void;
  onUnmount?: () => void;
}

type WindowMode = "auto" | "robust" | "manual";
type BackgroundMode = "dark" | "light";
type NumericArray = ArrayLike<number | bigint>;

interface HistogramData {
  bins: number[];
  dataMin: number;
  dataMax: number;
  p2: number;
  p98: number;
  mean: number;
  median: number;
}

interface LayerViewState extends HistogramData {
  colormap: string;
  opacity: number;
  windowMode: WindowMode;
  windowMin: number;
  windowMax: number;
  brightness: number;
  contrast: number;
  gamma: number;
  inverted: boolean;
  symmetric: boolean;
  visible: boolean;
}

type InterpolationMode = "auto" | "smooth" | "nearest";
type ViewLayout = "axial" | "coronal" | "sagittal" | "multiplanar" | "four-pane" | "render";

interface ViewerLocation {
  mm?: number[];
  vox?: number[];
  values?: number[];
}

type VolumeOption = Parameters<Niivue["loadVolumes"]>[0][number];

function refreshVolume(nv: Niivue, volume: Niivue["volumes"][number]) {
  (nv as unknown as { updateGLVolume?: (target?: typeof volume) => void }).updateGLVolume?.(volume);
}

export const VIEWER_COLORMAPS = [
  ["gray", "Grayscale"],
  ["inferno", "Inferno"],
  ["magma", "Magma"],
  ["plasma", "Plasma"],
  ["viridis", "Viridis"],
  ["cividis", "Cividis"],
  ["hot", "Hot"],
  ["cool", "Cool"],
  ["turbo", "Turbo"],
  ["redyell", "Red-yellow"],
  ["blue2red", "Blue-red (diverging)"],
] as const;

const HISTOGRAM_BINS = 64;
const MAX_HISTOGRAM_SAMPLES = 250_000;
const DEFAULT_CROSSHAIR_WIDTH = NIIVUE_MULTIPLANAR_OPTIONS.crosshairWidth;
const DARK_BACKGROUND = [0.07, 0.07, 0.07, 1] as [number, number, number, number];
const LIGHT_BACKGROUND = [0.96, 0.97, 0.98, 1] as [number, number, number, number];

async function loadNiivue() {
  const { Niivue, cmapper } = await import("@niivue/niivue");
  return { Niivue, cmapper };
}

function isStatMap(mapType?: StatMapType) {
  return !!mapType && !["anatomical", "default", "segmentation"].includes(mapType);
}

export function inferMapType(layer?: NiivueLayer): StatMapType | undefined {
  if (!layer) return undefined;
  if (layer.isSegmentation) return "segmentation";
  const identity = `${layer.name} ${layer.url}`.toLowerCase();
  if (/(^|[_/.-])(dseg|aseg|aparc|parc|atlas|segmentation|labels?)([_/.-]|$)/.test(identity)) return "segmentation";
  if (/(seed.*connect|connect.*map|difference|diff_map|z[-_]?map|zstat|t[-_]?map|tstat|reho[_-]?z|thresholded)/.test(identity)) return "z_map";
  if (/falff/.test(identity)) return "falff";
  if (/(^|[_/.-])alff([_/.-]|$)/.test(identity)) return "alff";
  if (/reho/.test(identity)) return "reho";
  if (/(^|[_/.-])mask([_/.-]|$)/.test(identity)) return "mask";
  if (/(t1w|t2w|anatom|structural|orig\.mgz)/.test(identity)) return "anatomical";
  return undefined;
}

function isLabelProfile(profile: DisplayProfile) {
  return profile.id === "label-atlas" || profile.id === "binary-mask";
}

export function defaultColormap(
  layer: NiivueLayer,
  index: number,
  mapType?: StatMapType,
) {
  if (layer.isSegmentation || mapType === "segmentation" || mapType === "mask") return "roi_i256";
  if (layer.colormap) return layer.colormap;
  if (index === 0 && !isStatMap(mapType)) return "gray";
  return mapType ? STAT_MAP_COLORMAP[mapType] : index === 0 ? "gray" : "inferno";
}

function applyVolumeDisplay(
  nv: Niivue,
  volume: Niivue["volumes"][number],
  profile: DisplayProfile,
  colormap: string,
  min: number,
  max: number,
) {
  if (profile.signed && colormap === "blue2red") {
    // NiiVue's paired positive/negative LUTs keep exact zero transparent while
    // preserving a perceptually neutral center over a black or anatomical base.
    nv.setColormap(volume.id, "red");
    nv.setColormapNegative(volume.id, "blue");
    volume.cal_min = 0;
    volume.cal_max = Math.max(Number.EPSILON, max);
    volume.cal_minNeg = Math.min(-Number.EPSILON, min);
    volume.cal_maxNeg = 0;
    volume.colormapType = 1;
  } else {
    nv.setColormap(volume.id, colormap);
    nv.setColormapNegative(volume.id, "");
    volume.cal_min = min;
    volume.cal_max = max;
    volume.cal_minNeg = Number.NaN;
    volume.cal_maxNeg = Number.NaN;
    volume.colormapType = profile.zeroBackground === "transparent" ? 1 : 0;
  }
  refreshVolume(nv, volume);
}

function finiteSamples(image: NumericArray | null | undefined) {
  if (!image?.length) return [];
  const step = Math.max(1, Math.ceil(image.length / MAX_HISTOGRAM_SAMPLES));
  const values: number[] = [];
  for (let index = 0; index < image.length; index += step) {
    const value = Number(image[index]);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

function percentile(sorted: number[], fraction: number) {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function calculateHistogram(
  values: number[],
  windowMin?: number,
  windowMax?: number,
): HistogramData {
  if (!values.length) {
    return { bins: Array(HISTOGRAM_BINS).fill(0), dataMin: 0, dataMax: 1, p2: 0, p98: 1, mean: 0, median: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const dataMin = sorted[0];
  const dataMax = sorted[sorted.length - 1];
  const p2 = percentile(sorted, 0.02);
  const p98 = percentile(sorted, 0.98);
  const low = windowMin ?? dataMin;
  const high = windowMax ?? dataMax;
  const span = Math.max(Number.EPSILON, high - low);
  const bins = Array(HISTOGRAM_BINS).fill(0) as number[];
  for (const value of values) {
    if (value < low || value > high) continue;
    const index = Math.min(HISTOGRAM_BINS - 1, Math.max(0, Math.floor(((value - low) / span) * HISTOGRAM_BINS)));
    bins[index] += 1;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { bins, dataMin, dataMax, p2, p98, mean, median: percentile(sorted, 0.5) };
}

function hexToRgba(hex: string) {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255,
    1,
  ] as [number, number, number, number];
}

function downloadBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(href);
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed."))), "image/png");
  });
}

async function publicationBlob(
  renderedCanvas: HTMLCanvasElement,
  title: string,
  colorScaleLabel: string,
  location: ViewerLocation,
) {
  const output = document.createElement("canvas");
  output.width = renderedCanvas.width;
  output.height = renderedCanvas.height;
  const context = output.getContext("2d");
  if (!context) return canvasBlob(renderedCanvas);
  // The pixels originate from the dedicated high-resolution WebGL rerender,
  // never from the visible viewer canvas. This pass adds vector-resolution
  // publication labels to that newly rendered image.
  context.drawImage(renderedCanvas, 0, 0);
  const fontSize = Math.max(18, Math.round(output.width / 70));
  const margin = fontSize;
  context.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  context.fillStyle = "rgba(255,255,255,0.96)";
  context.shadowColor = "rgba(0,0,0,0.9)";
  context.shadowBlur = Math.max(2, fontSize / 5);
  context.fillText(title, margin, margin + fontSize);
  context.font = `500 ${Math.round(fontSize * 0.72)}px ui-monospace, SFMono-Regular, monospace`;
  const mm = location.mm?.slice(0, 3).map((value) => Number(value).toFixed(1)).join(", ");
  if (mm) context.fillText(`MNI/world mm: ${mm}`, margin, output.height - margin);
  if (colorScaleLabel) {
    const width = context.measureText(colorScaleLabel).width;
    context.fillText(colorScaleLabel, output.width - margin - width, margin + fontSize);
  }
  return canvasBlob(output);
}

function orderUnderlayFirst(input: NiivueLayer[]) {
  return input.slice(0, 4).sort((a, b) => {
    const profileA = selectDisplayProfile({ artifactType: a.artifactType, name: a.name, url: a.url, metadata: a.metadata });
    const profileB = selectDisplayProfile({ artifactType: b.artifactType, name: b.name, url: b.url, metadata: b.metadata });
    return Number(profileB.id === "structural") - Number(profileA.id === "structural");
  });
}

export default function NeuroImageViewer({
  layers: requestedLayers,
  label,
  mapType,
  multiplanar = true,
  showColorbar = true,
  pubMode = false,
  modal = false,
  onClose,
  onReady,
  onUnmount,
}: NeuroImageViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const nvRef = useRef<Niivue | null>(null);
  const volumeOptionsRef = useRef<VolumeOption[]>([]);
  const samplesRef = useRef<number[][]>([]);
  const requestedLayerKey = useMemo(() => requestedLayers.map((layer) => layer.url).join("\0"), [requestedLayers]);
  const syncedLayerKeyRef = useRef(requestedLayerKey);
  const [layers, setLayers] = useState(() => orderUnderlayFirst(requestedLayers));
  const effectiveMapType = mapType ?? inferMapType(layers[0]);
  const profiles = useMemo(() => layers.map((layer, index) => selectDisplayProfile({
    artifactType: layer.artifactType,
    pipelineId: layer.pipelineId,
    semanticType: index === 0 ? effectiveMapType : inferMapType(layer),
    name: layer.name,
    url: layer.url,
    metadata: layer.metadata,
  })), [effectiveMapType, layers]);
  const hasLabelLayer = profiles.some(isLabelProfile);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [histogramOpen, setHistogramOpen] = useState(true);
  const [activeLayer, setActiveLayer] = useState(0);
  const [layerStates, setLayerStates] = useState<LayerViewState[]>([]);
  const [nearest, setNearest] = useState(() => hasLabelLayer);
  const [interpolationMode, setInterpolationMode] = useState<InterpolationMode>("auto");
  const [crosshairVisible, setCrosshairVisible] = useState(!pubMode);
  const [crosshairWidth, setCrosshairWidth] = useState(Number(DEFAULT_CROSSHAIR_WIDTH));
  const [crosshairColor, setCrosshairColor] = useState("#38bdf8");
  const [background, setBackground] = useState<BackgroundMode>("dark");
  const [transparentExport, setTransparentExport] = useState(false);
  const [exportScale, setExportScale] = useState<2 | 4>(2);
  const [isPubMode, setIsPubMode] = useState(pubMode);
  const [showColorbarState, setShowColorbarState] = useState(showColorbar);
  const [showOrientation, setShowOrientation] = useState(true);
  const [radiological, setRadiological] = useState(false);
  const [viewLayout, setViewLayout] = useState<ViewLayout>(multiplanar ? "multiplanar" : "axial");
  const [location, setLocation] = useState<ViewerLocation>({});
  const [jumpMm, setJumpMm] = useState<[number, number, number]>([0, 0, 0]);
  const [underlayStatus, setUnderlayStatus] = useState("");
  const [hasCompatibleUnderlay, setHasCompatibleUnderlay] = useState(false);

  useEffect(() => {
    if (syncedLayerKeyRef.current === requestedLayerKey) return;
    syncedLayerKeyRef.current = requestedLayerKey;
    setLayers(orderUnderlayFirst(requestedLayers));
    setActiveLayer(0);
  }, [requestedLayerKey]);

  const layerKey = useMemo(() => layers.map((layer) => layer.url).join("\0"), [layers]);
  const current = layerStates[activeLayer];
  const unitLabel = profiles[activeLayer]?.colorbarLabel
    ?? (effectiveMapType ? STAT_MAP_UNIT[effectiveMapType] : "");

  const applyWindow = useCallback((index: number, min: number, max: number) => {
    const nv = nvRef.current;
    const volume = nv?.volumes[index];
    if (!nv || !volume || !Number.isFinite(min) || !Number.isFinite(max) || min >= max) return;
    const state = layerStates[index];
    const profile = profiles[index];
    if (!state || !profile) return;
    const sourceSpan = Math.max(Number.EPSILON, max - min);
    const center = (min + max) / 2 + (state.brightness / 100) * sourceSpan;
    const span = sourceSpan / Math.max(0.1, state.contrast);
    applyVolumeDisplay(nv, volume, profile, state.colormap, center - span / 2, center + span / 2);
    volume.colormapInvert = state.inverted;
    nv.setGamma(state.gamma);
    refreshVolume(nv, volume);
    nv.drawScene();
  }, [layerStates, profiles]);

  const setWindow = useCallback((mode: WindowMode, min: number, max: number) => {
    const profile = profiles[activeLayer];
    if (profile?.signed && layerStates[activeLayer]?.symmetric) {
      const magnitude = Math.max(Math.abs(min), Math.abs(max));
      min = -magnitude;
      max = magnitude;
    }
    setLayerStates((previous) => previous.map((state, index) => {
      if (index !== activeLayer) return state;
      const histogram = calculateHistogram(samplesRef.current[index] ?? [], min, max);
      return { ...state, ...histogram, windowMode: mode, windowMin: min, windowMax: max };
    }));
    applyWindow(activeLayer, min, max);
  }, [activeLayer, applyWindow, layerStates, profiles]);

  const resetViewer = useCallback(() => {
    const nv = nvRef.current;
    if (!nv) return;
    const nextStates = layers.map((layer, index) => {
      const samples = samplesRef.current[index] ?? [];
      const statistics = computeDisplayStatistics(samples, profiles[index]);
      const histogram = calculateHistogram(samples, statistics.displayMin, statistics.displayMax);
      return {
        ...histogram,
        colormap: layer.colormap ?? profiles[index].defaultColormap,
        opacity: layer.opacity ?? profiles[index].opacity,
        windowMode: "auto" as WindowMode,
        windowMin: statistics.displayMin,
        windowMax: statistics.displayMax,
        brightness: 0,
        contrast: 1,
        gamma: 1,
        inverted: false,
        symmetric: profiles[index].signed,
        visible: true,
      };
    });
    nextStates.forEach((state, index) => {
      const volume = nv.volumes[index];
      if (!volume) return;
      if (!isLabelProfile(profiles[index])) applyVolumeDisplay(nv, volume, profiles[index], state.colormap, state.windowMin, state.windowMax);
      volume.colormapInvert = false;
      refreshVolume(nv, volume);
      nv.setOpacity(index, state.opacity);
    });
    setLayerStates(nextStates);
    setActiveLayer(0);
    setNearest(hasLabelLayer);
    setInterpolationMode("auto");
    nv.setInterpolation(hasLabelLayer);
    setCrosshairVisible(true);
    setCrosshairWidth(Number(DEFAULT_CROSSHAIR_WIDTH));
    setCrosshairColor("#38bdf8");
    nv.setCrosshairWidth(Number(DEFAULT_CROSSHAIR_WIDTH));
    nv.setCrosshairColor(hexToRgba("#38bdf8"));
    setBackground("dark");
    nv.opts.backColor = [...DARK_BACKGROUND];
    setShowColorbarState(showColorbar);
    nv.opts.isColorbar = showColorbar;
    setShowOrientation(true);
    nv.setIsOrientationTextVisible(true);
    setRadiological(false);
    nv.setRadiologicalConvention(false);
    setViewLayout(multiplanar ? "multiplanar" : "axial");
    nv.opts.multiplanarShowRender = 0;
    nv.setSliceType(multiplanar ? 3 : 0);
    nv.setGamma(1);
    nv.setPan2Dxyzmm([0, 0, 0, 1]);
    nv.volScaleMultiplier = 1;
    nv.drawScene();
  }, [hasLabelLayer, layers, multiplanar, profiles, showColorbar]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      const key = event.key.toLowerCase();
      if (key === "escape" && modal) onClose?.();
      if (key === "r") resetViewer();
      if (key === "h") setHistogramOpen((value) => !value);
      if (key === "i") {
        setNearest((value) => {
          nvRef.current?.setInterpolation(!value);
          return !value;
        });
      }
      if (key === "c" && current && !isLabelProfile(profiles[activeLayer])) {
        const index = VIEWER_COLORMAPS.findIndex(([value]) => value === current.colormap);
        const next = VIEWER_COLORMAPS[(index + 1) % VIEWER_COLORMAPS.length][0];
        const volume = nvRef.current?.volumes[activeLayer];
        if (volume && nvRef.current) applyVolumeDisplay(nvRef.current, volume, profiles[activeLayer], next, current.windowMin, current.windowMax);
        setLayerStates((states) => states.map((state, layerIndex) => layerIndex === activeLayer ? { ...state, colormap: next } : state));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeLayer, current, modal, onClose, profiles, resetViewer]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let mountedNv: Niivue | null = null;
    setLoading(true);
    setError(null);

    loadNiivue().then(async ({ Niivue, cmapper }) => {
      if (cancelled) return;
      const nv = new Niivue({
        ...NIIVUE_MULTIPLANAR_OPTIONS,
        isColorbar: showColorbar,
        crosshairWidth: pubMode ? 0 : DEFAULT_CROSSHAIR_WIDTH,
      });
      mountedNv = nv;
      nv.attachToCanvas(canvas);
      const lut = hasLabelLayer
        ? cmapper.makeLabelLut(ASEG_COLOR_MAP)
        : null;
      const options = layers.map((layer, index) => ({
        url: layer.url,
        // Client-generated comparison maps use blob: URLs, which have no
        // extension for NiiVue to inspect. Always provide a NIfTI filename
        // hint so historical difference maps load through this same viewer.
        name: /\.nii(?:\.gz)?$/i.test(layer.name) ? layer.name : `${layer.name}.nii.gz`,
        opacity: layer.opacity ?? profiles[index].opacity,
        colormap: isLabelProfile(profiles[index])
          ? ""
          : profiles[index].signed ? "red" : layer.colormap ?? profiles[index].defaultColormap,
        ...(isLabelProfile(profiles[index]) && lut ? { colormapLabel: lut } : {}),
        ...(profiles[index].signed ? { colormapNegative: "blue", ignoreZeroVoxels: true } : {}),
        ...(profiles[index].zeroBackground !== "data" ? { ignoreZeroVoxels: true } : {}),
        ...(!isLabelProfile(profiles[index]) ? { trustCalMinMax: false } : {}),
      }));
      volumeOptionsRef.current = options;
      await nv.loadVolumes(options);
      if (cancelled) return;
      if (multiplanar) nv.setSliceType(SLICE_TYPE_MULTIPLANAR);
      const useNearest = hasLabelLayer;
      nv.setInterpolation(useNearest);
      nv.setCrosshairColor(hexToRgba("#38bdf8"));
      nv.onLocationChange = (next: unknown) => {
        if (!cancelled) setLocation(next as ViewerLocation);
      };
      const samples = nv.volumes.map((volume) => finiteSamples(volume.img as NumericArray));
      samplesRef.current = samples;
      const structuralIndex = profiles.findIndex((profile) => profile.id === "structural");
      const requestedOverlayIndices = profiles
        .map((profile, index) => profile.anatomicalUnderlay && index !== structuralIndex ? index : -1)
        .filter((index) => index >= 0);
      const blockedOverlays = new Map<number, string>();
      if (requestedOverlayIndices.length && structuralIndex < 0) {
        setUnderlayStatus("No anatomical underlay was supplied. Statistical rendering remains in 2D; no anatomy was guessed or resampled.");
        setHasCompatibleUnderlay(false);
      } else if (requestedOverlayIndices.length && structuralIndex >= 0) {
        const underlayGeometry = volumeGeometry(nv.volumes[structuralIndex], layers[structuralIndex]?.metadata);
        const results = requestedOverlayIndices.map((index) => {
          const result = checkVolumeCompatibility(
            underlayGeometry,
            volumeGeometry(nv.volumes[index], layers[index]?.metadata),
          );
          if (!result.compatible) blockedOverlays.set(index, result.reason);
          return { index, result };
        });
        if (blockedOverlays.size) {
          setUnderlayStatus(`Overlay withheld: ${results.filter(({ result }) => !result.compatible).map(({ index, result }) => `${layers[index].name} — ${result.reason}`).join("; ")}. No resampling was performed.`);
          setHasCompatibleUnderlay(false);
        } else {
          setUnderlayStatus(`Anatomical underlay enabled. ${results[0].result.reason}. No resampling was performed.`);
          setHasCompatibleUnderlay(true);
        }
      } else {
        setUnderlayStatus("");
        setHasCompatibleUnderlay(false);
      }
      const initialStates = layers.map((layer, index) => {
        const statistics = computeDisplayStatistics(samples[index], profiles[index]);
        const min = statistics.displayMin;
        const max = statistics.displayMax;
        const colormap = layer.colormap ?? profiles[index].defaultColormap;
        if (!isLabelProfile(profiles[index])) {
          applyVolumeDisplay(nv, nv.volumes[index], profiles[index], colormap, min, max);
        }
        return {
          ...calculateHistogram(samples[index], min, max),
          colormap,
          opacity: blockedOverlays.has(index) ? 0 : layer.opacity ?? profiles[index].opacity,
          windowMode: "auto" as WindowMode,
          windowMin: min,
          windowMax: max,
          brightness: 0,
          contrast: 1,
          gamma: 1,
          inverted: false,
          symmetric: profiles[index].signed,
          visible: true,
        };
      });
      nvRef.current = nv;
      blockedOverlays.forEach((_reason, index) => nv.setOpacity(index, 0));
      setLayerStates(initialStates);
      setNearest(useNearest);
      setLoading(false);
      onReady?.(nv);
    }).catch((caught: unknown) => {
      if (cancelled) return;
      setError(caught instanceof Error ? `Failed to load scan: ${caught.message}` : "Failed to load scan.");
      setLoading(false);
    });

    return () => {
      cancelled = true;
      nvRef.current = null;
      mountedNv?.cleanup?.();
      onUnmount?.();
    };
    // Consumer callbacks intentionally do not reload a volume.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLabelLayer, layerKey, multiplanar, profiles, showColorbar]);

  const handleExport = useCallback(async () => {
    const sourceCanvas = canvasRef.current;
    if (!sourceCanvas || !layerStates.length) return;
    setExporting(true);
    setExportStatus("");
    let exportNv: Niivue | null = null;
    let exportCanvas: HTMLCanvasElement | null = null;
    try {
      const { Niivue } = await loadNiivue();
      exportCanvas = document.createElement("canvas");
      const width = Math.max(640, Math.round(sourceCanvas.clientWidth || sourceCanvas.width));
      const height = Math.max(480, Math.round(sourceCanvas.clientHeight || sourceCanvas.height));
      exportCanvas.width = width * exportScale;
      exportCanvas.height = height * exportScale;
      // Give NiiVue a genuinely larger render target. This is intentionally a
      // second WebGL render, not a scaled copy of the visible canvas.
      exportCanvas.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${height}px`;
      document.body.appendChild(exportCanvas);
      exportNv = new Niivue({
        ...NIIVUE_MULTIPLANAR_OPTIONS,
        forceDevicePixelRatio: exportScale,
        isColorbar: showColorbarState,
        backColor: background === "light"
          ? [...LIGHT_BACKGROUND]
          : [...DARK_BACKGROUND],
      });
      if (transparentExport) exportNv.opts.backColor = [0, 0, 0, 0];
      exportNv.attachToCanvas(exportCanvas);
      await exportNv.loadVolumes(volumeOptionsRef.current);
      exportNv.opts.multiplanarShowRender = viewLayout === "four-pane" ? 1 : 0;
      const exportSliceType = viewLayout === "axial" ? 0 : viewLayout === "coronal" ? 1 : viewLayout === "sagittal" ? 2 : viewLayout === "render" ? 4 : 3;
      exportNv.setSliceType(exportSliceType);
      exportNv.setInterpolation(nearest);
      exportNv.setCrosshairWidth(crosshairVisible ? crosshairWidth : 0);
      exportNv.setCrosshairColor(hexToRgba(crosshairColor));
      exportNv.setRadiologicalConvention(radiological);
      exportNv.setIsOrientationTextVisible(showOrientation);
      exportNv.scene.crosshairPos = [...(nvRef.current?.scene.crosshairPos ?? [0.5, 0.5, 0.5])];
      layerStates.forEach((state, index) => {
        const volume = exportNv?.volumes[index];
        if (!volume || !exportNv) return;
        const sourceSpan = Math.max(Number.EPSILON, state.windowMax - state.windowMin);
        const center = (state.windowMin + state.windowMax) / 2 + (state.brightness / 100) * sourceSpan;
        const span = sourceSpan / Math.max(0.1, state.contrast);
        if (!isLabelProfile(profiles[index])) applyVolumeDisplay(exportNv, volume, profiles[index], state.colormap, center - span / 2, center + span / 2);
        volume.colormapInvert = state.inverted;
        exportNv.setOpacity(index, state.visible ? state.opacity : 0);
      });
      exportNv.setGamma(current?.gamma ?? 1);
      exportNv.drawScene();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const blob = await publicationBlob(exportCanvas, label, unitLabel, location);
      downloadBlob(blob, `${label.replace(/[^a-zA-Z0-9_-]/g, "_")}_${exportScale}x.png`);
      setExportStatus(`${exportScale}× PNG rendered (${exportCanvas.width} × ${exportCanvas.height}px)`);
    } catch (caught) {
      setError(caught instanceof Error ? `PNG export failed: ${caught.message}` : "PNG export failed.");
    } finally {
      exportNv?.cleanup?.();
      exportCanvas?.remove();
      setExporting(false);
    }
  }, [background, crosshairColor, crosshairVisible, crosshairWidth, current?.gamma, exportScale, label, layerStates, location, nearest, profiles, radiological, showColorbarState, showOrientation, transparentExport, unitLabel, viewLayout]);

  const changeColormap = (value: string) => {
    const volume = nvRef.current?.volumes[activeLayer];
    if (volume && nvRef.current && current) applyVolumeDisplay(nvRef.current, volume, profiles[activeLayer], value, current.windowMin, current.windowMax);
    setLayerStates((states) => states.map((state, index) => index === activeLayer ? { ...state, colormap: value } : state));
  };

  const updateTone = (patch: Partial<Pick<LayerViewState, "brightness" | "contrast" | "gamma" | "inverted">>) => {
    const next = current ? { ...current, ...patch } : null;
    if (!next) return;
    setLayerStates((states) => states.map((state, index) => index === activeLayer ? next : state));
    const nv = nvRef.current;
    const volume = nv?.volumes[activeLayer];
    if (!nv || !volume) return;
    const sourceSpan = Math.max(Number.EPSILON, next.windowMax - next.windowMin);
    const center = (next.windowMin + next.windowMax) / 2 + (next.brightness / 100) * sourceSpan;
    const span = sourceSpan / Math.max(0.1, next.contrast);
    applyVolumeDisplay(nv, volume, profiles[activeLayer], next.colormap, center - span / 2, center + span / 2);
    volume.colormapInvert = next.inverted;
    nv.setGamma(next.gamma);
    refreshVolume(nv, volume);
    nv.drawScene();
  };

  const changeOpacity = (opacity: number) => {
    if (current?.visible) nvRef.current?.setOpacity(activeLayer, opacity);
    setLayerStates((states) => states.map((state, index) => index === activeLayer ? { ...state, opacity } : state));
  };

  const toggleLayerVisibility = (index: number, visible: boolean) => {
    const state = layerStates[index];
    if (!state) return;
    nvRef.current?.setOpacity(index, visible ? state.opacity : 0);
    setLayerStates((states) => states.map((item, itemIndex) => itemIndex === index ? { ...item, visible } : item));
  };

  const moveLayer = (from: number, to: number) => {
    if (to < 0 || to >= layers.length) return;
    setLayers((previous) => {
      const next = [...previous];
      const [layer] = next.splice(from, 1);
      next.splice(to, 0, layer);
      return next;
    });
    setActiveLayer(to);
  };

  const removeLayer = (index: number) => {
    if (layers.length <= 1) return;
    setLayers((previous) => previous.filter((_layer, layerIndex) => layerIndex !== index));
    setActiveLayer((currentIndex) => Math.max(0, Math.min(currentIndex, layers.length - 2)));
  };

  const changeInterpolation = (mode: InterpolationMode) => {
    const value = mode === "auto" ? isLabelProfile(profiles[activeLayer]) : mode === "nearest";
    setInterpolationMode(mode);
    setNearest(value);
    nvRef.current?.setInterpolation(value);
  };

  const changeLayout = (layout: ViewLayout) => {
    const nv = nvRef.current;
    if (!nv) return;
    setViewLayout(layout);
    nv.opts.multiplanarShowRender = layout === "four-pane" ? 1 : 0;
    const sliceType = layout === "axial" ? 0 : layout === "coronal" ? 1 : layout === "sagittal" ? 2 : layout === "render" ? 4 : 3;
    nv.setSliceType(sliceType);
    nv.drawScene();
  };

  const jumpToCoordinate = () => {
    const nv = nvRef.current;
    if (!nv || jumpMm.some((value) => !Number.isFinite(value))) return;
    nv.scene.crosshairPos = nv.mm2frac([jumpMm[0], jumpMm[1], jumpMm[2], 1]);
    nv.drawScene();
  };

  const toggleFullscreen = async () => {
    if (!viewerRef.current) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await viewerRef.current.requestFullscreen();
  };

  const changeCrosshairVisible = (visible: boolean) => {
    setCrosshairVisible(visible);
    nvRef.current?.setCrosshairWidth(visible ? crosshairWidth : 0);
  };

  const changeCrosshairWidth = (value: number) => {
    setCrosshairWidth(value);
    if (crosshairVisible) nvRef.current?.setCrosshairWidth(value);
  };

  const changeBackground = (value: BackgroundMode) => {
    setBackground(value);
    const nv = nvRef.current;
    if (!nv) return;
    nv.opts.backColor = value === "light" ? [...LIGHT_BACKGROUND] : [...DARK_BACKGROUND];
    nv.drawScene();
  };

  const robustWindow = () => {
    if (!current) return;
    const statistics = computeDisplayStatistics(samplesRef.current[activeLayer] ?? [], profiles[activeLayer]);
    setWindow("robust", statistics.robustMin, statistics.robustMax);
  };
  const autoWindow = () => {
    if (!current) return;
    const statistics = computeDisplayStatistics(samplesRef.current[activeLayer] ?? [], profiles[activeLayer]);
    setWindow("auto", statistics.displayMin, statistics.displayMax);
  };
  const histogramMax = current ? Math.max(1, ...current.bins) : 1;
  const domainSpan = current ? Math.max(Number.EPSILON, current.dataMax - current.dataMin) : 1;
  const markerPercent = (value: number) => current ? Math.max(0, Math.min(100, ((value - current.dataMin) / domainSpan) * 100)) : 0;

  const content = (
    <div ref={viewerRef} className={`flex h-full min-h-0 flex-col overflow-hidden ${modal ? "bg-[#0d0d0d]" : "rounded bg-[#111]"}`} data-testid="shared-nifti-viewer">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/8 bg-[#0d0d0d] px-3 py-2">
        <div className="min-w-0 truncate font-mono text-[11px] tracking-wide text-gray-300">
          {layers.length > 1 ? layers[activeLayer]?.name ?? label : label}
          {unitLabel && <span className="ml-2 font-sans text-gray-500">[{unitLabel}]</span>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {loading && <div className="h-3 w-3 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />}
          {!loading && !error && <>
            <button type="button" onClick={() => { setIsPubMode((value) => !value); changeCrosshairVisible(isPubMode); }} className={`rounded border px-1.5 py-0.5 text-[10px] ${isPubMode ? "border-indigo-400/60 bg-indigo-500/15 text-indigo-300" : "border-white/10 text-gray-500 hover:text-gray-300"}`} title="Publication mode">PUB</button>
            <button type="button" onClick={toggleFullscreen} className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-gray-500 hover:text-white" title="Toggle fullscreen">⛶</button>
            <button type="button" onClick={() => setControlsOpen((value) => !value)} className="rounded border border-white/10 px-2 py-0.5 text-[10px] text-gray-400 hover:text-white" aria-expanded={controlsOpen}>Visualization {controlsOpen ? "▴" : "▾"}</button>
          </>}
          {onClose && <button type="button" onClick={onClose} className="text-lg leading-none text-gray-500 hover:text-white" aria-label="Close viewer">✕</button>}
        </div>
      </div>

      <div className={`flex min-h-0 flex-1 flex-col ${modal ? "xl:flex-row" : ""}`}>
      {controlsOpen && !loading && !error && current && (
        <div className={`max-h-[42vh] shrink-0 overflow-y-auto border-b border-white/8 bg-slate-950/90 px-3 py-3 text-[11px] text-slate-300 ${modal ? "xl:order-2 xl:max-h-none xl:w-[360px] xl:border-b-0 xl:border-l" : ""}`} data-testid="visualization-controls">
          <div className="grid gap-3">
            <div className="space-y-2">
              {requestedLayers.length > 4 && <div role="status" className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-amber-200">Only the first four layers are shown.</div>}
              {layers.length > 1 && <div className="space-y-1" data-testid="layer-panel"><div className="text-[10px] uppercase tracking-wide text-slate-500">Layers</div>{layers.map((layer, index) => <div key={layer.url} className={`flex items-center gap-1 rounded px-1 py-1 ${activeLayer === index ? "bg-cyan-500/10" : "bg-white/[0.03]"}`}><input aria-label={`Show ${layer.name}`} type="checkbox" checked={layerStates[index]?.visible ?? true} onChange={(event) => toggleLayerVisibility(index, event.target.checked)} /><button type="button" onClick={() => setActiveLayer(index)} className="min-w-0 flex-1 truncate text-left" title={layer.name}>{layer.name}</button><button type="button" aria-label={`Move ${layer.name} down`} disabled={index === 0} onClick={() => moveLayer(index, index - 1)} className="px-1 disabled:opacity-25">↓</button><button type="button" aria-label={`Move ${layer.name} up`} disabled={index === layers.length - 1} onClick={() => moveLayer(index, index + 1)} className="px-1 disabled:opacity-25">↑</button><button type="button" aria-label={`Remove ${layer.name}`} onClick={() => removeLayer(index)} className="px-1 text-rose-300">×</button></div>)}</div>}
              {underlayStatus && <div role="status" className={`rounded border p-2 text-[10px] ${hasCompatibleUnderlay ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200" : "border-amber-500/25 bg-amber-500/10 text-amber-200"}`}>{underlayStatus}</div>}
              <div className="flex items-center justify-between"><span className="font-medium text-slate-200">{profiles[activeLayer].label}</span><span className="text-[9px] text-slate-500">{profiles[activeLayer].colorbarLabel}</span></div>
              <label className="block">Colormap<select aria-label="Colormap" value={current.colormap} disabled={isLabelProfile(profiles[activeLayer])} onChange={(event) => changeColormap(event.target.value)} className="mt-1 w-full rounded border border-white/10 bg-slate-900 px-2 py-1 text-xs disabled:opacity-60">{isLabelProfile(profiles[activeLayer]) && <option value="roi_i256">Discrete ROI labels</option>}{VIEWER_COLORMAPS.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
              <label className="flex items-center gap-2"><input aria-label="Invert colormap" type="checkbox" checked={current.inverted} onChange={(event) => updateTone({ inverted: event.target.checked })} /> Invert colormap</label>
              <div><div className="flex items-center justify-between"><span>Opacity</span><label className="flex items-center gap-1"><input aria-label="Overlay opacity percentage" type="number" min="0" max="100" value={Math.round(current.opacity * 100)} onChange={(event) => changeOpacity(Math.max(0, Math.min(100, Number(event.target.value))) / 100)} className="w-14 rounded border border-white/10 bg-slate-900 px-1 py-0.5 text-right tabular-nums" />%</label></div><input aria-label="Overlay opacity" type="range" min="0" max="1" step="0.01" value={current.opacity} onChange={(event) => changeOpacity(Number(event.target.value))} className="mt-1 w-full accent-cyan-400" /></div>
              <div><span className="mb-1 block">Interpolation</span><div className="flex gap-1">{(["auto", "smooth", "nearest"] as InterpolationMode[]).map((mode) => <button key={mode} type="button" onClick={() => changeInterpolation(mode)} className={`rounded px-2 py-1 capitalize ${interpolationMode === mode ? "bg-cyan-500/20 text-cyan-200" : "bg-white/5"}`}>{mode === "nearest" ? "Nearest" : mode}</button>)}</div></div>
              <div className="grid grid-cols-3 gap-2"><label>Brightness <input aria-label="Brightness" type="range" min="-50" max="50" value={current.brightness} onChange={(event) => updateTone({ brightness: Number(event.target.value) })} className="w-full accent-cyan-400" /></label><label>Contrast <input aria-label="Contrast" type="range" min="0.25" max="3" step="0.05" value={current.contrast} onChange={(event) => updateTone({ contrast: Number(event.target.value) })} className="w-full accent-cyan-400" /></label><label>Gamma <input aria-label="Gamma" type="range" min="0.2" max="3" step="0.05" value={current.gamma} onChange={(event) => updateTone({ gamma: Number(event.target.value) })} className="w-full accent-cyan-400" /></label></div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between"><span>Intensity window</span><div className="flex gap-1"><button type="button" onClick={autoWindow} className={`rounded px-2 py-1 ${current.windowMode === "auto" ? "bg-cyan-500/20 text-cyan-200" : "bg-white/5"}`}>Auto</button><button type="button" onClick={robustWindow} className={`rounded px-2 py-1 ${current.windowMode === "robust" ? "bg-cyan-500/20 text-cyan-200" : "bg-white/5"}`}>Robust 2–98%</button><button type="button" onClick={autoWindow} className="rounded bg-white/5 px-2 py-1">Reset</button></div></div>
              {profiles[activeLayer].signed && <label className="flex items-center gap-2"><input aria-label="Symmetric range around zero" type="checkbox" checked={current.symmetric} onChange={(event) => { const symmetric = event.target.checked; setLayerStates((states) => states.map((state, index) => index === activeLayer ? { ...state, symmetric } : state)); if (symmetric) { const magnitude = Math.max(Math.abs(current.windowMin), Math.abs(current.windowMax)); setWindow("manual", -magnitude, magnitude); } }} /> Symmetric around zero</label>}
              <div className="grid grid-cols-2 gap-2"><label>Manual min<input aria-label="Manual minimum" type="number" value={Number(current.windowMin.toPrecision(6))} onChange={(event) => setWindow("manual", Number(event.target.value), current.windowMax)} className="mt-1 w-full rounded border border-white/10 bg-slate-900 px-2 py-1 text-xs" /></label><label>Manual max<input aria-label="Manual maximum" type="number" value={Number(current.windowMax.toPrecision(6))} onChange={(event) => setWindow("manual", current.windowMin, Number(event.target.value))} className="mt-1 w-full rounded border border-white/10 bg-slate-900 px-2 py-1 text-xs" /></label></div>
              <div className="grid grid-cols-2 gap-2"><label>Window<input aria-label="Window width" type="number" min="0" value={Number((current.windowMax - current.windowMin).toPrecision(6))} onChange={(event) => { const width = Math.max(Number.EPSILON, Number(event.target.value)); const level = (current.windowMax + current.windowMin) / 2; setWindow("manual", level - width / 2, level + width / 2); }} className="mt-1 w-full rounded border border-white/10 bg-slate-900 px-2 py-1 text-xs" /></label><label>Level<input aria-label="Window level" type="number" value={Number(((current.windowMax + current.windowMin) / 2).toPrecision(6))} onChange={(event) => { const level = Number(event.target.value); const width = current.windowMax - current.windowMin; setWindow("manual", level - width / 2, level + width / 2); }} className="mt-1 w-full rounded border border-white/10 bg-slate-900 px-2 py-1 text-xs" /></label></div>
              <button type="button" onClick={() => setHistogramOpen((value) => !value)} className="text-cyan-300 hover:text-cyan-100">{histogramOpen ? "Hide" : "Show"} histogram <span className="text-slate-500">(H)</span></button>
              {histogramOpen && <div className="relative h-24 rounded bg-black/25 px-1 pt-2" data-testid="intensity-histogram">
                <svg viewBox="0 0 640 72" className="h-16 w-full" role="img" aria-label="Voxel intensity histogram"><rect x={markerPercent(current.windowMin) * 6.4} y="0" width={Math.max(1, (markerPercent(current.windowMax) - markerPercent(current.windowMin)) * 6.4)} height="72" fill="#0891b2" opacity="0.12" />{current.bins.map((count, index) => <rect key={index} x={index * 10} y={68 - (count / histogramMax) * 60} width="8" height={(count / histogramMax) * 60} fill="#38bdf8" opacity="0.72"><title>{`Bin ${index + 1}: ${count.toLocaleString()} voxels`}</title></rect>)}<line x1={markerPercent(current.p2) * 6.4} x2={markerPercent(current.p2) * 6.4} y1="2" y2="70" stroke="#facc15" strokeDasharray="3 3"/><line x1={markerPercent(current.p98) * 6.4} x2={markerPercent(current.p98) * 6.4} y1="2" y2="70" stroke="#facc15" strokeDasharray="3 3"/><line x1={markerPercent(current.windowMin) * 6.4} x2={markerPercent(current.windowMin) * 6.4} y1="0" y2="72" stroke="#f8fafc" strokeWidth="2"/><line x1={markerPercent(current.windowMax) * 6.4} x2={markerPercent(current.windowMax) * 6.4} y1="0" y2="72" stroke="#f8fafc" strokeWidth="2"/></svg>
                <input aria-label="Histogram minimum handle" type="range" min={current.dataMin} max={current.dataMax} step={domainSpan / 500} value={current.windowMin} onChange={(event) => setWindow("manual", Math.min(Number(event.target.value), current.windowMax - domainSpan / 500), current.windowMax)} className="absolute inset-x-1 bottom-1 w-[calc(100%-0.5rem)] accent-white" />
                <input aria-label="Histogram maximum handle" type="range" min={current.dataMin} max={current.dataMax} step={domainSpan / 500} value={current.windowMax} onChange={(event) => setWindow("manual", current.windowMin, Math.max(Number(event.target.value), current.windowMin + domainSpan / 500))} className="pointer-events-none absolute inset-x-1 bottom-1 w-[calc(100%-0.5rem)] accent-yellow-300 [&::-webkit-slider-thumb]:pointer-events-auto" />
                <span className="absolute left-2 top-1 text-[9px] text-yellow-300">P2</span><span className="absolute right-2 top-1 text-[9px] text-yellow-300">P98</span>
              </div>}
              <div className="grid grid-cols-4 gap-1 text-[9px] tabular-nums text-slate-500"><span>mean {current.mean.toPrecision(3)}</span><span>median {current.median.toPrecision(3)}</span><span>P2 {current.p2.toPrecision(3)}</span><span>P98 {current.p98.toPrecision(3)}</span></div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between"><span>Crosshair</span><label className="flex items-center gap-1"><input aria-label="Show crosshair" type="checkbox" checked={crosshairVisible} onChange={(event) => changeCrosshairVisible(event.target.checked)} /> Show</label></div>
              <label className="block">Thickness <span className="float-right">{crosshairWidth.toFixed(1)}</span><input aria-label="Crosshair thickness" type="range" min="0.2" max="3" step="0.1" value={crosshairWidth} onChange={(event) => changeCrosshairWidth(Number(event.target.value))} className="mt-1 w-full accent-cyan-400" /></label>
              <label className="flex items-center justify-between">Color<input aria-label="Crosshair color" type="color" value={crosshairColor} onChange={(event) => { setCrosshairColor(event.target.value); nvRef.current?.setCrosshairColor(hexToRgba(event.target.value)); }} /></label>
              <div className="rounded bg-black/20 p-2 font-mono text-[10px] tabular-nums"><div>mm {location.mm?.slice(0, 3).map((value) => Number(value).toFixed(1)).join(", ") || "—"}</div><div>vox {location.vox?.slice(0, 3).map((value) => Math.round(Number(value))).join(", ") || "—"}</div><div>value {location.values?.[activeLayer] != null ? Number(location.values[activeLayer]).toPrecision(5) : "—"}</div></div>
              <div><span className="mb-1 block">Jump to mm</span><div className="flex gap-1">{([0, 1, 2] as const).map((index) => <input key={index} aria-label={`Jump ${["X", "Y", "Z"][index]} coordinate`} type="number" value={jumpMm[index]} onChange={(event) => setJumpMm((previous) => previous.map((value, item) => item === index ? Number(event.target.value) : value) as [number, number, number])} className="min-w-0 flex-1 rounded border border-white/10 bg-slate-900 px-1 py-1" />)}<button type="button" onClick={jumpToCoordinate} className="rounded bg-cyan-500/20 px-2 text-cyan-200">Go</button></div></div>
              <div><span className="mb-1 block">Layout</span><div className="flex flex-wrap gap-1">{(["axial", "coronal", "sagittal", "multiplanar", "four-pane", "render"] as ViewLayout[]).map((layout) => { const renderDisabled = layout === "render" && profiles[activeLayer].threeD !== "volume" && !hasCompatibleUnderlay; return <button key={layout} type="button" disabled={renderDisabled} title={renderDisabled ? "3D requires a structural volume or compatible anatomical underlay" : undefined} onClick={() => changeLayout(layout)} className={`rounded px-2 py-1 capitalize disabled:cursor-not-allowed disabled:opacity-35 ${viewLayout === layout ? "bg-cyan-500/20 text-cyan-200" : "bg-white/5"}`}>{layout === "multiplanar" ? "2D" : layout === "render" ? "3D" : layout.replace("-", " ")}</button>; })}</div></div>
              <div className="grid grid-cols-2 gap-2"><label className="flex items-center gap-1"><input aria-label="Radiological convention" type="checkbox" checked={radiological} onChange={(event) => { setRadiological(event.target.checked); nvRef.current?.setRadiologicalConvention(event.target.checked); }} /> Radiological</label><label className="flex items-center gap-1"><input aria-label="Show orientation labels" type="checkbox" checked={showOrientation} onChange={(event) => { setShowOrientation(event.target.checked); nvRef.current?.setIsOrientationTextVisible(event.target.checked); }} /> Labels</label><label className="flex items-center gap-1"><input aria-label="Show colorbar" type="checkbox" checked={showColorbarState} onChange={(event) => { setShowColorbarState(event.target.checked); if (nvRef.current) { nvRef.current.opts.isColorbar = event.target.checked; nvRef.current.drawScene(); } }} /> Colorbar</label></div>
              <div><span className="block mb-1">Background</span><div className="flex gap-1"><button type="button" onClick={() => changeBackground("dark")} className={`rounded px-2 py-1 ${background === "dark" ? "bg-cyan-500/20 text-cyan-200" : "bg-white/5"}`}>Dark</button><button type="button" onClick={() => changeBackground("light")} className={`rounded px-2 py-1 ${background === "light" ? "bg-cyan-500/20 text-cyan-200" : "bg-white/5"}`}>Light</button></div></div>
              <label className="flex items-center gap-2"><input aria-label="Transparent export" type="checkbox" checked={transparentExport} onChange={(event) => setTransparentExport(event.target.checked)} /> Transparent PNG background</label>
              <div className="flex items-center gap-2"><select aria-label="Export resolution" value={exportScale} onChange={(event) => setExportScale(Number(event.target.value) as 2 | 4)} className="rounded border border-white/10 bg-slate-900 px-2 py-1"><option value={2}>2× PNG</option><option value={4}>4× PNG</option></select><button type="button" onClick={handleExport} disabled={exporting} className="rounded bg-cyan-500/20 px-2 py-1 text-cyan-200 disabled:opacity-50">{exporting ? "Rendering…" : "Export"}</button></div>
              {exportStatus && <div role="status" className="text-[10px] text-emerald-300">✓ {exportStatus}</div>}
              <button type="button" onClick={resetViewer} className="rounded border border-white/10 px-2 py-1 text-slate-200 hover:bg-white/5">Reset viewer <span className="text-slate-500">(R)</span></button>
              <div className="text-[9px] text-slate-500">Shortcuts: R reset · H histogram · C colormap · I interpolation</div>
            </div>
          </div>
        </div>
      )}

      <div className={`relative min-h-[180px] flex-1 ${modal ? "xl:order-1" : ""}`}>
        {loading && <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-[#0d0d0d]"><div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent"/><span className="text-xs text-gray-400">Loading {layers.length > 1 ? `${layers.length} layers…` : "scan…"}</span></div>}
        {error && <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0d0d0d] p-4"><div className="max-w-md rounded border border-red-800/60 bg-red-950/40 px-4 py-3 text-center text-xs text-red-300">{error}</div></div>}
        <canvas ref={canvasRef} className="h-full w-full" data-testid="niivue-canvas" />
      </div>
      </div>
      {!loading && !error && !isPubMode && <div className="flex shrink-0 gap-4 border-t border-white/8 bg-[#0d0d0d] px-3 py-1 text-[9px] text-gray-600"><span>Scroll — slice</span><span>Drag — pan</span><span>Right-drag — zoom</span></div>}
    </div>
  );

  if (!modal) return content;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={(event) => { if (event.target === event.currentTarget) onClose?.(); }}><div className="mx-4 flex h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-white/8 bg-[#0d0d0d] shadow-2xl">{content}</div></div>;
}
