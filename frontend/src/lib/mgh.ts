export const MAX_MGH_BYTES = 512 * 1024 * 1024;
export const MAX_MGH_VOXELS = 256 * 1024 * 1024;
const MGH_HEADER_BYTES = 284;

export interface ParsedMgh {
  dimensions: [number, number, number, number];
  voxelSize: [number, number, number];
  affine: number[];
  datatypeCode: 2 | 4 | 8 | 16 | 768;
  data: Uint8Array | Int16Array | Int32Array | Float32Array | Uint32Array;
}

function checkedProduct(values: number[]) {
  let total = 1;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value <= 0 || total > MAX_MGH_VOXELS / value) {
      throw new Error("MGH dimensions exceed the safe voxel limit.");
    }
    total *= value;
  }
  return total;
}

function multiply3x3Vector(matrix: number[], vector: number[]) {
  return [0, 1, 2].map((row) =>
    matrix[row] * vector[0] + matrix[row + 3] * vector[1] + matrix[row + 6] * vector[2]
  );
}

export function parseMgh(arrayBuffer: ArrayBuffer): ParsedMgh {
  if (arrayBuffer.byteLength < MGH_HEADER_BYTES) throw new Error("MGH header is truncated.");
  if (arrayBuffer.byteLength > MAX_MGH_BYTES) throw new Error("MGH file exceeds the 512 MiB viewer limit.");
  const view = new DataView(arrayBuffer);
  const version = view.getInt32(0, false);
  if (version !== 1) throw new Error(`Unsupported MGH version ${version}.`);
  const dimensions = [4, 8, 12, 16].map((offset) => view.getInt32(offset, false)) as [number, number, number, number];
  const voxelCount = checkedProduct(dimensions);
  const type = view.getInt32(20, false);
  const typeInfo = {
    0: { bytes: 1, nifti: 2 as const },
    1: { bytes: 4, nifti: 8 as const },
    2: { bytes: 4, nifti: 768 as const },
    3: { bytes: 4, nifti: 16 as const },
    4: { bytes: 2, nifti: 4 as const },
  }[type as 0 | 1 | 2 | 3 | 4];
  if (!typeInfo) throw new Error(`Unsupported MGH datatype ${type}.`);
  const expectedBytes = voxelCount * typeInfo.bytes;
  if (!Number.isSafeInteger(expectedBytes) || MGH_HEADER_BYTES + expectedBytes > arrayBuffer.byteLength) {
    throw new Error("MGH voxel payload is truncated or inconsistent with its header.");
  }

  const rasGood = view.getInt16(28, false) > 0;
  const voxelSize: [number, number, number] = rasGood
    ? [view.getFloat32(30, false), view.getFloat32(34, false), view.getFloat32(38, false)]
    : [1, 1, 1];
  if (voxelSize.some((value) => !Number.isFinite(value) || value <= 0 || value > 100)) {
    throw new Error("MGH voxel sizes are invalid.");
  }
  const direction = rasGood
    ? Array.from({ length: 9 }, (_, index) => view.getFloat32(42 + index * 4, false))
    : [-1, 0, 0, 0, 0, 1, 0, -1, 0];
  const center = rasGood
    ? [view.getFloat32(78, false), view.getFloat32(82, false), view.getFloat32(86, false)]
    : [0, 0, 0];
  if ([...direction, ...center].some((value) => !Number.isFinite(value))) {
    throw new Error("MGH RAS geometry contains non-finite values.");
  }
  // MGH stores one direction-cosine vector per voxel axis. Transpose this
  // axis-major representation into the row-major scanner-RAS affine.
  const scaledDirection = direction.map((value, index) => value * voxelSize[Math.floor(index / 3)]);
  const voxelCenter = dimensions.slice(0, 3).map((value) => value / 2);
  const offsetAtCenter = multiply3x3Vector(scaledDirection, voxelCenter);
  const origin = center.map((value, index) => value - offsetAtCenter[index]);
  const affine = [
    scaledDirection[0], scaledDirection[3], scaledDirection[6], origin[0],
    scaledDirection[1], scaledDirection[4], scaledDirection[7], origin[1],
    scaledDirection[2], scaledDirection[5], scaledDirection[8], origin[2],
    0, 0, 0, 1,
  ];

  let data: ParsedMgh["data"];
  const offset = MGH_HEADER_BYTES;
  if (type === 0) {
    data = new Uint8Array(arrayBuffer.slice(offset, offset + expectedBytes));
  } else if (type === 4) {
    data = new Int16Array(voxelCount);
    for (let index = 0; index < voxelCount; index += 1) data[index] = view.getInt16(offset + index * 2, false);
  } else if (type === 3) {
    data = new Float32Array(voxelCount);
    for (let index = 0; index < voxelCount; index += 1) data[index] = view.getFloat32(offset + index * 4, false);
  } else if (type === 2) {
    data = new Uint32Array(voxelCount);
    for (let index = 0; index < voxelCount; index += 1) data[index] = view.getUint32(offset + index * 4, false);
  } else {
    data = new Int32Array(voxelCount);
    for (let index = 0; index < voxelCount; index += 1) data[index] = view.getInt32(offset + index * 4, false);
  }
  return { dimensions, voxelSize, affine, datatypeCode: typeInfo.nifti, data };
}

export function isMghPath(name: string) {
  return /\.(mgh|mgz)$/i.test(name);
}

export async function decompressMgz(buffer: ArrayBuffer) {
  if (buffer.byteLength > MAX_MGH_BYTES) throw new Error("MGZ file exceeds the 512 MiB viewer limit.");
  const magic = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) return buffer;
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress MGZ files. Download remains available.");
  }
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  const decompressed = await new Response(stream).arrayBuffer();
  if (decompressed.byteLength > MAX_MGH_BYTES) throw new Error("Decompressed MGZ exceeds the 512 MiB viewer limit.");
  return decompressed;
}

const mghFetchCache = new Map<string, Promise<ArrayBuffer>>();

export function fetchRunScopedMgh(url: string, signal?: AbortSignal) {
  if (!/^\/api\/runs\/\d+\/files\//.test(url)) {
    return Promise.reject(new Error("MGH loading is restricted to run-scoped artifact URLs."));
  }
  let cached = mghFetchCache.get(url);
  if (!cached) {
    cached = fetch(url, { signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Artifact request failed (${response.status}).`);
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > MAX_MGH_BYTES) throw new Error("MGH artifact exceeds the 512 MiB viewer limit.");
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_MGH_BYTES) throw new Error("MGH artifact exceeds the 512 MiB viewer limit.");
      return buffer;
    }).catch((error) => {
      mghFetchCache.delete(url);
      throw error;
    });
    mghFetchCache.set(url, cached);
  }
  return cached;
}

export function clearMghFetchCache() {
  mghFetchCache.clear();
}
