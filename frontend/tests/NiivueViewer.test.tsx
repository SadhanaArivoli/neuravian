import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NeuroImageViewer, {
  calculateHistogram,
  defaultColormap,
  finiteScaledSamples,
  inferMapType,
} from "../src/components/domain/NeuroImageViewer";
import NiivuePanel from "../src/components/domain/NiivuePanel";
import NiivueViewer from "../src/components/domain/NiivueViewer";
import {
  computeDisplayStatistics,
  DISPLAY_PROFILES,
} from "../src/lib/scientificDisplayProfiles";

const mocks = vi.hoisted(() => ({
  instances: [] as Array<Record<string, unknown>>,
  volumeData: new Map<string, { img: ArrayLike<number>; slope: number; inter: number }>(),
}));

vi.mock("@niivue/niivue", () => ({
  Niivue: vi.fn().mockImplementation(() => {
    const instance = {
      opts: { backColor: [0.07, 0.07, 0.07, 1], crosshairWidth: 0.5 },
      volumes: [] as Array<Record<string, unknown>>,
      volScaleMultiplier: 1,
      scene: { crosshairPos: [0.5, 0.5, 0.5] },
      attachToCanvas: vi.fn(),
      loadVolumes: vi.fn().mockImplementation(async (options: Array<Record<string, unknown>>) => {
        instance.volumes = options.map((option, index) => {
          const configured = mocks.volumeData.get(String(option.url));
          const img = configured?.img ?? new Float32Array([-4, -2, 0, 1, 2, 4, 8, 12]);
          const slope = configured?.slope ?? 1;
          const inter = configured?.inter ?? 0;
          return {
            id: `volume-${index}`,
            img,
            hdr: { scl_slope: slope, scl_inter: inter },
            intensityRaw2Scaled: (raw: number) => raw * slope + inter,
            cal_min: -4,
            cal_max: 12,
            dims: [3, 64, 64, 40],
            pixDims: [1, 3, 3, 3],
            matRAS: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            permRAS: [1, 2, 3],
            ...option,
          };
        });
      }),
      setOpacity: vi.fn(),
      setColormap: vi.fn(),
      setColormapNegative: vi.fn(),
      setGamma: vi.fn(),
      setInterpolation: vi.fn(),
      setCrosshairColor: vi.fn(),
      setCrosshairWidth: vi.fn(),
      setSliceType: vi.fn(),
      setRadiologicalConvention: vi.fn(),
      setIsOrientationTextVisible: vi.fn(),
      mm2frac: vi.fn((value) => value.slice(0, 3)),
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
    setColormapNegative: ReturnType<typeof vi.fn>;
    setGamma: ReturnType<typeof vi.fn>;
    setInterpolation: ReturnType<typeof vi.fn>;
    setCrosshairWidth: ReturnType<typeof vi.fn>;
    setPan2Dxyzmm: ReturnType<typeof vi.fn>;
    setRadiologicalConvention: ReturnType<typeof vi.fn>;
    setIsOrientationTextVisible: ReturnType<typeof vi.fn>;
    setSliceType: ReturnType<typeof vi.fn>;
    mm2frac: ReturnType<typeof vi.fn>;
    loadVolumes: ReturnType<typeof vi.fn>;
    attachToCanvas: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  mocks.instances.length = 0;
  mocks.volumeData.clear();
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

  it("samples Run #4-style scaled int16 voxels in display-intensity space", () => {
    const slope = 1258 / 65535;
    const inter = 32768 * slope;
    const raw = new Int16Array([-32768, -32768, -20000, 0, 16384, 32767]);
    const scaled = finiteScaledSamples(raw, (value) => value * slope + inter);

    expect(scaled[0]).toBeCloseTo(0, 5);
    expect(scaled[scaled.length - 1]).toBeCloseTo(1258, 5);
    const statistics = computeDisplayStatistics(scaled, DISPLAY_PROFILES.structural);
    expect(statistics.displayMin).toBeGreaterThanOrEqual(0);
    expect(statistics.displayMax).toBeLessThanOrEqual(1258);
  });

  it("applies slope/intercept while preserving signed values and filtering non-finite samples", () => {
    expect(finiteScaledSamples(new Int16Array([-10, 0, 10]), (value) => value * 2 + 5)).toEqual([-15, 5, 25]);
    const signed = finiteScaledSamples(new Float32Array([-8, -2, 0, 3, 9]));
    const statistics = computeDisplayStatistics(signed, DISPLAY_PROFILES["signed-continuous"]);
    expect(statistics.displayMin).toBe(-statistics.displayMax);
    expect(statistics.displayMin).toBeLessThan(0);
    expect(finiteScaledSamples([0, Number.NaN, Number.POSITIVE_INFINITY, 0])).toEqual([0, 0]);
    expect(computeDisplayStatistics([0, 0], DISPLAY_PROFILES.structural).displayMax).toBe(1);
  });
});

describe("shared NIfTI viewer UI", () => {
  it("is the implementation used by both modal and inline shells", async () => {
    const modal = render(<NiivueViewer layers={structural} onClose={vi.fn()} />);
    expect(modal.getByTestId("shared-nifti-viewer")).toBeInTheDocument();
    await waitFor(() => expect(modal.getByRole("button", { name: "Visualization ▾" })).toBeInTheDocument());
    fireEvent.click(modal.getByRole("button", { name: "Visualization ▾" }));
    expect(modal.getByTestId("visualization-controls")).toBeInTheDocument();
    modal.unmount();

    render(<NiivuePanel layers={structural} label="Anatomy" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Visualization ▾" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Visualization ▾" }));
    expect(screen.getByTestId("visualization-controls")).toBeInTheDocument();
  });

  it("updates colormap, opacity, windowing, interpolation, and reset live", async () => {
    render(<NeuroImageViewer layers={structural} label="ALFF" mapType="alff" modal />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Visualization ▾" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Visualization ▾" }));
    const nv = latest();

    fireEvent.change(screen.getByLabelText("Colormap"), { target: { value: "viridis" } });
    expect(nv.setColormap).toHaveBeenCalledWith("volume-0", "viridis");
    fireEvent.change(screen.getByLabelText("Overlay opacity"), { target: { value: "0.42" } });
    expect(nv.setOpacity).toHaveBeenCalledWith(0, 0.42);
    fireEvent.click(screen.getByRole("button", { name: "Robust 2–98%" }));
    expect(screen.getByTestId("intensity-histogram")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Nearest" }));
    expect(nv.setInterpolation).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: /Reset viewer/ }));
    expect(nv.setPan2Dxyzmm).toHaveBeenCalledWith([0, 0, 0, 1]);
  });

  it("resets window state when a second volume with a different range loads", async () => {
    const firstUrl = "/api/runs/4/files/defaced.nii.gz";
    const secondUrl = "/api/datasets/1/files/sub-01/anat/sub-01_T1w.nii.gz";
    const slope = 1258 / 65535;
    mocks.volumeData.set(firstUrl, {
      img: new Int16Array([-32768, -20000, 0, 16384, 32767]),
      slope,
      inter: 32768 * slope,
    });
    mocks.volumeData.set(secondUrl, {
      img: new Int16Array([0, 100, 200, 300, 400]),
      slope: 1,
      inter: 0,
    });

    const view = render(<NeuroImageViewer layers={[{ url: firstUrl, name: "defaced.nii.gz" }]} label="Defaced" modal />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Visualization ▾" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Visualization ▾" }));
    await waitFor(() => expect(Number((screen.getByLabelText("Manual maximum") as HTMLInputElement).value)).toBeGreaterThan(1000));

    view.rerender(<NeuroImageViewer layers={[{ url: secondUrl, name: "sub-01_T1w.nii.gz" }]} label="Input T1w" modal />);
    await waitFor(() => expect(screen.getByLabelText("Manual maximum")).toHaveValue(394));
    expect(latest().loadVolumes).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ url: secondUrl }),
    ]));
  });

  it("uses nearest-neighbor interpolation automatically for label maps", async () => {
    render(<NeuroImageViewer layers={[{ ...structural[0], isSegmentation: true }]} label="Labels" mapType="segmentation" modal />);
    await waitFor(() => expect(latest().setInterpolation).toHaveBeenCalledWith(true));
    fireEvent.click(screen.getByRole("button", { name: "Visualization ▾" }));
    expect(screen.getByLabelText("Colormap")).toBeDisabled();
  });

  it("uses symmetric dual-tail rendering and transparent zero for signed maps", async () => {
    render(<NeuroImageViewer layers={[{
      url: "/api/runs/71/files/seed_connectivity_map.nii.gz",
      name: "seed_connectivity_map.nii.gz",
      artifactType: "seed_connectivity_map_nii",
      pipelineId: "seed-based-connectivity",
    }]} label="Seed connectivity" modal />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Visualization ▾" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Visualization ▾" }));
    const nv = latest();
    const volume = (nv.loadVolumes.mock.results[0] ? (mocks.instances[0].volumes as Array<Record<string, unknown>>)[0] : null);
    expect(nv.setColormap).toHaveBeenCalledWith("volume-0", "red");
    expect(nv.setColormapNegative).toHaveBeenCalledWith("volume-0", "blue");
    expect(volume?.cal_min).toBe(0);
    expect(volume?.cal_max).toBeCloseTo(11.52);
    expect(volume?.cal_minNeg).toBeCloseTo(-11.52);
    expect(volume?.cal_maxNeg).toBe(0);
    expect(volume?.colormapType).toBe(1);
    expect(screen.getByText("[Fisher z]")).toBeInTheDocument();
  });

  it("supplies a NIfTI filename hint for client-generated difference blobs", async () => {
    render(<NeuroImageViewer layers={[{
      url: "blob:http://localhost/difference-map",
      name: "Difference",
    }]} label="ALFF difference (B − A)" mapType="difference" />);
    await waitFor(() => expect(latest().loadVolumes).toHaveBeenCalled());
    expect(latest().loadVolumes.mock.calls[0][0][0]).toMatchObject({
      url: "blob:http://localhost/difference-map",
      name: "Difference.nii.gz",
    });
  });

  it("supports R, H, C, and I keyboard shortcuts", async () => {
    render(<NeuroImageViewer layers={structural} label="Stat map" mapType="t_map" modal />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Visualization ▾" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Visualization ▾" }));
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

  it("provides scientific tone, orientation, layout, and coordinate controls", async () => {
    render(<NeuroImageViewer layers={structural} label="Anatomy" mapType="anatomical" modal />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Visualization ▾" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Visualization ▾" }));
    const nv = latest();

    fireEvent.change(screen.getByLabelText("Gamma"), { target: { value: "1.5" } });
    expect(nv.setGamma).toHaveBeenLastCalledWith(1.5);
    fireEvent.click(screen.getByLabelText("Invert colormap"));
    fireEvent.click(screen.getByLabelText("Radiological convention"));
    expect(nv.setRadiologicalConvention).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByLabelText("Show orientation labels"));
    expect(nv.setIsOrientationTextVisible).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "sagittal" }));
    expect(nv.setSliceType).toHaveBeenLastCalledWith(2);
    fireEvent.change(screen.getByLabelText("Jump X coordinate"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(nv.mm2frac).toHaveBeenCalledWith([12, 0, 0, 1]);
  });

  it("gates anatomical underlays and exposes a shared multi-layer panel", async () => {
    render(<NeuroImageViewer layers={[
      structural[0],
      { url: "/api/runs/71/files/seed_connectivity_map.nii.gz", name: "Seed map", artifactType: "seed_connectivity_map_nii" },
    ]} label="Seed over anatomy" modal />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Visualization ▾" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Visualization ▾" }));
    expect(screen.getByTestId("layer-panel")).toBeInTheDocument();
    expect(screen.getByText(/Anatomical underlay enabled/)).toBeInTheDocument();
    expect(screen.getByText(/No resampling was performed/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Show Seed map"));
    expect(latest().setOpacity).toHaveBeenLastCalledWith(1, 0);
    expect(screen.getByRole("button", { name: "3D" })).toBeEnabled();
  });

  it("rerenders a separate high-resolution canvas for PNG export", async () => {
    const toDataUrl = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL");
    const drawImage = vi.fn();
    const fillText = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((type) => type === "2d" ? ({
      drawImage,
      fillText,
      measureText: vi.fn(() => ({ width: 80 })),
      fillStyle: "",
      font: "",
      shadowColor: "",
      shadowBlur: 0,
    } as unknown as CanvasRenderingContext2D) : null);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      const blob = new Blob(["png"], { type: "image/png" });
      Object.defineProperty(blob, "arrayBuffer", { value: async () => new Uint8Array([1, 2, 3]).buffer });
      callback(blob);
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:export"), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(<NeuroImageViewer layers={structural} label="Publication map" modal />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Visualization ▾" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Visualization ▾" }));
    fireEvent.change(screen.getByLabelText("Export resolution"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Export figure" }));
    await waitFor(() => expect(mocks.instances).toHaveLength(2));
    const exportCanvas = latest().attachToCanvas.mock.calls[0][0] as HTMLCanvasElement;
    expect(exportCanvas.width).toBe(2560);
    expect(exportCanvas.height).toBe(1920);
    expect(toDataUrl).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("4× PNG rendered (2560 × 1920px) · 300 DPI metadata"));
    expect(drawImage).toHaveBeenCalledWith(exportCanvas, 0, 0);
    expect(fillText).toHaveBeenCalledWith("Publication map", expect.any(Number), expect.any(Number));
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
