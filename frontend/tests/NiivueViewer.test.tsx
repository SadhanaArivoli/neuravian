import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NeuroImageViewer, {
  calculateHistogram,
  defaultColormap,
  inferMapType,
} from "../src/components/domain/NeuroImageViewer";
import NiivuePanel from "../src/components/domain/NiivuePanel";
import NiivueViewer from "../src/components/domain/NiivueViewer";

const mocks = vi.hoisted(() => ({ instances: [] as Array<Record<string, unknown>> }));

vi.mock("@niivue/niivue", () => ({
  Niivue: vi.fn().mockImplementation(() => {
    const instance = {
      opts: { backColor: [0.07, 0.07, 0.07, 1], crosshairWidth: 0.5 },
      volumes: [] as Array<Record<string, unknown>>,
      volScaleMultiplier: 1,
      attachToCanvas: vi.fn(),
      loadVolumes: vi.fn().mockImplementation(async (options: Array<Record<string, unknown>>) => {
        instance.volumes = options.map((option, index) => ({
          id: `volume-${index}`,
          img: new Float32Array([-4, -2, 0, 1, 2, 4, 8, 12]),
          cal_min: -4,
          cal_max: 12,
          ...option,
        }));
      }),
      setOpacity: vi.fn(),
      setColormap: vi.fn(),
      setInterpolation: vi.fn(),
      setCrosshairColor: vi.fn(),
      setCrosshairWidth: vi.fn(),
      setSliceType: vi.fn(),
      setPan2Dxyzmm: vi.fn(),
      updateGLVolume: vi.fn(),
      drawScene: vi.fn(),
      cleanup: vi.fn(),
    };
    mocks.instances.push(instance);
    return instance;
  }),
  cmapper: { makeLabelLut: vi.fn().mockReturnValue({ lut: new Uint8ClampedArray(0) }) },
}));

const structural = [
  { url: "/api/datasets/5/files/sub-01/anat/sub-01_T1w.nii.gz", name: "sub-01_T1w.nii.gz" },
];

function latest() {
  return mocks.instances[mocks.instances.length - 1] as {
    setOpacity: ReturnType<typeof vi.fn>;
    setColormap: ReturnType<typeof vi.fn>;
    setInterpolation: ReturnType<typeof vi.fn>;
    setCrosshairWidth: ReturnType<typeof vi.fn>;
    setPan2Dxyzmm: ReturnType<typeof vi.fn>;
    loadVolumes: ReturnType<typeof vi.fn>;
    attachToCanvas: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  mocks.instances.length = 0;
  vi.clearAllMocks();
});

describe("shared NIfTI visualization semantics", () => {
  it("chooses structural, continuous, signed, and label defaults", () => {
    expect(defaultColormap(structural[0], 0, "anatomical")).toBe("gray");
    expect(defaultColormap(structural[0], 0, "alff")).toBe("inferno");
    expect(defaultColormap(structural[0], 0, "z_map")).toBe("blue2red");
    expect(defaultColormap({ ...structural[0], isSegmentation: true }, 0, "segmentation")).toBe("roi_i256");
    expect(inferMapType({ url: "/seed_connectivity_map.nii.gz", name: "seed_connectivity_map.nii.gz" })).toBe("z_map");
    expect(inferMapType({ url: "/sub-01_dseg.nii.gz", name: "sub-01_dseg.nii.gz" })).toBe("segmentation");
  });

  it("computes percentile indicators and a windowed histogram", () => {
    const histogram = calculateHistogram(Array.from({ length: 101 }, (_, index) => index), 25, 75);
    expect(histogram.p2).toBeCloseTo(2);
    expect(histogram.p98).toBeCloseTo(98);
    expect(histogram.bins.reduce((sum, count) => sum + count, 0)).toBe(51);
  });
});

describe("shared NIfTI viewer UI", () => {
  it("is the implementation used by both modal and inline shells", async () => {
    const modal = render(<NiivueViewer layers={structural} onClose={vi.fn()} />);
    expect(modal.getByTestId("shared-nifti-viewer")).toBeInTheDocument();
    await waitFor(() => expect(modal.getByTestId("visualization-controls")).toBeInTheDocument());
    modal.unmount();

    render(<NiivuePanel layers={structural} label="Anatomy" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Visualization ▾" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Visualization ▾" }));
    expect(screen.getByTestId("visualization-controls")).toBeInTheDocument();
  });

  it("updates colormap, opacity, windowing, interpolation, and reset live", async () => {
    render(<NeuroImageViewer layers={structural} label="ALFF" mapType="alff" modal />);
    await waitFor(() => expect(screen.getByLabelText("Colormap")).toBeInTheDocument());
    const nv = latest();

    fireEvent.change(screen.getByLabelText("Colormap"), { target: { value: "viridis" } });
    expect(nv.setColormap).toHaveBeenCalledWith("volume-0", "viridis");
    fireEvent.change(screen.getByLabelText("Overlay opacity"), { target: { value: "0.42" } });
    expect(nv.setOpacity).toHaveBeenCalledWith(0, 0.42);
    fireEvent.click(screen.getByRole("button", { name: "Robust 2–98%" }));
    expect(screen.getByTestId("intensity-histogram")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Nearest neighbor" }));
    expect(nv.setInterpolation).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: /Reset viewer/ }));
    expect(nv.setPan2Dxyzmm).toHaveBeenCalledWith([0, 0, 0, 1]);
  });

  it("uses nearest-neighbor interpolation automatically for label maps", async () => {
    render(<NeuroImageViewer layers={[{ ...structural[0], isSegmentation: true }]} label="Labels" mapType="segmentation" modal />);
    await waitFor(() => expect(latest().setInterpolation).toHaveBeenCalledWith(true));
    expect(screen.getByLabelText("Colormap")).toBeDisabled();
  });

  it("supports R, H, C, and I keyboard shortcuts", async () => {
    render(<NeuroImageViewer layers={structural} label="Stat map" mapType="t_map" modal />);
    await waitFor(() => expect(screen.getByTestId("intensity-histogram")).toBeInTheDocument());
    const nv = latest();
    fireEvent.keyDown(window, { key: "h" });
    expect(screen.queryByTestId("intensity-histogram")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "c" });
    expect(nv.setColormap).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "i" });
    expect(nv.setInterpolation).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "r" });
    expect(nv.setPan2Dxyzmm).toHaveBeenCalled();
  });

  it("rerenders a separate high-resolution canvas for PNG export", async () => {
    const toDataUrl = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL");
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["png"], { type: "image/png" })));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:export"), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(<NeuroImageViewer layers={structural} label="Publication map" modal />);
    await waitFor(() => expect(screen.getByLabelText("Export resolution")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Export resolution"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(mocks.instances).toHaveLength(2));
    const exportCanvas = latest().attachToCanvas.mock.calls[0][0] as HTMLCanvasElement;
    expect(exportCanvas.width).toBe(2560);
    expect(exportCanvas.height).toBe(1920);
    expect(toDataUrl).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("4× PNG rendered"));
  });

  it("closes via button, Escape, and modal backdrop", () => {
    const onClose = vi.fn();
    render(<NiivueViewer layers={structural} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close viewer"));
    fireEvent.keyDown(window, { key: "Escape" });
    const backdrop = screen.getByTestId("shared-nifti-viewer").parentElement?.parentElement;
    if (backdrop) fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
