/**
 * Regression tests for DesktopCompose.pull() and the commit-pinned image references it resolves
 * from release.json. These exist because a movable version tag (`:0.1.0`) let `docker compose
 * pull` silently overwrite a freshly-built local image with an older published one — see
 * compose.ts imageReferences()/pull() for the fix: pull is now conditional per exact image
 * reference, and that reference is always the immutable commit tag, never the version tag.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandError } from "../src/main/command.js";
import { DesktopCompose } from "../src/main/compose.js";

const COMMIT = "33862122b48c361ade523e3570bcf39b927a5e56";
const FRONTEND_COMMIT_REF = `ghcr.io/sadhanaarivoli/neuravian-frontend:${COMMIT}`;
const BACKEND_COMMIT_REF = `ghcr.io/sadhanaarivoli/neuravian-backend:${COMMIT}`;
const FRONTEND_VERSION_REF = "ghcr.io/sadhanaarivoli/neuravian-frontend:0.1.0";
const BACKEND_VERSION_REF = "ghcr.io/sadhanaarivoli/neuravian-backend:0.1.0";

const releaseJson = {
  schemaVersion: 1,
  version: "0.1.0",
  commit: COMMIT,
  frontend: { repository: "ghcr.io/sadhanaarivoli/neuravian-frontend", versionRef: FRONTEND_VERSION_REF, commitRef: FRONTEND_COMMIT_REF },
  backend: { repository: "ghcr.io/sadhanaarivoli/neuravian-backend", versionRef: BACKEND_VERSION_REF, commitRef: BACKEND_COMMIT_REF },
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(release: unknown | null = releaseJson) {
  const root = await mkdtemp(path.join(os.tmpdir(), "neuravian-compose-pull-"));
  roots.push(root);
  if (release !== null) {
    await writeFile(path.join(root, "release.json"), JSON.stringify(release));
  }
  const ctx = {
    resourcesRoot: root,
    dataDir: path.join(root, "data"),
    dockerResourcesDir: root,
    datasetsDir: path.join(root, "datasets"),
    packaged: true,
  };
  return { root, ctx };
}

/** present: set of image refs `docker image inspect` should report as already local. */
function commandFor(options: {
  present?: Set<string>;
  pullShouldFail?: Set<string>;
} = {}) {
  const present = options.present ?? new Set<string>();
  const pullShouldFail = options.pullShouldFail ?? new Set<string>();
  const calls: string[][] = [];
  const command = vi.fn(async (_cmd: string, args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === "image" && args[1] === "inspect") {
      const ref = args[2];
      if (present.has(ref)) return { stdout: JSON.stringify([{ Id: `sha256:${ref}` }]), stderr: "", exitCode: 0 };
      throw new CommandError(`${_cmd} exited with code 1`, _cmd, { stdout: "", stderr: "Error: No such image", exitCode: 1 });
    }
    if (args[0] === "pull") {
      const ref = args[1];
      if (pullShouldFail.has(ref)) {
        throw new CommandError(`${_cmd} exited with code 1`, _cmd, {
          stdout: "", stderr: "Error response from daemon: manifest unknown", exitCode: 1,
        });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
  });
  return { command, calls };
}

describe("DesktopCompose.pull() — commit-pinned image resolution", () => {
  it("1. locally built unpublished image: never contacts the registry", async () => {
    const { ctx } = await fixture();
    const { command, calls } = commandFor({ present: new Set([FRONTEND_COMMIT_REF, BACKEND_COMMIT_REF]) });
    const compose = new DesktopCompose(ctx, command, "/usr/local/bin/docker");
    await compose.pull();
    expect(calls.filter((c) => c[0] === "image" && c[1] === "inspect")).toHaveLength(2);
    expect(calls.filter((c) => c[0] === "pull")).toHaveLength(0);
  });

  it("2. published image already cached locally: skips the download on relaunch", async () => {
    const { ctx } = await fixture();
    const { command, calls } = commandFor({ present: new Set([FRONTEND_COMMIT_REF, BACKEND_COMMIT_REF]) });
    const compose = new DesktopCompose(ctx, command, "/usr/local/bin/docker");
    await compose.pull();
    await compose.pull(); // simulate a second launch
    expect(calls.filter((c) => c[0] === "pull")).toHaveLength(0);
    expect(calls.filter((c) => c[0] === "image" && c[1] === "inspect")).toHaveLength(4);
  });

  it("3. published image requiring download: pulls exactly the missing ones", async () => {
    const { ctx } = await fixture();
    const { command, calls } = commandFor({ present: new Set() });
    const compose = new DesktopCompose(ctx, command, "/usr/local/bin/docker");
    await compose.pull();
    const pulls = calls.filter((c) => c[0] === "pull").map((c) => c[1]);
    expect(pulls.sort()).toEqual([BACKEND_COMMIT_REF, FRONTEND_COMMIT_REF].sort());
  });

  it("3b. reports a clear error when the image cannot be found remotely", async () => {
    const { ctx } = await fixture();
    const { command } = commandFor({ present: new Set(), pullShouldFail: new Set([FRONTEND_COMMIT_REF]) });
    const compose = new DesktopCompose(ctx, command, "/usr/local/bin/docker");
    await expect(compose.pull()).rejects.toThrow(/Could not download the frontend image.*manifest unknown/s);
  });

  it("4. missing commit tag (release.json absent): fails with a clear, actionable error", async () => {
    const { ctx } = await fixture(null); // no release.json written at all
    const { command } = commandFor();
    const compose = new DesktopCompose(ctx, command, "/usr/local/bin/docker");
    await expect(compose.pull()).rejects.toThrow(/release\.json is missing or invalid/);
  });

  it("4b. missing commit tag (release.json present but incomplete): fails clearly, does not fall back to a version tag", async () => {
    const { ctx } = await fixture({ ...releaseJson, frontend: { ...releaseJson.frontend, commitRef: undefined } });
    const { command, calls } = commandFor();
    const compose = new DesktopCompose(ctx, command, "/usr/local/bin/docker");
    await expect(compose.pull()).rejects.toThrow(/release\.json is missing or invalid/);
    expect(calls).toHaveLength(0); // never even attempts a Docker call with a partial reference
  });

  it("5. a stale/mutable version tag present locally never affects the pull decision", async () => {
    const { ctx } = await fixture();
    // The mutable :0.1.0 tag exists locally (e.g. left over from an earlier publish) but the
    // exact commit tag does not — pull() must judge presence by the commit ref only, and must
    // never reference the version tag at all.
    const { command, calls } = commandFor({ present: new Set([FRONTEND_VERSION_REF, BACKEND_VERSION_REF]) });
    const compose = new DesktopCompose(ctx, command, "/usr/local/bin/docker");
    await compose.pull();
    expect(calls.some((c) => c.includes(FRONTEND_VERSION_REF))).toBe(false);
    expect(calls.some((c) => c.includes(BACKEND_VERSION_REF))).toBe(false);
    const pulls = calls.filter((c) => c[0] === "pull").map((c) => c[1]);
    expect(pulls.sort()).toEqual([BACKEND_COMMIT_REF, FRONTEND_COMMIT_REF].sort());
  });

  it("dev mode: pull() is a no-op (no release.json, no source-tree images to pin)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "neuravian-compose-pull-dev-"));
    roots.push(root);
    const ctx = { resourcesRoot: root, dataDir: path.join(root, "data"), dockerResourcesDir: root, datasetsDir: path.join(root, "datasets"), packaged: false };
    const { command, calls } = commandFor();
    const compose = new DesktopCompose(ctx, command, "/usr/local/bin/docker");
    await compose.pull();
    expect(calls).toHaveLength(0);
  });

  it("injects NEURAVIAN_FRONTEND_IMAGE / NEURAVIAN_BACKEND_IMAGE as the exact commit refs for compose invocations", async () => {
    const { ctx } = await fixture();
    const envs: (NodeJS.ProcessEnv | undefined)[] = [];
    const command = vi.fn(async (_cmd: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      envs.push(options.env);
      return { stdout: JSON.stringify([{ Id: "sha256:x" }]), stderr: "", exitCode: 0 };
    });
    const compose = new DesktopCompose(ctx, command, "/usr/local/bin/docker");
    await compose.pull();
    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) {
      expect(env?.NEURAVIAN_FRONTEND_IMAGE).toBe(FRONTEND_COMMIT_REF);
      expect(env?.NEURAVIAN_BACKEND_IMAGE).toBe(BACKEND_COMMIT_REF);
    }
  });
});
