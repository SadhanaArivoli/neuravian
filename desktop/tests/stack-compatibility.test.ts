import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DesktopCompose } from "../src/main/compose.js";

const root = path.join(os.tmpdir(), "neuravian-stack-fixture");
const ctx = {
  resourcesRoot: root,
  dataDir: path.join(root, "data"),
  dockerResourcesDir: root,
  datasetsDir: path.join(root, "datasets"),
  packaged: true,
};
const images = {
  backend: "ghcr.io/sadhanaarivoli/neuravian-backend:0.1.0",
  frontend: "ghcr.io/sadhanaarivoli/neuravian-frontend:0.1.0",
};
const imageIds = { backend: "sha256:backend-current", frontend: "sha256:frontend-current" };
const hashes = { backend: "backend-config", frontend: "frontend-config" };

function commandFor(options: {
  containers?: Array<{ service: "backend" | "frontend"; imageId?: string; configHash?: string; status?: string }>;
} = {}) {
  const containers = options.containers ?? [];
  return vi.fn(async (_command: string, args: readonly string[]) => {
    const joined = args.join(" ");
    if (joined.includes("config --format json")) {
      return { stdout: JSON.stringify({ services: { backend: { image: images.backend }, frontend: { image: images.frontend } } }), stderr: "", exitCode: 0 };
    }
    if (args[0] === "ps") {
      return { stdout: containers.map((item) => `${item.service}-id`).join("\n"), stderr: "", exitCode: 0 };
    }
    if (joined.includes("config --hash *")) {
      return { stdout: `backend ${hashes.backend}\nfrontend ${hashes.frontend}`, stderr: "", exitCode: 0 };
    }
    if (args[0] === "inspect") {
      return {
        stdout: JSON.stringify(containers.map((item) => ({
          Id: `${item.service}-id`, Image: item.imageId ?? imageIds[item.service],
          Config: { Image: images[item.service], Labels: {
            "com.docker.compose.project": "neuravian-desktop",
            "com.docker.compose.service": item.service,
            "com.docker.compose.config-hash": item.configHash ?? hashes[item.service],
          } },
          State: { Status: item.status ?? "running" },
        }))), stderr: "", exitCode: 0,
      };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      const service = args[2] === images.backend ? "backend" : "frontend";
      return { stdout: JSON.stringify([{ Id: imageIds[service] }]), stderr: "", exitCode: 0 };
    }
    throw new Error(`Unexpected Docker command: ${joined}`);
  });
}

describe("managed Compose stack compatibility", () => {
  it("reports no managed stack when no containers are running or stopped", async () => {
    const stack = await new DesktopCompose(ctx, commandFor(), "/usr/local/bin/docker").inspectStack();
    expect(stack).toMatchObject({ detected: false, compatible: false, expectedVersion: "0.1.0" });
  });

  it("accepts the exact current backend and frontend stack", async () => {
    const stack = await new DesktopCompose(ctx, commandFor({ containers: [{ service: "backend" }, { service: "frontend" }] }), "/usr/local/bin/docker").inspectStack();
    expect(stack).toMatchObject({ detected: true, compatible: true, running: true, reasons: [] });
  });

  it.each([
    ["frontend", "sha256:frontend-old", "frontend image ID differs"],
    ["backend", "sha256:backend-old", "backend image ID differs"],
  ] as const)("rejects a stale %s image", async (service, staleId, reason) => {
    const stack = await new DesktopCompose(ctx, commandFor({ containers: [
      { service: "backend", imageId: service === "backend" ? staleId : undefined },
      { service: "frontend", imageId: service === "frontend" ? staleId : undefined },
    ] }), "/usr/local/bin/docker").inspectStack();
    expect(stack.compatible).toBe(false);
    expect(stack.reasons).toContain(reason);
  });

  it("rejects changed Compose configuration", async () => {
    const stack = await new DesktopCompose(ctx, commandFor({ containers: [
      { service: "backend", configHash: "old-config" }, { service: "frontend" },
    ] }), "/usr/local/bin/docker").inspectStack();
    expect(stack.reasons).toContain("backend Compose configuration differs");
  });

  it("detects stopped old Neuravian containers", async () => {
    const stack = await new DesktopCompose(ctx, commandFor({ containers: [
      { service: "backend", status: "exited", imageId: "sha256:backend-old" },
      { service: "frontend", status: "exited", imageId: "sha256:frontend-old" },
    ] }), "/usr/local/bin/docker").inspectStack();
    expect(stack).toMatchObject({ detected: true, compatible: false, running: false });
  });
});
