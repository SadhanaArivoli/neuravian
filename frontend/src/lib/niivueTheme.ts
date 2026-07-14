/**
 * Shared NiiVue visualization theme for NeuroForge.
 *
 * All NiiVue viewer components pull from this single source of truth.
 * Keep in sync with the NiiVue version installed (currently 0.69.0).
 *
 * Colormap selection rationale:
 *   inferno  — perceptually uniform sequential (black→purple→orange→yellow).
 *              Ideal for positive-only amplitude maps (ALFF, fALFF, REHO).
 *   inferno  — shared sequential default for non-negative statistical maps.
 *   blue2red — diverging (blue→white→red). Correct for difference maps,
 *              seed-based correlation maps (can be negative), and Z-maps.
 *   gray     — anatomical background (always the base layer).
 *   green    — binary brain masks at low opacity.
 *
 * Slice types (NiiVue v0.69.0):
 *   0 = AXIAL
 *   1 = CORONAL
 *   2 = SAGITTAL
 *   3 = MULTIPLANAR  ← default for stat maps
 *   4 = RENDER
 */

/** Init options passed to `new Niivue({ ... })`. */
export const NIIVUE_BASE_OPTIONS = {
  /** Near-black, slightly warm — dark-room viewing without pure black artifacts. */
  backColor: [0.07, 0.07, 0.07, 1] as [number, number, number, number],
  /** Thin, semi-transparent crosshair. 0 = off, 1 = thick. */
  crosshairWidth: 0.5,
  show3Dcrosshair: true,
  /** Relative text height for coordinate labels. */
  fontMinPx: 12,
  fontSizeScaling: 1,
  /** Use device pixel ratio for crisp rendering on Retina displays. */
  isHighResolutionCapable: true,
  /** Show the internal NiiVue color scale bar. */
  isColorbar: true,
  /** Height of the colorbar as a fraction of the canvas. */
  colorbarHeight: 0.04,
} as const;

/** Multiplanar options — extends base. Pass to `new Niivue()` then call
 *  `nv.setSliceType(SLICE_TYPE_MULTIPLANAR)` after init. */
export const NIIVUE_MULTIPLANAR_OPTIONS = {
  ...NIIVUE_BASE_OPTIONS,
} as const;

/** NiiVue SLICE_TYPE enum value for multiplanar (sag + cor + axial). */
export const SLICE_TYPE_MULTIPLANAR = 3;

/**
 * Map semantic pipeline output types to the best NiiVue built-in colormap.
 * Keys match the `mapType` prop accepted by NiivuePanel / NiivueViewer.
 */
export type StatMapType =
  | "alff"
  | "falff"
  | "reho"
  | "reho_z"
  | "fc_overlay"
  | "seed_connectivity"
  | "difference"
  | "z_map"
  | "t_map"
  | "mask"
  | "anatomical"
  | "segmentation"
  | "default";

export const STAT_MAP_COLORMAP: Record<StatMapType, string> = {
  alff:             "inferno",   // positive-only amplitude: black→orange→yellow
  falff:            "inferno",   // same scale as ALFF for comparison
  reho:             "inferno",   // positive-only KCC: sequential scale
  reho_z:           "blue2red",  // standardized maps can be signed
  fc_overlay:       "blue2red",  // correlation maps can be signed
  seed_connectivity:"blue2red",  // diverging: blue negative, white zero, red positive
  difference:       "blue2red",  // difference maps always diverging
  z_map:            "blue2red",
  t_map:            "blue2red",
  mask:             "green",     // binary mask at low opacity
  anatomical:       "gray",
  segmentation:     "",          // uses FreeSurfer LUT colormapLabel
  default:          "inferno",
};

/** Default opacity for the base anatomical layer (layer 0). */
export const BASE_LAYER_OPACITY = 1.0;
/** Default opacity for statistical overlay layers (layer 1+). */
export const OVERLAY_LAYER_OPACITY = 0.75;

/**
 * Build the NiiVue volume-options array for a standard anatomical + stat-map pair.
 * Returns a ready-to-pass array for `nv.loadVolumes()`.
 */
export function buildVolumeOptions(
  anatomicalUrl: string,
  statMapUrl: string,
  mapType: StatMapType = "default",
  overlayOpacity = OVERLAY_LAYER_OPACITY,
) {
  return [
    { url: anatomicalUrl, colormap: "gray", opacity: BASE_LAYER_OPACITY },
    { url: statMapUrl,    colormap: STAT_MAP_COLORMAP[mapType], opacity: overlayOpacity },
  ];
}

/**
 * Human-readable unit label shown in the colorbar for each map type.
 */
export const STAT_MAP_UNIT: Record<StatMapType, string> = {
  alff:             "ALFF",
  falff:            "fALFF",
  reho:             "KCC (W)",
  reho_z:           "z-score",
  fc_overlay:       "r",
  seed_connectivity:"r",
  difference:       "Δ",
  z_map:            "z",
  t_map:            "t",
  mask:             "mask",
  anatomical:       "",
  segmentation:     "",
  default:          "",
};
