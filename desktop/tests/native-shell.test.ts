import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { queryActiveRuns } from "../src/main/activity.js";
import { isInternalUrl, shouldOpenExternally } from "../src/main/navigation.js";
import { loadWindowBounds, saveWindowBounds } from "../src/main/window-state.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

describe("active-run protection", () => {
  it("detects running, queued, and pending scientific runs", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ running_run_id: 11, queued: [{ run_id: 12, position: 1 }] }))
      .mockResolvedValueOnce(jsonResponse([{ id: 13, status: "pending" }, { id: 10, status: "succeeded" }]));
    await expect(queryActiveRuns(fetcher)).resolves.toEqual({ active: true, runIds: [11, 12, 13] });
  });

  it("allows safe shutdown only when no run is active", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ running_run_id: null, queued: [] }))
      .mockResolvedValueOnce(jsonResponse([{ id: 10, status: "succeeded" }]));
    await expect(queryActiveRuns(fetcher)).resolves.toEqual({ active: false, runIds: [] });
  });

  it("keeps the required active-run quit choices in the native shell", async () => {
    const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
    expect(source).toContain('["Cancel", "Leave NeuroForge services running", "Return to NeuroForge"]');
  });
});

describe("native navigation boundaries", () => {
  it.each([
    "http://127.0.0.1:3000/",
    "http://127.0.0.1:3000/runs/42",
    "file:///Applications/NeuroForge.app/splash.html",
  ])("keeps %s inside the app", (url) => expect(isInternalUrl(url)).toBe(true));

  it.each(["https://docs.docker.com/", "https://github.com/SadhanaArivoli/neuroforge"])(
    "opens %s externally",
    (url) => {
      expect(isInternalUrl(url)).toBe(false);
      expect(shouldOpenExternally(url)).toBe(true);
    },
  );

  it("does not treat unsafe schemes as external web links", () => {
    expect(shouldOpenExternally("javascript:alert(1)")).toBe(false);
  });
});

describe("window state", () => {
  it("restores saved window size and position", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "neuroforge-window-"));
    const file = path.join(directory, "window-state.json");
    await saveWindowBounds(file, { x: 120, y: 80, width: 1440, height: 960 });
    await expect(loadWindowBounds(file)).resolves.toEqual({ x: 120, y: 80, width: 1440, height: 960 });
  });

  it("enforces the minimum usable window size", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "neuroforge-window-"));
    const file = path.join(directory, "window-state.json");
    await saveWindowBounds(file, { width: 400, height: 300 });
    await expect(loadWindowBounds(file)).resolves.toMatchObject({ width: 1024, height: 700 });
  });
});
