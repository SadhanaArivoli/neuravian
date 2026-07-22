import { act, renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeWorkspaceSelection, useWorkspace, WorkspaceProvider } from "../src/context/WorkspaceContext";

const profile: WorkspaceProfile = {
  id: "aws", name: "AWS Neuravian", serverUrl: "https://example.test",
  authenticationRef: null, serverIdentity: "server", lastSync: null, connectionState: "connected",
};

describe("normalizeWorkspaceSelection", () => {
  beforeEach(() => {
    localStorage.clear();
    window.neuravianDesktop = {
      getLocalWorkspaceIdentity: vi.fn(async () => ({
        schemaVersion: 1 as const,
        workspaceId: "local-installation",
        createdAt: "2026-07-18T00:00:00Z",
      })),
      listWorkspaces: vi.fn(async () => [profile]),
    } as unknown as typeof window.neuravianDesktop;
  });

  it("defaults to Local Neuravian", () => {
    expect(normalizeWorkspaceSelection(null, [profile])).toBe("local");
    expect(normalizeWorkspaceSelection("cloud:missing", [profile])).toBe("local");
  });

  it("restores local, all, and an existing cloud profile", () => {
    expect(normalizeWorkspaceSelection("local", [profile])).toBe("local");
    expect(normalizeWorkspaceSelection("all", [profile])).toBe("all");
    expect(normalizeWorkspaceSelection("cloud:aws", [profile])).toBe("cloud:aws");
  });

  it("persists workspace switching and restores it after a provider restart", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <WorkspaceProvider>{children}</WorkspaceProvider>;
    const first = renderHook(() => useWorkspace(), { wrapper });
    await waitFor(() => expect(first.result.current.local?.id).toBe("local-installation"));
    act(() => first.result.current.select("cloud:aws"));
    expect(localStorage.getItem("neuravian.desktop.selectedWorkspace")).toBe("cloud:aws");
    first.unmount();

    const restarted = renderHook(() => useWorkspace(), { wrapper });
    await waitFor(() => expect(restarted.result.current.selected).toBe("cloud:aws"));
    restarted.unmount();
  });

  it("keeps Local available when cloud discovery fails", async () => {
    vi.mocked(window.neuravianDesktop!.listWorkspaces).mockRejectedValue(new Error("cloud unavailable"));
    const wrapper = ({ children }: { children: ReactNode }) => <WorkspaceProvider>{children}</WorkspaceProvider>;
    const result = renderHook(() => useWorkspace(), { wrapper });
    await waitFor(() => expect(result.result.current.local?.id).toBe("local-installation"));
    expect(result.result.current.selected).toBe("local");
    result.unmount();
  });
});
