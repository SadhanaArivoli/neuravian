/**
 * Validates desktop/docker-compose.packaged.yml content and packaging config.
 *
 * Req 8: packaging config maps the file into app-resources/desktop/.
 * Req 9: the file must not contain build: directives, local build contexts,
 *        or source-code bind mounts.
 */
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Paths relative to the desktop/ package root (where vitest runs).
const DESKTOP_DIR = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..");

const PACKAGED_COMPOSE = path.join(DESKTOP_DIR, "docker-compose.packaged.yml");
const BUILDER_CONFIG = path.join(DESKTOP_DIR, "electron-builder.yml");
const DIST_APP = path.join(
  DESKTOP_DIR,
  "dist/mac-arm64/Neuravian.app/Contents/Resources/app-resources/desktop/docker-compose.packaged.yml",
);

// ---------------------------------------------------------------------------
// Source-file existence
// ---------------------------------------------------------------------------
describe("desktop/docker-compose.packaged.yml — source file", () => {
  it("exists at desktop/docker-compose.packaged.yml", async () => {
    await expect(access(PACKAGED_COMPOSE, constants.R_OK)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Content validation (req 9)
// ---------------------------------------------------------------------------
describe("docker-compose.packaged.yml — content", () => {
  async function content(): Promise<string> {
    return readFile(PACKAGED_COMPOSE, "utf8");
  }

  it("does not contain 'build:' directives", async () => {
    const text = await content();
    expect(text).not.toMatch(/^\s*build:/m);
  });

  it("does not reference a local backend build context", async () => {
    const text = await content();
    // Patterns from the dev docker-compose.yml: context: ./backend or ../backend
    expect(text).not.toMatch(/context:\s*[.]{1,2}\/backend/);
    expect(text).not.toMatch(/context:\s*\.$/m);
  });

  it("does not reference a local frontend build context", async () => {
    const text = await content();
    expect(text).not.toMatch(/context:\s*[.]{1,2}\/frontend/);
    expect(text).not.toMatch(/dockerfile:\s*frontend\//);
  });

  it("does not contain source-code bind mounts for backend", async () => {
    const text = await content();
    // Dev mounts: ./backend:/app  or  ../backend:/app
    expect(text).not.toMatch(/[.]{1,2}\/backend:/);
  });

  it("does not contain source-code bind mounts for frontend", async () => {
    const text = await content();
    expect(text).not.toMatch(/[.]{1,2}\/frontend:/);
  });

  it("resolves the backend image from NEURAVIAN_BACKEND_IMAGE, not a hardcoded tag", async () => {
    const text = await content();
    expect(text).toContain("image: ${NEURAVIAN_BACKEND_IMAGE}");
    expect(text).not.toMatch(/image:\s*ghcr\.io\/\S*backend\S*/);
  });

  it("resolves the frontend image from NEURAVIAN_FRONTEND_IMAGE, not a hardcoded tag", async () => {
    const text = await content();
    expect(text).toContain("image: ${NEURAVIAN_FRONTEND_IMAGE}");
    expect(text).not.toMatch(/image:\s*ghcr\.io\/\S*frontend\S*/);
  });

  it("stays static — never hardcodes the version or commit tag", async () => {
    // The whole point of the fix: this file must never contain a literal ghcr.io/.../:<tag>
    // reference. The exact commit-pinned image is injected by Electron at startup via env vars
    // (see compose.ts imageReferences()), derived from release.json, not templated into this file.
    const text = await content();
    expect(text).not.toMatch(/image:\s*ghcr\.io\/\S+:\S+/);
  });

  it("binds ports to 127.0.0.1 only (not 0.0.0.0)", async () => {
    const text = await content();
    // All port mappings must start with 127.0.0.1: so they are localhost-only.
    const portLines = text.split("\n").filter((l) => l.match(/published|"127\.|"\d+:\d+"/));
    const open = portLines.filter((l) => !l.includes("127.0.0.1"));
    expect(open).toHaveLength(0);
  });

  it("uses NEURAVIAN_DATA_DIR for the writable data mount", async () => {
    const text = await content();
    expect(text).toContain("${NEURAVIAN_DATA_DIR}");
  });

  it("mounts the runtime dataset root at the packaged backend namespace", async () => {
    const text = await content();
    expect(text).toContain("source: ${HOST_DATASETS_DIR}");
    expect(text).toContain("target: /datasets");
    expect(text).toContain("BACKEND_DATASETS_MOUNT: /datasets");
  });

  it("uses NEURAVIAN_RESOURCES_DIR for read-only resource mounts", async () => {
    const text = await content();
    expect(text).toContain("${NEURAVIAN_RESOURCES_DIR}/pipelines");
    expect(text).toContain("${NEURAVIAN_RESOURCES_DIR}/plugins");
  });

  it("preserves the backend health check", async () => {
    const text = await content();
    expect(text).toContain("healthcheck:");
    expect(text).toContain("/api/health");
  });

  it("preserves frontend depends_on backend", async () => {
    const text = await content();
    expect(text).toContain("service_healthy");
  });

  it("uses project name neuravian-desktop", async () => {
    const text = await content();
    expect(text).toContain("name: neuravian-desktop");
  });
});

// ---------------------------------------------------------------------------
// Packaging config (req 8) — electron-builder.yml must map the file correctly
// ---------------------------------------------------------------------------
describe("electron-builder.yml — extraResources", () => {
  it("maps docker-compose.packaged.yml into app-resources/desktop/", async () => {
    const text = await readFile(BUILDER_CONFIG, "utf8");
    // Must have an entry that copies the packaged compose file into the correct bundle path.
    expect(text).toContain("docker-compose.packaged.yml");
    expect(text).toContain("app-resources/desktop/docker-compose.packaged.yml");
  });
});

// ---------------------------------------------------------------------------
// Built artifact (req 8) — only runs when dist/ is present
// ---------------------------------------------------------------------------
describe("built .app bundle", () => {
  it("contains app-resources/desktop/docker-compose.packaged.yml", async () => {
    try {
      await access(DIST_APP, constants.R_OK);
    } catch {
      // Build artifact not present — skip rather than fail.
      console.log("[skip] dist/ not present; run electron-builder first");
      return;
    }
    // If the file exists, also verify it has no build: directives (same as source).
    const text = await readFile(DIST_APP, "utf8");
    expect(text).not.toMatch(/^\s*build:/m);
    expect(text).toContain("image: ${NEURAVIAN_BACKEND_IMAGE}");
  });
});

// ---------------------------------------------------------------------------
// Startup command contract — compose.ts must include --remove-orphans
// ---------------------------------------------------------------------------
describe("compose.ts — startup command", () => {
  it("start() passes --remove-orphans to docker compose up", async () => {
    const src = await readFile(path.join(DESKTOP_DIR, "src/main/compose.ts"), "utf8");
    expect(src).toContain("--remove-orphans");
  });

  it("force recreation does not remove bind-mounted data or volumes", async () => {
    const src = await readFile(path.join(DESKTOP_DIR, "src/main/compose.ts"), "utf8");
    expect(src).toContain('forceRecreate ? ["--force-recreate"] : []');
    expect(src).not.toMatch(/\[\.\.\.composeArguments\(this\.ctx\).*"down"/s);
    expect(src).not.toContain('"--volumes"');
  });

  it("packaged mode does not pass --build (no source in bundle)", async () => {
    // The --build flag is only added in dev mode; packaged mode skips it.
    const src = await readFile(path.join(DESKTOP_DIR, "src/main/compose.ts"), "utf8");
    // Pattern: ctx.packaged ? [] : ["--build"]  — build is behind the dev branch.
    expect(src).toMatch(/packaged.*\[\].*"--build"|"--build".*packaged/s);
  });
});
