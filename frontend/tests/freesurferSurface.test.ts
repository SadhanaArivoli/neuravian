import { describe, expect, it } from "vitest";
import { fetchRunScopedSurface, validateFreeSurferSurface } from "../src/lib/freesurferSurface";

function surface(vertices = 3, faces = 1) {
  const comments = new TextEncoder().encode("fixture\ncreated safely\n");
  const buffer = new ArrayBuffer(3 + comments.length + 8 + vertices * 12 + faces * 12);
  const bytes = new Uint8Array(buffer);
  bytes.set([0xff, 0xff, 0xfe], 0);
  bytes.set(comments, 3);
  const offset = 3 + comments.length;
  const view = new DataView(buffer);
  view.setInt32(offset, vertices, false);
  view.setInt32(offset + 4, faces, false);
  return buffer;
}

describe("FreeSurfer surface safety", () => {
  it("validates a bounded triangle fixture", () => {
    expect(validateFreeSurferSurface(surface())).toMatchObject({ vertexCount: 3, faceCount: 1 });
  });

  it.each([
    ["truncated", new ArrayBuffer(5), "truncated"],
    ["bad magic", (() => { const b = surface(); new Uint8Array(b)[0] = 0; return b; })(), "magic"],
    ["bad offset", surface(3, 2).slice(0, -12), "offsets exceed"],
    ["zero vertices", surface(0, 1), "vertex count"],
  ])("rejects %s surface", (_label, buffer, message) => {
    expect(() => validateFreeSurferSurface(buffer as ArrayBuffer)).toThrow(message as string);
  });

  it("rejects arbitrary URLs before fetching", async () => {
    await expect(fetchRunScopedSurface("https://example.test/lh.pial")).rejects.toThrow("run-scoped");
  });
});
