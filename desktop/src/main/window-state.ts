import { readFile, writeFile } from "node:fs/promises";

export interface WindowBounds { x?: number; y?: number; width: number; height: number }
const defaults: WindowBounds = { width: 1180, height: 800 };

export async function loadWindowBounds(filePath: string): Promise<WindowBounds> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<WindowBounds>;
    if (!Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) return defaults;
    return {
      width: Math.max(1024, Number(parsed.width)),
      height: Math.max(700, Number(parsed.height)),
      ...(Number.isFinite(parsed.x) ? { x: Number(parsed.x) } : {}),
      ...(Number.isFinite(parsed.y) ? { y: Number(parsed.y) } : {}),
    };
  } catch {
    return defaults;
  }
}

export async function saveWindowBounds(filePath: string, bounds: WindowBounds): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(bounds, null, 2)}\n`, { mode: 0o600 });
}
