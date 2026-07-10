/**
 * Web Worker: computes Dice coefficient and mask statistics from two NIfTI mask URLs.
 * Runs in a separate thread to avoid blocking the main thread on 40M+ voxel arrays.
 *
 * Protocol:
 *   In:  { type: "compute"; urlA: string; urlB: string }
 *   Out: { type: "progress"; message: string }
 *       | { type: "result"; dice: number; intersection: number; aOnly: number; bOnly: number; totalForeground: number; dimsA: [number,number,number]; dimsB: [number,number,number] }
 *       | { type: "incompatible"; reason: string }
 *       | { type: "error"; message: string }
 */

async function readAllBytes(url: string): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  if (!resp.body) throw new Error("No response body");

  const isGzip = url.endsWith(".gz");
  let stream: ReadableStream<Uint8Array> = resp.body;
  if (isGzip) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stream = stream.pipeThrough(new DecompressionStream("gzip") as any);
  }

  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

interface NiftiInfo {
  dims: [number, number, number];
  voxOffset: number;
  datatype: number;
  bitpix: number;
}

function parseHeader(bytes: Uint8Array): NiftiInfo {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = true;
  const sizeofHdr = dv.getInt32(0, le);
  if (sizeofHdr !== 348) throw new Error(`Not NIfTI-1 (sizeof_hdr=${sizeofHdr})`);
  return {
    dims: [dv.getInt16(42, le), dv.getInt16(44, le), dv.getInt16(46, le)],
    voxOffset: dv.getFloat32(108, le),
    datatype: dv.getInt16(70, le),
    bitpix: dv.getInt16(72, le),
  };
}

function extractVoxels(bytes: Uint8Array, info: NiftiInfo): Uint8Array | Int16Array | Float32Array {
  const offset = Math.max(Math.round(info.voxOffset), 352);
  const slice = bytes.slice(offset);
  switch (info.datatype) {
    case 2:   return new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength);
    case 4:   return new Int16Array(slice.buffer, slice.byteOffset, slice.byteLength / 2);
    case 16:  return new Float32Array(slice.buffer, slice.byteOffset, slice.byteLength / 4);
    case 256: return new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength); // int8 → treat as uint8
    case 512: return new Uint16Array(slice.buffer, slice.byteOffset, slice.byteLength / 2) as unknown as Int16Array;
    default:  throw new Error(`Unsupported datatype ${info.datatype}`);
  }
}

self.addEventListener("message", async (evt: MessageEvent) => {
  const { type, urlA, urlB } = evt.data as { type: string; urlA: string; urlB: string };
  if (type !== "compute") return;

  try {
    self.postMessage({ type: "progress", message: "Fetching mask A…" });
    const bytesA = await readAllBytes(urlA);

    self.postMessage({ type: "progress", message: "Fetching mask B…" });
    const bytesB = await readAllBytes(urlB);

    self.postMessage({ type: "progress", message: "Parsing headers…" });
    const infoA = parseHeader(bytesA);
    const infoB = parseHeader(bytesB);

    // Geometry check
    if (
      infoA.dims[0] !== infoB.dims[0] ||
      infoA.dims[1] !== infoB.dims[1] ||
      infoA.dims[2] !== infoB.dims[2]
    ) {
      self.postMessage({
        type: "incompatible",
        reason: `Dimension mismatch: [${infoA.dims}] vs [${infoB.dims}]`,
      });
      return;
    }

    self.postMessage({ type: "progress", message: "Computing Dice…" });
    const voxA = extractVoxels(bytesA, infoA);
    const voxB = extractVoxels(bytesB, infoB);

    let intersection = 0;
    let aOnly = 0;
    let bOnly = 0;
    const len = Math.min(voxA.length, voxB.length);
    for (let i = 0; i < len; i++) {
      const inA = voxA[i] > 0;
      const inB = voxB[i] > 0;
      if (inA && inB) intersection++;
      else if (inA) aOnly++;
      else if (inB) bOnly++;
    }
    const totalForeground = intersection + aOnly + bOnly;
    const dice = totalForeground === 0
      ? 0
      : (2 * intersection) / (2 * intersection + aOnly + bOnly);

    self.postMessage({
      type: "result",
      dice,
      intersection,
      aOnly,
      bOnly,
      totalForeground,
      dimsA: infoA.dims,
      dimsB: infoB.dims,
    });
  } catch (err) {
    self.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
