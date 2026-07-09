// Standard FreeSurfer subcortical segmentation color table (aseg).
// Colors from FreeSurferColorLUT.txt (https://surfer.nmr.mgh.harvard.edu/fswiki/FsTutorial/AnatomicalROI/FreeSurferColorLUT)
// Covers core aseg structures (labels 0–85). NiiVue accepts non-contiguous indices via I[].

type AsegEntry = readonly [index: number, r: number, g: number, b: number, a: number, label: string];

const ENTRIES: AsegEntry[] = [
  [0,   0,   0,   0,   0,   "Unknown"],
  [2,   245, 245, 245, 255, "Left-Cerebral-White-Matter"],
  [3,   205, 62,  78,  255, "Left-Cerebral-Cortex"],
  [4,   120, 18,  134, 255, "Left-Lateral-Ventricle"],
  [5,   196, 58,  250, 255, "Left-Inf-Lat-Vent"],
  [7,   220, 248, 164, 255, "Left-Cerebellum-White-Matter"],
  [8,   230, 148, 34,  255, "Left-Cerebellum-Cortex"],
  [10,  0,   118, 14,  255, "Left-Thalamus"],
  [11,  122, 186, 220, 255, "Left-Caudate"],
  [12,  236, 13,  176, 255, "Left-Putamen"],
  [13,  12,  48,  255, 255, "Left-Pallidum"],
  [14,  204, 182, 142, 255, "3rd-Ventricle"],
  [15,  42,  204, 164, 255, "4th-Ventricle"],
  [16,  119, 159, 176, 255, "Brain-Stem"],
  [17,  220, 216, 20,  255, "Left-Hippocampus"],
  [18,  103, 255, 255, 255, "Left-Amygdala"],
  [24,  60,  60,  60,  255, "CSF"],
  [26,  255, 165, 0,   255, "Left-Accumbens-area"],
  [28,  165, 42,  42,  255, "Left-VentralDC"],
  [41,  0,   225, 0,   255, "Right-Cerebral-White-Matter"],
  [42,  205, 62,  78,  255, "Right-Cerebral-Cortex"],
  [43,  120, 18,  134, 255, "Right-Lateral-Ventricle"],
  [44,  196, 58,  250, 255, "Right-Inf-Lat-Vent"],
  [46,  220, 248, 164, 255, "Right-Cerebellum-White-Matter"],
  [47,  230, 148, 34,  255, "Right-Cerebellum-Cortex"],
  [49,  0,   118, 14,  255, "Right-Thalamus"],
  [50,  122, 186, 220, 255, "Right-Caudate"],
  [51,  236, 13,  176, 255, "Right-Putamen"],
  [52,  13,  48,  255, 255, "Right-Pallidum"],
  [53,  220, 216, 20,  255, "Right-Hippocampus"],
  [54,  103, 255, 255, 255, "Right-Amygdala"],
  [58,  255, 165, 0,   255, "Right-Accumbens-area"],
  [60,  165, 42,  42,  255, "Right-VentralDC"],
  [77,  200, 70,  255, 255, "WM-hypointensities"],
  [85,  234, 169, 30,  255, "Optic-Chiasm"],
];

// NiiVue ColorMap format: parallel arrays, I[] maps each entry to a voxel label value.
export const ASEG_COLOR_MAP = {
  I:      ENTRIES.map(([i]) => i),
  R:      ENTRIES.map(([, r]) => r),
  G:      ENTRIES.map(([, , g]) => g),
  B:      ENTRIES.map(([, , , b]) => b),
  A:      ENTRIES.map(([, , , , a]) => a),
  labels: ENTRIES.map(([, , , , , label]) => label),
} as const;
