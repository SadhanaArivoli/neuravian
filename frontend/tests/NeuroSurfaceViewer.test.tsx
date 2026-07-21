import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NeuroSurfaceViewer from "../src/components/domain/NeuroSurfaceViewer";
import { clearSurfaceCache } from "../src/lib/freesurferSurface";

const mocks = vi.hoisted(() => ({ instances: [] as Array<Record<string, unknown>> }));

vi.mock("@niivue/niivue", () => ({
  Niivue: vi.fn().mockImplementation(() => {
    const instance = {
      meshes: [{ id: "mesh-1" }],
      attachToCanvas: vi.fn(),
      loadMeshes: vi.fn().mockResolvedValue(undefined),
      setRenderAzimuthElevation: vi.fn(),
      meshShaderNames: vi.fn(() => ["Phong", "Toon"]),
      setMeshProperty: vi.fn(),
      setMeshShader: vi.fn(),
      drawScene: vi.fn(),
      cleanup: vi.fn(),
    };
    mocks.instances.push(instance);
    return instance;
  }),
}));

function fixture() {
  const comments = new TextEncoder().encode("fixture\nsafe\n");
  const buffer = new ArrayBuffer(3 + comments.length + 8 + 3 * 12 + 12);
  const bytes = new Uint8Array(buffer);
  bytes.set([0xff, 0xff, 0xfe]);
  bytes.set(comments, 3);
  const view = new DataView(buffer);
  view.setInt32(3 + comments.length, 3, false);
  view.setInt32(7 + comments.length, 1, false);
  return buffer;
}

beforeEach(() => {
  mocks.instances.length = 0;
  clearSurfaceCache();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(fixture())));
});

describe("shared surface viewer", () => {
  it("loads a validated run-scoped surface and exposes scientific controls", async () => {
    render(<NeuroSurfaceViewer surface={{ url: "/api/runs/7/files/subject/surf/lh.white", name: "lh.white", hemisphere: "left" }} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText("Loading surface…")).not.toBeInTheDocument());
    expect(screen.getByText("3 vertices")).toBeInTheDocument();
    expect(screen.getByText("1 faces")).toBeInTheDocument();
    const nv = mocks.instances[0] as { setRenderAzimuthElevation: ReturnType<typeof vi.fn>; setMeshProperty: ReturnType<typeof vi.fn> };
    fireEvent.click(screen.getByRole("button", { name: "dorsal" }));
    expect(nv.setRenderAzimuthElevation).toHaveBeenLastCalledWith(0, 90);
    fireEvent.change(screen.getByLabelText("Surface opacity"), { target: { value: "0.4" } });
    expect(nv.setMeshProperty).toHaveBeenCalledWith("mesh-1", "opacity", 0.4);
  });

  it("cleans up WebGL resources when closed", async () => {
    const onUnmount = vi.fn();
    const view = render(<NeuroSurfaceViewer surface={{ url: "/api/runs/7/files/subject/surf/rh.pial", name: "rh.pial", hemisphere: "right" }} onClose={vi.fn()} onUnmount={onUnmount} />);
    await waitFor(() => expect(screen.queryByText("Loading surface…")).not.toBeInTheDocument());
    const nv = mocks.instances[0] as { cleanup: ReturnType<typeof vi.fn> };
    view.unmount();
    expect(nv.cleanup).toHaveBeenCalledOnce();
    expect(onUnmount).toHaveBeenCalledOnce();
  });

  it("shows a useful error and never calls NiiVue for malformed surfaces", async () => {
    clearSurfaceCache();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4])));
    render(<NeuroSurfaceViewer surface={{ url: "/api/runs/7/files/subject/surf/bad.white", name: "bad.white" }} onClose={vi.fn()} />);
    expect(await screen.findByText(/surface is truncated/i)).toBeInTheDocument();
    expect(mocks.instances).toHaveLength(0);
  });
});
