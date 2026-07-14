/** Modal shell for the single shared NeuroForge NIfTI viewer. */
import NeuroImageViewer, { type NiivueLayer } from "./NeuroImageViewer";
import type { StatMapType } from "../../lib/niivueTheme";

export type { NiivueLayer };

interface Props {
  layers: NiivueLayer[];
  mapType?: StatMapType;
  multiplanar?: boolean;
  onClose: () => void;
}

export default function NiivueViewer({ layers, mapType, multiplanar = true, onClose }: Props) {
  return (
    <NeuroImageViewer
      layers={layers}
      label={layers[0]?.name ?? "Scan"}
      mapType={mapType}
      multiplanar={multiplanar}
      modal
      onClose={onClose}
    />
  );
}
