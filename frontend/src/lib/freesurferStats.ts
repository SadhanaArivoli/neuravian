export interface FreeSurferStatRow {
  index: number | null;
  segmentationId: number | null;
  name: string;
  voxelCount: number | null;
  volumeMm3: number | null;
  areaMm2: number | null;
  meanThicknessMm: number | null;
  hemisphere: "left" | "right" | null;
  values: Record<string, string | number>;
}

export interface FreeSurferStatsTable {
  columns: string[];
  rows: FreeSurferStatRow[];
  measures: Array<{ name: string; value: number; units: string | null }>;
}

const MAX_STATS_CHARS = 5_000_000;

function numeric(value: string | undefined) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function findColumn(columns: string[], patterns: RegExp[]) {
  return columns.findIndex((column) => patterns.some((pattern) => pattern.test(column)));
}

export function parseFreeSurferStats(text: string): FreeSurferStatsTable {
  if (text.length > MAX_STATS_CHARS) throw new Error("Statistics file exceeds the 5 MB preview limit.");
  let columns: string[] = [];
  const rows: FreeSurferStatRow[] = [];
  const measures: FreeSurferStatsTable["measures"] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#\s*ColHeaders\s+/i.test(line)) {
      columns = line.replace(/^#\s*ColHeaders\s+/i, "").trim().split(/\s+/);
      continue;
    }
    if (/^#\s*Measure\s+/i.test(line)) {
      const parts = line.replace(/^#\s*Measure\s+/i, "").split(",").map((part) => part.trim());
      const value = numeric(parts[parts.length - 2]);
      if (value != null) measures.push({ name: parts[0] || "Measure", value, units: parts[parts.length - 1] || null });
      continue;
    }
    if (line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (!columns.length) {
      // FastSurfer segmentation stats follow the standard aseg column order.
      columns = ["Index", "SegId", "NVoxels", "Volume_mm3", "StructName", "normMean", "normStdDev", "normMin", "normMax", "normRange"];
    }
    if (fields.length < Math.min(columns.length, 4)) continue;
    const values: Record<string, string | number> = {};
    columns.forEach((column, index) => {
      const value = fields[index] ?? "";
      values[column] = numeric(value) ?? value;
    });
    const indexColumn = findColumn(columns, [/^index$/i]);
    const idColumn = findColumn(columns, [/^segid$/i, /^label$/i]);
    const nameColumn = findColumn(columns, [/structname/i, /^name$/i]);
    const voxelColumn = findColumn(columns, [/nvoxels/i, /voxelcount/i]);
    const volumeColumn = findColumn(columns, [/volume.*mm3/i, /^volume$/i]);
    const areaColumn = findColumn(columns, [/surfarea/i, /area.*mm2/i]);
    const thicknessColumn = findColumn(columns, [/thickavg/i, /meanthickness/i]);
    const name = fields[nameColumn] ?? fields[0];
    rows.push({
      index: numeric(fields[indexColumn]),
      segmentationId: numeric(fields[idColumn]),
      name,
      voxelCount: numeric(fields[voxelColumn]),
      volumeMm3: numeric(fields[volumeColumn]),
      areaMm2: numeric(fields[areaColumn]),
      meanThicknessMm: numeric(fields[thicknessColumn]),
      hemisphere: /^(lh|left)[-_.]/i.test(name) ? "left" : /^(rh|right)[-_.]/i.test(name) ? "right" : null,
      values,
    });
  }
  return { columns, rows, measures };
}
