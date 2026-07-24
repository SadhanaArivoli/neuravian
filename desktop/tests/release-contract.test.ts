import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createReleaseManifest, loadReleaseConfig, validateReleaseContract, verifyImageMetadata,
} from "../scripts/release-metadata.mjs";
import { publishPlan } from "../scripts/publish-images.mjs";
import { verifyRemoteImages } from "../scripts/verify-release-images.mjs";
import { verifyRuntimeIdentity } from "../src/main/health.js";

const desktopDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(desktopDir, "..");
const commit = "0123456789abcdef0123456789abcdef01234567";

async function manifest() {
  return createReleaseManifest(await loadReleaseConfig(desktopDir), commit);
}

function imageFor(release: Awaited<ReturnType<typeof manifest>>, component: "frontend" | "backend") {
  return {
    Id: `sha256:${component}`,
    RepoDigests: [`${release[component].repository}@sha256:${component}`],
    Config: { Labels: {
      "org.neuravian.component": component,
      "org.neuravian.git-commit": release.commit,
      "org.neuravian.release-version": release.version,
      "org.opencontainers.image.version": release.version,
      "org.opencontainers.image.revision": release.commit,
    } },
  };
}

describe("release contract", () => {
  it("keeps packaged Compose statically referencing the injected image env vars", async () => {
    const release = await manifest();
    await expect(validateReleaseContract({ repoRoot, desktopDir, manifest: release })).resolves.toMatchObject({
      release: release.version, desktop: release.version, frontend: release.version, backend: release.version,
    });
    const compose = await readFile(path.join(desktopDir, "docker-compose.packaged.yml"), "utf8");
    expect(compose).toContain("image: ${NEURAVIAN_FRONTEND_IMAGE}");
    expect(compose).toContain("image: ${NEURAVIAN_BACKEND_IMAGE}");
  });

  it("rejects a packaged Compose file that hardcodes an image tag instead of the env var", async () => {
    const release = await manifest();
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "neuravian-release-contract-"));
    try {
      const desktopPackage = JSON.parse(await readFile(path.join(desktopDir, "package.json"), "utf8"));
      await writeFile(path.join(fixtureDir, "package.json"), JSON.stringify(desktopPackage));
      const hardcoded = (await readFile(path.join(desktopDir, "docker-compose.packaged.yml"), "utf8"))
        .replace("image: ${NEURAVIAN_FRONTEND_IMAGE}", `image: ${release.frontend.versionRef}`);
      await writeFile(path.join(fixtureDir, "docker-compose.packaged.yml"), hardcoded);
      await expect(validateReleaseContract({ repoRoot, desktopDir: fixtureDir, manifest: release }))
        .rejects.toThrow(/must reference \$\{NEURAVIAN_FRONTEND_IMAGE\}/);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("uses one consistent application version", async () => {
    const versions = await validateReleaseContract({ repoRoot, desktopDir, manifest: await manifest() });
    expect(new Set(Object.values(versions)).size).toBe(1);
  });

  it.each(["frontend", "backend"] as const)("verifies %s image metadata", async (component) => {
    const release = await manifest();
    expect(verifyImageMetadata(imageFor(release, component), release, component)).toMatchObject({ imageId: `sha256:${component}` });
    const stale = imageFor(release, component);
    stale.Config.Labels["org.neuravian.git-commit"] = "stale";
    expect(() => verifyImageMetadata(stale, release, component)).toThrow(/git-commit/);
  });

  it("never publishes unless the explicit publish flag is supplied", async () => {
    const release = await manifest();
    expect(() => publishPlan(release)).toThrow(/Publishing is disabled/);
  });

  it("fails remote verification when a required image cannot be pulled", async () => {
    const runner = vi.fn(() => { throw new Error("manifest unknown"); });
    const release = await manifest();
    expect(() => verifyRemoteImages(release, runner)).toThrow(/manifest unknown/);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("requires packaged frontend and backend runtime release metadata", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ commit, releaseVersion: "0.1.0" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ backend_version: "0.1.0", release_version: "0.1.0" }), { status: 200 }));
    try {
      const identity = await verifyRuntimeIdentity("http://frontend", "http://backend/api/health", "0.1.0", true);
      // The test build has no matching build/commit.json, so commit identity is
      // expected to fail while both release-version fields are still captured.
      expect(identity).toMatchObject({ frontendVersion: "0.1.0", backendVersion: "0.1.0", backendReleaseVersion: "0.1.0" });
    } finally {
      fetchMock.mockRestore();
    }
  });
});
