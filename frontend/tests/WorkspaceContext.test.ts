import { describe, expect, it } from "vitest";
import { normalizeWorkspaceSelection } from "../src/context/WorkspaceContext";

const profile: WorkspaceProfile = {
  id: "aws", name: "AWS NeuroForge", serverUrl: "https://example.test",
  authenticationRef: null, serverIdentity: "server", lastSync: null, connectionState: "connected",
};

describe("normalizeWorkspaceSelection", () => {
  it("defaults to Local NeuroForge", () => {
    expect(normalizeWorkspaceSelection(null, [profile])).toBe("local");
    expect(normalizeWorkspaceSelection("cloud:missing", [profile])).toBe("local");
  });

  it("restores local, all, and an existing cloud profile", () => {
    expect(normalizeWorkspaceSelection("local", [profile])).toBe("local");
    expect(normalizeWorkspaceSelection("all", [profile])).toBe("all");
    expect(normalizeWorkspaceSelection("cloud:aws", [profile])).toBe("cloud:aws");
  });
});
