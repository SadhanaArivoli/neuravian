/**
 * Lightweight NIfTI-1 header parser.
 *
 * Reads only the first 348 bytes of a (possibly gzip-compressed) NIfTI file.
 * Uses the browser's built-in DecompressionStream — no extra dependencies.
 *
 * NIfTI-1 spec: https://nifti.nimh.nih.gov/pub/dist/src/niftilib/nifti1.h
 */

export interface NiftiHeader {
  /** Spatial dimensions [nx, ny, nz] */
  dims: [number, number, number];
  /** Voxel sizes in mm [dx, dy, dz] */
  pixdim: [number, number, number];
  /** NIfTI datatype code (2=uint8, 4=int16, 16=float32, …) */
  datatype: number;
  /** Bits per voxel */
  bitpix: number;
  /** qform_code */
  qformCode: number;
  /** sform_code */
  sformCode: number;
  /** Byte offset to start of voxel data */
  voxOffset: number;
}

export const DATATYPE_LABELS: Record<number, string> = {
  2: "uint8",
  4: "int16",
  8: "int32",
  16: "float32",
  64: "float64",
  256: "int8",
  512: "uint16",
  768: "uint32",
};

/** Read the first `n` bytes from a URL, decompressing gzip if needed. */
async function readFirstBytes(url: string, n: number): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  if (!resp.body) throw new Error("No response body");

  const isGzip = url.endsWith(".gz") || (resp.headers.get("content-type") ?? "").includes("gzip");
  let stream: ReadableStream<Uint8Array> = resp.body;
  if (isGzip) {
    // DecompressionStream is available in all modern browsers (Chrome 80+, Firefox 113+, Safari 16.4+)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stream = stream.pipeThrough(new DecompressionStream("gzip") as any);
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let collected = 0;
  try {
    while (collected < n) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      collected += value.length;
    }
  } finally {
    await reader.cancel();
  }

  const out = new Uint8Array(n);
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, n - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= n) break;
  }
  return out;
}

export async function loadFloat32Nifti(url: string): Promise<{ header: NiftiHeader; values: Float32Array; bytes: Uint8Array }> {
  const resp = await fetch(url);
  if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  let stream: ReadableStream<Uint8Array> = resp.body;
  if (url.endsWith(".gz")) stream = stream.pipeThrough(new DecompressionStream("gzip") as never);
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getInt32(0, true) !== 348) throw new Error("Not a valid little-endian NIfTI-1 file");
  const header: NiftiHeader = { dims:[dv.getInt16(42,true),dv.getInt16(44,true),dv.getInt16(46,true)], pixdim:[dv.getFloat32(80,true),dv.getFloat32(84,true),dv.getFloat32(88,true)], datatype:dv.getInt16(70,true), bitpix:dv.getInt16(72,true), qformCode:dv.getInt16(252,true), sformCode:dv.getInt16(254,true), voxOffset:dv.getFloat32(108,true) };
  if (header.datatype !== 16) throw new Error(`ALFF comparison requires float32 NIfTI maps; found datatype ${header.datatype}`);
  const n = header.dims[0]*header.dims[1]*header.dims[2];
  const start = Math.floor(header.voxOffset);
  return { header, values: new Float32Array(bytes.buffer.slice(bytes.byteOffset+start, bytes.byteOffset+start+n*4)), bytes };
}

export function differenceNiftiBlobUrl(source: Uint8Array, voxOffset: number, difference: Float32Array): string {
  const bytes = source.slice();
  const start = Math.floor(voxOffset);
  new Uint8Array(bytes.buffer, start, difference.byteLength).set(new Uint8Array(difference.buffer));
  return URL.createObjectURL(new Blob([bytes], {type:"application/octet-stream"}));
}

/**
 * Parse the NIfTI-1 header from a URL.
 * Works with both `.nii` and `.nii.gz` files.
 */
export async function parseNiftiHeader(url: string): Promise<NiftiHeader> {
  const bytes = await readFirstBytes(url, 348);
  const dv = new DataView(bytes.buffer);
  const le = true; // NIfTI-1 is little-endian on most systems; check sizeof_hdr

  // Validate: sizeof_hdr should be 348 for NIfTI-1
  const sizeofHdr = dv.getInt32(0, le);
  if (sizeofHdr !== 348) {
    throw new Error(`Not a valid NIfTI-1 file (sizeof_hdr=${sizeofHdr})`);
  }

  return {
    // dim[1], dim[2], dim[3] at bytes 42, 44, 46 (short int16)
    dims: [dv.getInt16(42, le), dv.getInt16(44, le), dv.getInt16(46, le)],
    // pixdim[1], pixdim[2], pixdim[3] at bytes 80, 84, 88 (float)
    pixdim: [dv.getFloat32(80, le), dv.getFloat32(84, le), dv.getFloat32(88, le)],
    datatype: dv.getInt16(70, le),
    bitpix: dv.getInt16(72, le),
    qformCode: dv.getInt16(252, le),
    sformCode: dv.getInt16(254, le),
    voxOffset: dv.getFloat32(108, le),
  };
}
