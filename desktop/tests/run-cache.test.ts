import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { syncRun, type SyncManifest } from "../src/main/run-cache.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const manifest = (content: string): SyncManifest => ({
  runId: 7,
  provenance: { pipeline: "fastsurfer" },
  methods: { text: "method" },
  reports: [],
  artifacts: [{
    artifactId: 42,
    relativePath: "mri/orig_nu.mgz",
    url: "https://example.invalid/api/runs/7/files/mri/orig_nu.mgz",
    sha256: digest(content),
    sizeBytes: Buffer.byteLength(content),
  }],
});

describe("run cache synchronization", () => {
  it("downloads, verifies, records metadata, and reuses unchanged artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nf-cache-"));
    const fetcher = vi.fn(async () => new Response("volume"));
    expect((await syncRun(root, manifest("volume"), fetcher)).downloaded).toEqual(["mri/orig_nu.mgz"]);
    expect((await syncRun(root, manifest("volume"), fetcher)).reused).toEqual(["mri/orig_nu.mgz"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const metadata = JSON.parse(await readFile(path.join(root, "run-7", "run-metadata.json"), "utf8"));
    expect(metadata.artifacts[0].artifactId).toBe(42);
  });

  it("resumes a partial transfer with a Range request", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nf-cache-"));
    const partial = path.join(root, "run-7", "artifacts", "mri", "orig_nu.mgz.partial");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(partial), { recursive: true }));
    await writeFile(partial, "vol");
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Range: "bytes=3-" });
      return new Response("ume", { status: 206 });
    });
    expect((await syncRun(root, manifest("volume"), fetcher as typeof fetch)).downloaded).toHaveLength(1);
  });

  it("rejects traversal before fetching", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nf-cache-"));
    const unsafe = manifest("x");
    unsafe.artifacts[0].relativePath = "../../outside";
    const fetcher = vi.fn();
    await expect(syncRun(root, unsafe, fetcher)).rejects.toThrow("Unsafe");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
