export interface VolumeGeometry {
  dimensions: number[];
  voxelSize: number[];
  affine: number[];
  orientation: number[];
  coordinateSpace?: string;
}

export interface CompatibilityResult {
  compatible: boolean;
  reason: string;
  spaceInferredFromAffine: boolean;
}

interface GeometrySource {
  dims?: number[];
  pixDims?: number[];
  matRAS?: ArrayLike<number>;
  permRAS?: number[];
}

function metadataSpace(metadata?: Record<string, unknown>) {
  if (!metadata) return undefined;
  const entry = Object.entries(metadata).find(([key, value]) =>
    /^(space|coordinate[_-]?space|output[_-]?space)$/i.test(key) && typeof value === "string"
  );
  return entry?.[1] as string | undefined;
}

export function volumeGeometry(
  volume: GeometrySource,
  metadata?: Record<string, unknown>,
): VolumeGeometry {
  const dimensions = (volume.dims ?? []).slice(1, 4).map(Number);
  const voxelSize = (volume.pixDims ?? []).slice(1, 4).map((value) => Math.abs(Number(value)));
  return {
    dimensions,
    voxelSize,
    affine: volume.matRAS ? Array.from(volume.matRAS, Number) : [],
    orientation: (volume.permRAS ?? []).slice(0, 3).map(Number),
    coordinateSpace: metadataSpace(metadata),
  };
}

function vectorsMatch(a: number[], b: number[], tolerance: number) {
  return a.length === b.length
    && a.length > 0
    && a.every((value, index) => Number.isFinite(value) && Math.abs(value - b[index]) <= tolerance);
}

export function checkVolumeCompatibility(
  underlay: VolumeGeometry,
  overlay: VolumeGeometry,
): CompatibilityResult {
  if (!vectorsMatch(underlay.dimensions, overlay.dimensions, 0)) {
    return { compatible: false, reason: "dimensions differ", spaceInferredFromAffine: false };
  }
  if (!vectorsMatch(underlay.voxelSize, overlay.voxelSize, 1e-3)) {
    return { compatible: false, reason: "voxel sizes differ", spaceInferredFromAffine: false };
  }
  if (!underlay.affine.length || !overlay.affine.length) {
    return { compatible: false, reason: "affine metadata is unavailable", spaceInferredFromAffine: false };
  }
  if (!vectorsMatch(underlay.affine, overlay.affine, 1e-3)) {
    return { compatible: false, reason: "affine transforms differ", spaceInferredFromAffine: false };
  }
  if (underlay.orientation.length && overlay.orientation.length
      && !vectorsMatch(underlay.orientation, overlay.orientation, 0)) {
    return { compatible: false, reason: "voxel orientations differ", spaceInferredFromAffine: false };
  }
  if (underlay.coordinateSpace && overlay.coordinateSpace
      && underlay.coordinateSpace.toLowerCase() !== overlay.coordinateSpace.toLowerCase()) {
    return { compatible: false, reason: `coordinate spaces differ (${underlay.coordinateSpace} vs ${overlay.coordinateSpace})`, spaceInferredFromAffine: false };
  }
  const inferred = !underlay.coordinateSpace || !overlay.coordinateSpace;
  return {
    compatible: true,
    reason: inferred
      ? "dimensions, voxel sizes, orientation, and affine match; coordinate space inferred from the matching affine"
      : `geometry and coordinate space (${underlay.coordinateSpace}) match`,
    spaceInferredFromAffine: inferred,
  };
}
