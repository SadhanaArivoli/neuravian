import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export interface SyncArtifact {
  artifactId: string | number;
  relativePath: string;
  url: string;
  sha256: string;
  sizeBytes: number;
}

export interface SyncManifest {
  runId: number;
  provenance: unknown;
  methods: unknown;
  reports: unknown;
  artifacts: SyncArtifact[];
}

export interface SyncResult {
  runId: number;
  downloaded: string[];
  reused: string[];
}

function safeRelativePath(value: string) {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..") || normalized.includes("\0")) {
    throw new Error("Unsafe synchronization path.");
  }
  return normalized;
}

async function sha256(file: string) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function matches(file: string, artifact: SyncArtifact) {
  try {
    const details = await stat(file);
    return details.size === artifact.sizeBytes && await sha256(file) === artifact.sha256;
  } catch { return false; }
}

export async function syncRun(
  cacheRoot: string,
  manifest: SyncManifest,
  fetcher: typeof fetch = fetch,
): Promise<SyncResult> {
  if (!Number.isInteger(manifest.runId) || manifest.runId < 1) throw new Error("Invalid run ID.");
  const runRoot = path.join(path.resolve(cacheRoot), `run-${manifest.runId}`);
  await mkdir(runRoot, { recursive: true });
  const result: SyncResult = { runId: manifest.runId, downloaded: [], reused: [] };

  for (const artifact of manifest.artifacts) {
    const relative = safeRelativePath(artifact.relativePath);
    const target = path.join(runRoot, "artifacts", relative);
    if (await matches(target, artifact)) { result.reused.push(relative); continue; }
    await mkdir(path.dirname(target), { recursive: true });
    const partial = `${target}.partial`;
    let offset = 0;
    try { offset = (await stat(partial)).size; } catch { /* start clean */ }
    const response = await fetcher(artifact.url, {
      headers: offset ? { Range: `bytes=${offset}-` } : undefined,
    });
    if (!response.ok || !response.body) throw new Error(`Artifact download failed with HTTP ${response.status}.`);
    if (offset && response.status !== 206) {
      offset = 0;
      await writeFile(partial, "");
    }
    await pipeline(
      Readable.fromWeb(response.body as import("stream/web").ReadableStream),
      createWriteStream(partial, { flags: offset ? "a" : "w" }),
    );
    if (!await matches(partial, artifact)) throw new Error(`Checksum verification failed for artifact ${artifact.artifactId}.`);
    await rename(partial, target);
    result.downloaded.push(relative);
  }

  const metadata = JSON.stringify({
    schemaVersion: 1,
    runId: manifest.runId,
    provenance: manifest.provenance,
    methods: manifest.methods,
    reports: manifest.reports,
    artifacts: manifest.artifacts.map(({ artifactId, relativePath, sha256: checksum, sizeBytes }) => ({
      artifactId, relativePath, sha256: checksum, sizeBytes,
    })),
  }, null, 2);
  const metadataPath = path.join(runRoot, "run-metadata.json");
  const previous = await readFile(metadataPath, "utf8").catch(() => null);
  if (previous !== `${metadata}\n`) await writeFile(metadataPath, `${metadata}\n`, { mode: 0o600 });
  return result;
}
