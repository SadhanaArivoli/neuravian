/** Inline shell for the single shared NeuroForge NIfTI viewer. */
import type { Niivue } from "@niivue/niivue";
import NeuroImageViewer, { type NiivueLayer } from "./NeuroImageViewer";
import type { StatMapType } from "../../lib/niivueTheme";

export type { NiivueLayer };

interface Props {
  layers: NiivueLayer[];
  label: string;
  mapType?: StatMapType;
  multiplanar?: boolean;
  showColorbar?: boolean;
  pubMode?: boolean;
  onReady?: (nv: Niivue) => void;
  onUnmount?: () => void;
}

export default function NiivuePanel({
  layers,
  label,
  mapType,
  multiplanar = true,
  showColorbar = true,
  pubMode = false,
  onReady,
  onUnmount,
}: Props) {
  return (
    <NeuroImageViewer
      layers={layers}
      label={label}
      mapType={mapType}
      multiplanar={multiplanar}
      showColorbar={showColorbar}
      pubMode={pubMode}
      onReady={onReady}
      onUnmount={onUnmount}
    />
  );
}
