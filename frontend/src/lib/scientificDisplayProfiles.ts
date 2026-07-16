import type { StatMapType } from "./niivueTheme";

export type ScientificMapClass =
  | "structural"
  | "positive-continuous"
  | "signed-continuous"
  | "z-score"
  | "correlation"
  | "probability"
  | "binary-mask"
  | "label-atlas"
  | "difference-map"
  | "unknown-continuous";

export type DisplayRangeAlgorithm =
  | "structural-robust"
  | "positive-robust-zero"
  | "signed-robust-symmetric"
  | "probability-exact"
  | "discrete-exact"
  | "continuous-robust";

export interface DisplayProfile {
  id: ScientificMapClass;
  label: string;
  defaultColormap: string;
  signed: boolean;
  rangeAlgorithm: DisplayRangeAlgorithm;
  zeroBackground: "data" | "black" | "transparent" | "discrete";
  interpolation: "smooth" | "nearest";
  opacity: number;
  colorbarLabel: string;
  threeD: "volume" | "underlay-only" | "disabled";
  anatomicalUnderlay: boolean;
}

export interface MapClassificationInput {
  artifactType?: string | null;
  pipelineId?: string | null;
  semanticType?: StatMapType | null;
  name?: string | null;
  url?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface DisplayStatistics {
  dataMin: number;
  dataMax: number;
  robustMin: number;
  robustMax: number;
  displayMin: number;
  displayMax: number;
  mean: number;
  median: number;
  p2: number;
  p98: number;
  validCount: number;
  nonZeroCount: number;
  backgroundZeroCount: number;
  isConstant: boolean;
  isEmpty: boolean;
}

export const DISPLAY_PROFILES: Record<ScientificMapClass, DisplayProfile> = {
  structural: {
    id: "structural", label: "Structural", defaultColormap: "gray", signed: false,
    rangeAlgorithm: "structural-robust", zeroBackground: "data", interpolation: "smooth",
    opacity: 1, colorbarLabel: "Intensity", threeD: "volume", anatomicalUnderlay: false,
  },
  "positive-continuous": {
    id: "positive-continuous", label: "Positive continuous", defaultColormap: "inferno", signed: false,
    rangeAlgorithm: "positive-robust-zero", zeroBackground: "black", interpolation: "smooth",
    opacity: 1, colorbarLabel: "Value", threeD: "underlay-only", anatomicalUnderlay: true,
  },
  "signed-continuous": {
    id: "signed-continuous", label: "Signed continuous", defaultColormap: "blue2red", signed: true,
    rangeAlgorithm: "signed-robust-symmetric", zeroBackground: "transparent", interpolation: "smooth",
    opacity: 0.9, colorbarLabel: "Value", threeD: "underlay-only", anatomicalUnderlay: true,
  },
  "z-score": {
    id: "z-score", label: "Z-score", defaultColormap: "blue2red", signed: true,
    rangeAlgorithm: "signed-robust-symmetric", zeroBackground: "transparent", interpolation: "smooth",
    opacity: 0.9, colorbarLabel: "z-score", threeD: "underlay-only", anatomicalUnderlay: true,
  },
  correlation: {
    id: "correlation", label: "Correlation", defaultColormap: "blue2red", signed: true,
    rangeAlgorithm: "signed-robust-symmetric", zeroBackground: "transparent", interpolation: "smooth",
    opacity: 0.9, colorbarLabel: "Fisher z", threeD: "underlay-only", anatomicalUnderlay: true,
  },
  probability: {
    id: "probability", label: "Probability", defaultColormap: "viridis", signed: false,
    rangeAlgorithm: "probability-exact", zeroBackground: "black", interpolation: "smooth",
    opacity: 0.85, colorbarLabel: "Probability", threeD: "underlay-only", anatomicalUnderlay: true,
  },
  "binary-mask": {
    id: "binary-mask", label: "Binary mask", defaultColormap: "roi_i256", signed: false,
    rangeAlgorithm: "discrete-exact", zeroBackground: "transparent", interpolation: "nearest",
    opacity: 0.55, colorbarLabel: "Mask", threeD: "disabled", anatomicalUnderlay: true,
  },
  "label-atlas": {
    id: "label-atlas", label: "Label / atlas", defaultColormap: "roi_i256", signed: false,
    rangeAlgorithm: "discrete-exact", zeroBackground: "transparent", interpolation: "nearest",
    opacity: 0.7, colorbarLabel: "Label", threeD: "disabled", anatomicalUnderlay: true,
  },
  "difference-map": {
    id: "difference-map", label: "Difference map", defaultColormap: "blue2red", signed: true,
    rangeAlgorithm: "signed-robust-symmetric", zeroBackground: "transparent", interpolation: "smooth",
    opacity: 0.9, colorbarLabel: "Difference", threeD: "underlay-only", anatomicalUnderlay: true,
  },
  "unknown-continuous": {
    id: "unknown-continuous", label: "Unknown continuous", defaultColormap: "gray", signed: false,
    rangeAlgorithm: "continuous-robust", zeroBackground: "data", interpolation: "smooth",
    opacity: 1, colorbarLabel: "Value", threeD: "disabled", anatomicalUnderlay: false,
  },
};

const ARTIFACT_CLASS: Record<string, ScientificMapClass> = {
  seed_connectivity_map_nii: "correlation",
  reho_map_nii: "positive-continuous",
  reho_normalized_map_nii: "z-score",
  alff_map_nii: "positive-continuous",
  falff_map_nii: "positive-continuous",
  alff_normalized_map_nii: "z-score",
  falff_normalized_map_nii: "z-score",
  brain_mask: "binary-mask",
  atlas_resampled_nii: "label-atlas",
  nifti_skull_stripped: "structural",
  nifti_defaced: "structural",
  fmriprep_anatomical: "structural",
  fmriprep_boldref: "structural",
  fmriprep_bold: "structural",
  fmriprep_brain_mask: "binary-mask",
  fmriprep_dseg: "label-atlas",
  fmriprep_probseg: "probability",
  statistical_map_thresholded: "signed-continuous",
};

const SEMANTIC_CLASS: Partial<Record<StatMapType, ScientificMapClass>> = {
  anatomical: "structural",
  alff: "positive-continuous",
  falff: "positive-continuous",
  reho: "positive-continuous",
  reho_z: "z-score",
  fc_overlay: "correlation",
  seed_connectivity: "correlation",
  z_map: "z-score",
  t_map: "signed-continuous",
  difference: "difference-map",
  mask: "binary-mask",
  segmentation: "label-atlas",
  default: "unknown-continuous",
};

function metadataText(metadata?: Record<string, unknown> | null) {
  if (!metadata) return "";
  return Object.entries(metadata)
    .filter(([key]) => /type|intent|unit|normal|measure|stat|space|direction/i.test(key))
    .map(([key, value]) => `${key}:${String(value)}`)
    .join(" ")
    .toLowerCase();
}

export function classifyScientificMap(input: MapClassificationInput): ScientificMapClass {
  const artifact = input.artifactType?.toLowerCase();
  if (artifact && ARTIFACT_CLASS[artifact]) return ARTIFACT_CLASS[artifact];

  const meta = metadataText(input.metadata);
  if (/fisher|pearson|correlation/.test(meta)) return "correlation";
  if (/z[-_ ]?score|zstat|standardiz/.test(meta)) return "z-score";
  if (/probability|probseg|posterior/.test(meta)) return "probability";
  if (/binary|mask/.test(meta)) return "binary-mask";
  if (/label|atlas|parcell/.test(meta)) return "label-atlas";
  if (/difference|contrast/.test(meta)) return "difference-map";

  const pipeline = input.pipelineId?.toLowerCase() ?? "";
  if (pipeline === "seed-based-connectivity") return "correlation";
  if (pipeline === "regional-homogeneity") return /normal|z/.test(meta) ? "z-score" : "positive-continuous";
  if (pipeline === "alff-falff") return /normal|z/.test(meta) ? "z-score" : "positive-continuous";
  if (pipeline === "statistical-map-explorer") {
    return /positive/.test(meta) ? "positive-continuous" : "signed-continuous";
  }

  if (input.semanticType && SEMANTIC_CLASS[input.semanticType]) {
    return SEMANTIC_CLASS[input.semanticType] as ScientificMapClass;
  }

  const identity = `${input.name ?? ""} ${input.url ?? ""}`.toLowerCase();
  if (/(^|[_/.-])(dseg|aseg|aparc|parc|atlas|labels?)([_/.-]|$)/.test(identity)) return "label-atlas";
  if (/(^|[_/.-])mask([_/.-]|$)/.test(identity)) return "binary-mask";
  if (/(prob|probseg|probability)/.test(identity)) return "probability";
  if (/(seed.*connect|connect.*map)/.test(identity)) return "correlation";
  if (/(difference|diff[_-]?map|contrast)/.test(identity)) return "difference-map";
  if (/(reho[_-]?(z|normal)|z[-_]?map|zstat)/.test(identity)) return "z-score";
  if (/(t[-_]?map|tstat|signed)/.test(identity)) return "signed-continuous";
  if (/(falff|(^|[_/.-])alff([_/.-]|$)|reho)/.test(identity)) return "positive-continuous";
  if (/(t1w|t2w|anatom|structural|orig\.mgz|brain\.mgz|(^|[_/.-])stripped\.nii)/.test(identity)) return "structural";
  return "unknown-continuous";
}

export function selectDisplayProfile(input: MapClassificationInput): DisplayProfile {
  const base = DISPLAY_PROFILES[classifyScientificMap(input)];
  const meta = metadataText(input.metadata);
  if (base.id === "correlation" && /pearson(?!.*fisher)|unit:r\b/.test(meta)) {
    return { ...base, colorbarLabel: "Pearson r" };
  }
  return base;
}

function quantile(sorted: number[], fraction: number) {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function safeRange(minimum: number, maximum: number) {
  if (minimum < maximum) return [minimum, maximum] as const;
  if (minimum === 0) return [0, 1] as const;
  const pad = Math.max(Math.abs(minimum) * 0.01, 1e-6);
  return [minimum - pad, maximum + pad] as const;
}

export function computeDisplayStatistics(
  values: ArrayLike<number | bigint> | null | undefined,
  profile: DisplayProfile,
): DisplayStatistics {
  const finite: number[] = [];
  if (values) {
    for (let index = 0; index < values.length; index += 1) {
      const value = Number(values[index]);
      if (Number.isFinite(value)) finite.push(value);
    }
  }
  if (!finite.length) {
    return {
      dataMin: 0, dataMax: 0, robustMin: 0, robustMax: 1, displayMin: 0, displayMax: 1,
      mean: 0, median: 0, p2: 0, p98: 1, validCount: 0, nonZeroCount: 0,
      backgroundZeroCount: 0, isConstant: true, isEmpty: true,
    };
  }

  const sorted = [...finite].sort((a, b) => a - b);
  const nonZero = sorted.filter((value) => value !== 0);
  const meaningful = profile.rangeAlgorithm === "structural-robust"
    || profile.rangeAlgorithm === "positive-robust-zero"
    || profile.signed
    ? nonZero
    : sorted;
  const rangeValues = meaningful.length ? meaningful : sorted;
  const p2 = quantile(rangeValues, 0.02);
  const p98 = quantile(rangeValues, 0.98);
  let robustMin = p2;
  let robustMax = p98;
  let displayMin = p2;
  let displayMax = p98;

  if (profile.rangeAlgorithm === "positive-robust-zero") {
    robustMin = Math.max(0, p2);
    robustMax = Math.max(0, p98);
    displayMin = 0;
    displayMax = robustMax;
  } else if (profile.rangeAlgorithm === "signed-robust-symmetric") {
    const magnitude = Math.max(Math.abs(p2), Math.abs(p98));
    robustMin = -magnitude;
    robustMax = magnitude;
    displayMin = -magnitude;
    displayMax = magnitude;
  } else if (profile.rangeAlgorithm === "probability-exact") {
    robustMin = 0;
    robustMax = 1;
    displayMin = 0;
    displayMax = 1;
  } else if (profile.rangeAlgorithm === "discrete-exact") {
    robustMin = sorted[0];
    robustMax = sorted[sorted.length - 1];
    displayMin = robustMin;
    displayMax = robustMax;
  }

  [displayMin, displayMax] = safeRange(displayMin, displayMax);
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  return {
    dataMin: sorted[0], dataMax: sorted[sorted.length - 1], robustMin, robustMax,
    displayMin, displayMax, mean, median: quantile(sorted, 0.5), p2, p98,
    validCount: finite.length, nonZeroCount: nonZero.length,
    backgroundZeroCount: finite.length - nonZero.length,
    isConstant: sorted[0] === sorted[sorted.length - 1], isEmpty: nonZero.length === 0,
  };
}
