export const MAX_SURFACE_BYTES = 256 * 1024 * 1024;
export const MAX_SURFACE_VERTICES = 10_000_000;
export const MAX_SURFACE_FACES = 20_000_000;
const TRIANGLE_MAGIC = 0xfffffe;

export interface FreeSurferSurfaceHeader {
  vertexCount: number;
  faceCount: number;
  dataOffset: number;
}

function int24(view: DataView, offset: number) {
  return (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2);
}

function nextLine(bytes: Uint8Array, start: number) {
  for (let index = start; index < bytes.length; index += 1) {
    if (bytes[index] === 10) return index + 1;
  }
  throw new Error("FreeSurfer surface comment header is truncated.");
}

export function validateFreeSurferSurface(buffer: ArrayBuffer): FreeSurferSurfaceHeader {
  if (buffer.byteLength > MAX_SURFACE_BYTES) throw new Error("Surface exceeds the 256 MiB viewer limit.");
  if (buffer.byteLength < 16) throw new Error("FreeSurfer surface is truncated.");
  const view = new DataView(buffer);
  if (int24(view, 0) !== TRIANGLE_MAGIC) throw new Error("Unsupported or malformed FreeSurfer surface magic.");
  const bytes = new Uint8Array(buffer);
  const afterCreateStamp = nextLine(bytes, 3);
  const dataOffset = nextLine(bytes, afterCreateStamp);
  if (dataOffset + 8 > buffer.byteLength) throw new Error("FreeSurfer surface counts are truncated.");
  const vertexCount = view.getInt32(dataOffset, false);
  const faceCount = view.getInt32(dataOffset + 4, false);
  if (vertexCount <= 0 || vertexCount > MAX_SURFACE_VERTICES) throw new Error("FreeSurfer vertex count is outside the safe limit.");
  if (faceCount <= 0 || faceCount > MAX_SURFACE_FACES) throw new Error("FreeSurfer face count is outside the safe limit.");
  const expected = dataOffset + 8 + vertexCount * 12 + faceCount * 12;
  if (!Number.isSafeInteger(expected) || expected > buffer.byteLength) throw new Error("FreeSurfer surface offsets exceed the file length.");
  return { vertexCount, faceCount, dataOffset: dataOffset + 8 };
}

const surfaceCache = new Map<string, Promise<ArrayBuffer>>();

export function fetchRunScopedSurface(url: string, signal?: AbortSignal) {
  if (!/^\/api\/runs\/\d+\/files\//.test(url)) return Promise.reject(new Error("Surface loading is restricted to run-scoped artifact URLs."));
  let cached = surfaceCache.get(url);
  if (!cached) {
    cached = fetch(url, { signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Artifact request failed (${response.status}).`);
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > MAX_SURFACE_BYTES) throw new Error("Surface exceeds the 256 MiB viewer limit.");
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_SURFACE_BYTES) throw new Error("Surface exceeds the 256 MiB viewer limit.");
      return buffer;
    }).catch((error) => { surfaceCache.delete(url); throw error; });
    surfaceCache.set(url, cached);
  }
  return cached;
}

export function clearSurfaceCache() {
  surfaceCache.clear();
}
