import { describe, expect, it } from "vitest";
import { MAX_MGH_BYTES, fetchRunScopedMgh, parseMgh } from "../src/lib/mgh";

function syntheticMgh(options: { dimensions?: [number, number, number, number]; type?: number } = {}) {
  const dimensions = options.dimensions ?? [2, 2, 1, 1];
  const type = options.type ?? 4;
  const bytesPerVoxel = type === 0 ? 1 : type === 4 ? 2 : 4;
  const buffer = new ArrayBuffer(284 + dimensions.reduce((a, b) => a * b, 1) * bytesPerVoxel);
  const view = new DataView(buffer);
  view.setInt32(0, 1, false);
  dimensions.forEach((value, index) => view.setInt32(4 + index * 4, value, false));
  view.setInt32(20, type, false);
  view.setInt16(28, 1, false);
  [1, 2, 3].forEach((value, index) => view.setFloat32(30 + index * 4, value, false));
  [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((value, index) => view.setFloat32(42 + index * 4, value, false));
  [10, 20, 30].forEach((value, index) => view.setFloat32(78 + index * 4, value, false));
  if (type === 4) [-2, 0, 7, 1258].forEach((value, index) => view.setInt16(284 + index * 2, value, false));
  return buffer;
}

describe("bounded MGH/MGZ volume parsing", () => {
  it("parses big-endian int16 data and RAS geometry", () => {
    const parsed = parseMgh(syntheticMgh());
    expect(parsed.dimensions).toEqual([2, 2, 1, 1]);
    expect(parsed.voxelSize).toEqual([1, 2, 3]);
    expect(parsed.datatypeCode).toBe(4);
    expect(Array.from(parsed.data)).toEqual([-2, 0, 7, 1258]);
    expect(parsed.affine).toHaveLength(16);
    expect(parsed.affine.every(Number.isFinite)).toBe(true);
    expect(parsed.affine).toEqual([1, 0, 0, 9, 0, 2, 0, 18, 0, 0, 3, 28.5, 0, 0, 0, 1]);
  });

  it.each([
    ["truncated header", new ArrayBuffer(12), "header is truncated"],
    ["unsupported version", (() => { const b = syntheticMgh(); new DataView(b).setInt32(0, 9, false); return b; })(), "Unsupported MGH version"],
    ["unsupported datatype", syntheticMgh({ type: 99 }), "Unsupported MGH datatype"],
    ["invalid dimension", syntheticMgh({ dimensions: [2, 2, 1, 1] }), "MGH dimensions"],
  ])("rejects %s", (_label, buffer, message) => {
    if (_label === "invalid dimension") new DataView(buffer as ArrayBuffer).setInt32(4, 0, false);
    expect(() => parseMgh(buffer as ArrayBuffer)).toThrow(message as string);
  });

  it("rejects a truncated voxel payload", () => {
    const buffer = syntheticMgh().slice(0, 286);
    expect(() => parseMgh(buffer)).toThrow("voxel payload is truncated");
  });

  it("exposes an explicit byte limit", () => {
    expect(MAX_MGH_BYTES).toBe(512 * 1024 * 1024);
  });

  it("refuses arbitrary remote or dataset URLs", async () => {
    await expect(fetchRunScopedMgh("https://example.test/scan.mgz")).rejects.toThrow("run-scoped");
    await expect(fetchRunScopedMgh("/api/datasets/1/files/scan.mgz")).rejects.toThrow("run-scoped");
  });
});
