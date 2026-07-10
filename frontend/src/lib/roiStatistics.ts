export interface RoiStatistic {
  roi_number: number;
  roi_label: string;
  network: string | null;
  voxel_count: number;
  mean_signal: number;
  std_signal: number;
  min_signal: number;
  max_signal: number;
  median_signal: number;
}

export type RoiSortKey = keyof RoiStatistic;
export type SortDirection = "asc" | "desc";

export interface RoiMeanDifference {
  roi_number: number;
  roi_label: string;
  network: string | null;
  mean_a: number;
  mean_b: number;
  difference: number;
  abs_difference: number;
}

export interface RoiStatisticsComparison {
  count: number;
  meanDifference: number;
  meanAbsoluteDifference: number;
  largestDifferences: RoiMeanDifference[];
}

const ROI_COLUMNS: Array<keyof RoiStatistic> = [
  "roi_number",
  "roi_label",
  "network",
  "voxel_count",
  "mean_signal",
  "std_signal",
  "min_signal",
  "max_signal",
  "median_signal",
];

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function toNumber(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRow(row: Partial<Record<keyof RoiStatistic, unknown>>): RoiStatistic {
  return {
    roi_number: toNumber(row.roi_number as string | number | null | undefined),
    roi_label: String(row.roi_label ?? ""),
    network: row.network === undefined || row.network === null || row.network === ""
      ? null
      : String(row.network),
    voxel_count: toNumber(row.voxel_count as string | number | null | undefined),
    mean_signal: toNumber(row.mean_signal as string | number | null | undefined),
    std_signal: toNumber(row.std_signal as string | number | null | undefined),
    min_signal: toNumber(row.min_signal as string | number | null | undefined),
    max_signal: toNumber(row.max_signal as string | number | null | undefined),
    median_signal: toNumber(row.median_signal as string | number | null | undefined),
  };
}

export function normalizeRoiStatisticsJson(value: unknown): RoiStatistic[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => normalizeRow(row as Partial<Record<keyof RoiStatistic, unknown>>));
}

export function parseRoiStatisticsCsv(text: string): RoiStatistic[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((header) => header.trim()) as Array<keyof RoiStatistic>;
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Partial<Record<keyof RoiStatistic, string>> = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? "";
    });
    return normalizeRow(row);
  });
}

export function filterRoiStatistics(
  rows: RoiStatistic[],
  query: string,
  network: string,
): RoiStatistic[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    const matchesNetwork = !network || (row.network ?? "Unassigned") === network;
    const matchesQuery =
      !q ||
      row.roi_label.toLowerCase().includes(q) ||
      String(row.roi_number).includes(q) ||
      (row.network ?? "").toLowerCase().includes(q);
    return matchesNetwork && matchesQuery;
  });
}

export function sortRoiStatistics(
  rows: RoiStatistic[],
  key: RoiSortKey,
  direction: SortDirection,
): RoiStatistic[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === "number" && typeof bv === "number") {
      return (av - bv) * multiplier;
    }
    return String(av ?? "").localeCompare(String(bv ?? "")) * multiplier;
  });
}

function escapeCsv(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function roiStatisticsToCsv(rows: RoiStatistic[]): string {
  return [
    ROI_COLUMNS.join(","),
    ...rows.map((row) => ROI_COLUMNS.map((key) => escapeCsv(row[key])).join(",")),
  ].join("\n");
}

export function compareRoiStatistics(
  a: RoiStatistic[],
  b: RoiStatistic[],
): RoiStatisticsComparison {
  const bByLabel = new Map(b.map((row) => [row.roi_label, row]));
  const rows = a
    .map((row) => {
      const other = bByLabel.get(row.roi_label);
      if (!other) return null;
      const difference = row.mean_signal - other.mean_signal;
      return {
        roi_number: row.roi_number,
        roi_label: row.roi_label,
        network: row.network,
        mean_a: row.mean_signal,
        mean_b: other.mean_signal,
        difference,
        abs_difference: Math.abs(difference),
      };
    })
    .filter((row): row is RoiMeanDifference => row !== null);
  const sum = rows.reduce((acc, row) => acc + row.difference, 0);
  const absSum = rows.reduce((acc, row) => acc + row.abs_difference, 0);
  return {
    count: rows.length,
    meanDifference: rows.length ? sum / rows.length : 0,
    meanAbsoluteDifference: rows.length ? absSum / rows.length : 0,
    largestDifferences: rows
      .sort((left, right) => right.abs_difference - left.abs_difference)
      .slice(0, 10),
  };
}
