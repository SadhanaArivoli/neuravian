import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { CommandError, runCommand } from "./command.js";
import type { CommandResult } from "./types.js";
import { STARTUP_TIMEOUTS } from "./timeouts.js";

/** Commit-pinned image references for the two packaged services, resolved from release.json. */
export interface ReleaseImageReferences {
  frontend: string;
  backend: string;
}

interface ReleaseManifestFile {
  version?: string;
  frontend?: { commitRef?: string };
  backend?: { commitRef?: string };
}

export const DESKTOP_PROJECT_NAME = "neuravian-desktop";

export interface ManagedContainer {
  service: string;
  containerId: string;
  status: string;
  image: string;
  imageId: string;
  expectedImage: string | null;
  expectedImageId: string | null;
  configHash: string | null;
  expectedConfigHash: string | null;
}

export interface StackInspection {
  detected: boolean;
  project: string;
  compatible: boolean;
  running: boolean;
  reasons: string[];
  expectedVersion: string | null;
  containers: ManagedContainer[];
}

export interface ComposeContext {
  /** Directory containing docker-compose.yml and the desktop overlay. */
  resourcesRoot: string;
  /** Writable directory for data volumes (database, logs, derivatives). */
  dataDir: string;
  /**
   * Directory Docker mounts for read-only resources (pipelines, plugins).
   * Must be under /Users/ so Docker Desktop can access it without extra
   * File Sharing configuration.
   *
   * Packaged: userData/resources (copied from the app bundle at startup).
   * Development: same as resourcesRoot (repo root is already under /Users/).
   */
  dockerResourcesDir: string;
  /**
   * Absolute resolved path to the user's dataset root directory.
   * Injected as HOST_DATASETS_DIR so Docker Compose can bind-mount it.
   * Never a tilde — Docker Compose does not expand shell shortcuts.
   */
  datasetsDir: string;
  /** True when running from a packaged .app. */
  packaged: boolean;
}

/**
 * Build the docker compose file arguments for the given context.
 *
 * Development: base file + localhost-only desktop overlay (build: contexts included).
 * Packaged:    ONLY the self-contained docker-compose.packaged.yml — no base file,
 *              no overlay merging, no build: contexts, no source repo references.
 */
export function composeArguments(ctx: ComposeContext): string[] {
  if (ctx.packaged) {
    // Self-contained file — does not reference docker-compose.yml at all.
    return [
      "compose", "--project-name", DESKTOP_PROJECT_NAME,
      "-f", path.join(ctx.resourcesRoot, "desktop", "docker-compose.packaged.yml"),
    ];
  }
  return [
    "compose", "--project-name", DESKTOP_PROJECT_NAME,
    "-f", path.join(ctx.resourcesRoot, "docker-compose.yml"),
    "-f", path.join(ctx.resourcesRoot, "desktop", "docker-compose.desktop.yml"),
  ];
}

export class DesktopCompose {
  private ownership: "none" | "owned" | "external" = "none";
  constructor(
    readonly ctx: ComposeContext,
    private readonly command = runCommand,
    private dockerPath?: string,
  ) {}

  /** @deprecated Use ctx.resourcesRoot for source path references. */
  get repositoryRoot(): string { return this.ctx.resourcesRoot; }

  get ownsServices(): boolean { return this.ownership === "owned"; }
  get serviceOwnership(): "none" | "owned" | "external" { return this.ownership; }

  attachExternal(): void { this.ownership = "external"; }
  setDockerPath(dockerPath: string): void { this.dockerPath = dockerPath; }

  private dockerCommand(): string {
    if (!this.dockerPath || !path.isAbsolute(this.dockerPath)) {
      throw new Error("The absolute Docker CLI path must be resolved before running Compose.");
    }
    return this.dockerPath;
  }

  /**
   * Reads release.json (written by build-full.mjs, copied to app-resources/release.json at
   * package time). Returns null in dev mode or if the file is missing/corrupt — callers must
   * not assume a packaged app always has it (e.g. a damaged install).
   */
  private async releaseManifest(): Promise<ReleaseManifestFile | null> {
    if (!this.ctx.packaged) return null;
    try {
      return JSON.parse(await readFile(path.join(this.ctx.resourcesRoot, "release.json"), "utf8")) as ReleaseManifestFile;
    } catch {
      return null;
    }
  }

  /** Resolves the exact commit-pinned image references this build was packaged with. */
  private async imageReferences(): Promise<ReleaseImageReferences | null> {
    const manifest = await this.releaseManifest();
    const frontend = manifest?.frontend?.commitRef;
    const backend = manifest?.backend?.commitRef;
    if (!frontend || !backend) return null;
    return { frontend, backend };
  }

  private async environment(): Promise<NodeJS.ProcessEnv> {
    const images = await this.imageReferences();
    return {
      ...process.env,
      HOST_UID: String(process.getuid?.() ?? 0),
      HOST_GID: String(process.getgid?.() ?? 0),
      // NEURAVIAN_DATA_DIR must be under /Users/ (writable, Docker Desktop default share).
      NEURAVIAN_DATA_DIR: this.ctx.dataDir,
      // NEURAVIAN_RESOURCES_DIR must be under /Users/ too — never the /Applications bundle.
      // In packaged mode this is userData/resources (content copied from bundle at startup).
      // In dev mode this is the repo root (already under /Users/).
      NEURAVIAN_RESOURCES_DIR: this.ctx.dockerResourcesDir,
      // HOST_DATASETS_DIR must be a fully resolved absolute path — Docker Compose does not
      // expand shell tildes, so we always supply the resolved value from app.getPath().
      HOST_DATASETS_DIR: this.ctx.datasetsDir,
      // Commit-pinned image references consumed by docker-compose.packaged.yml. Unset in dev
      // mode, where the base compose file builds from source instead of pulling an image.
      ...(images ? { NEURAVIAN_FRONTEND_IMAGE: images.frontend, NEURAVIAN_BACKEND_IMAGE: images.backend } : {}),
    };
  }

  /**
   * Working directory for docker compose invocations.
   *
   * Packaged: dataDir (~/Library/Application Support/…/data) — always under /Users/,
   *   always writable, and crucially NOT app-resources where a bundled docker-compose.yml
   *   could be auto-discovered by Docker Compose as an override or project file.
   *
   * Development: resourcesRoot (repo root) — the compose files live there and build
   *   contexts are resolved relative to it.
   */
  private composeCwd(): string {
    return this.ctx.packaged ? this.ctx.dataDir : this.ctx.resourcesRoot;
  }

  private async runDocker(args: readonly string[], timeoutMs = 20_000): Promise<CommandResult> {
    const env = await this.environment();
    return this.command(this.dockerCommand(), args, {
      cwd: this.composeCwd(), env, timeoutMs,
    });
  }

  async inspectStack(): Promise<StackInspection> {
    const env = await this.environment();
    const configResult = await this.command(
      this.dockerCommand(), [...composeArguments(this.ctx), "config", "--format", "json"],
      { cwd: this.composeCwd(), env, timeoutMs: 20_000 },
    );
    const composeConfig = JSON.parse(configResult.stdout) as {
      services?: Record<string, { image?: string }>;
    };
    const expectedServices = composeConfig.services ?? {};
    // In packaged mode the image tag is now the exact git commit (see imageReferences()), not a
    // semantic version, so the release's version comes from release.json directly. Dev mode has
    // no release.json and falls back to the prior heuristic of reading it off the resolved
    // image tag suffix (build-context services rarely have one, so this is usually null there,
    // same as before).
    const manifestVersion = (await this.releaseManifest())?.version ?? null;
    const imageVersions = Object.values(expectedServices)
      .map((service) => service.image?.match(/:([^/:]+)$/)?.[1])
      .filter((value): value is string => Boolean(value));
    const expectedVersion = manifestVersion ?? (
      imageVersions.length && imageVersions.every((value) => value === imageVersions[0])
        ? imageVersions[0]
        : null
    );
    const listed = await this.runDocker([
      "ps", "-a", "--filter", `label=com.docker.compose.project=${DESKTOP_PROJECT_NAME}`,
      "--format", "{{.ID}}",
    ]);
    const ids = listed.stdout.split(/\s+/).filter(Boolean);
    if (!ids.length) {
      return {
        detected: false, project: DESKTOP_PROJECT_NAME, compatible: false,
        running: false, reasons: ["no managed containers detected"],
        expectedVersion, containers: [],
      };
    }

    const hashResult = await this.command(
      this.dockerCommand(), [...composeArguments(this.ctx), "config", "--hash", "*"],
      { cwd: this.composeCwd(), env, timeoutMs: 20_000 },
    );
    const expectedHashes = new Map<string, string>();
    for (const line of hashResult.stdout.split("\n")) {
      const [service, hash] = line.trim().split(/\s+/, 2);
      if (service && hash) expectedHashes.set(service, hash);
    }

    const inspectResult = await this.runDocker(["inspect", ...ids]);
    const inspected = JSON.parse(inspectResult.stdout) as Array<{
      Id?: string;
      Image?: string;
      Config?: { Image?: string; Labels?: Record<string, string> };
      State?: { Status?: string };
    }>;
    const expectedImageIds = new Map<string, string | null>();
    for (const service of Object.keys(expectedServices)) {
      const image = expectedServices[service]?.image;
      if (!image || expectedImageIds.has(image)) continue;
      try {
        const result = await this.runDocker(["image", "inspect", image]);
        const parsed = JSON.parse(result.stdout) as Array<{ Id?: string }>;
        expectedImageIds.set(image, parsed[0]?.Id ?? null);
      } catch {
        expectedImageIds.set(image, null);
      }
    }

    const containers: ManagedContainer[] = inspected.map((container) => {
      const labels = container.Config?.Labels ?? {};
      const service = labels["com.docker.compose.service"] ?? "unknown";
      const expectedImage = expectedServices[service]?.image ?? null;
      return {
        service,
        containerId: container.Id ?? "unknown",
        status: container.State?.Status ?? "unknown",
        image: container.Config?.Image ?? "unknown",
        imageId: container.Image ?? "unknown",
        expectedImage,
        expectedImageId: expectedImage ? (expectedImageIds.get(expectedImage) ?? null) : null,
        configHash: labels["com.docker.compose.config-hash"] ?? null,
        expectedConfigHash: expectedHashes.get(service) ?? null,
      };
    });

    const reasons: string[] = [];
    const expectedNames = Object.keys(expectedServices).sort();
    const actualNames = containers.map((item) => item.service).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      reasons.push(`service set differs (expected ${expectedNames.join(",")}; found ${actualNames.join(",")})`);
    }
    for (const container of containers) {
      if (container.image !== container.expectedImage) {
        reasons.push(`${container.service} image reference differs`);
      }
      if (!container.expectedImageId || container.imageId !== container.expectedImageId) {
        reasons.push(`${container.service} image ID differs`);
      }
      if (!container.expectedConfigHash || container.configHash !== container.expectedConfigHash) {
        reasons.push(`${container.service} Compose configuration differs`);
      }
    }
    return {
      detected: true,
      project: DESKTOP_PROJECT_NAME,
      compatible: reasons.length === 0,
      running: containers.length > 0 && containers.every((item) => item.status === "running"),
      reasons,
      expectedVersion,
      containers,
    };
  }

  /** True if `docker image inspect <ref>` finds the exact image locally, without contacting a registry. */
  private async imagePresentLocally(image: string): Promise<boolean> {
    try {
      await this.runDocker(["image", "inspect", image], 10_000);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ensures the exact commit-pinned images this build expects are present locally, pulling only
   * what's missing. A locally-built, unpublished image (matching the exact commit tag) is never
   * touched — it already satisfies the reference, so no network access happens at all. This is
   * what makes a freshly `npm run dist:mac`-built DMG runnable offline on the machine that built
   * it, while a genuine end-user install still pulls the real thing on first launch.
   */
  async pull(): Promise<void> {
    if (!this.ctx.packaged) return;
    const images = await this.imageReferences();
    if (!images) {
      throw new Error(
        "Could not determine which Docker images this release expects (release.json is missing or invalid). " +
        "Reinstalling Neuravian should resolve this.",
      );
    }
    for (const [service, image] of [["frontend", images.frontend], ["backend", images.backend]] as const) {
      if (await this.imagePresentLocally(image)) continue;
      try {
        await this.runDocker(["pull", image], STARTUP_TIMEOUTS.composeStartMs);
      } catch (error) {
        const detail = error instanceof CommandError && error.result?.stderr ? error.result.stderr : String(error);
        throw new Error(
          `Could not download the ${service} image for this release ("${image}"). ` +
          `It may not have been published yet, or the network is unavailable. Docker reported: ${detail}`,
        );
      }
    }
  }

  async start(forceRecreate = false): Promise<CommandResult> {
    const env = await this.environment();
    const result = await this.command(
      this.dockerCommand(),
      // In packaged mode images are pre-built; --build would fail (no source).
      [...composeArguments(this.ctx), "up", ...(this.ctx.packaged ? [] : ["--build"]), "--detach",
        ...(forceRecreate ? ["--force-recreate"] : []), "--remove-orphans"],
      { cwd: this.composeCwd(), env, timeoutMs: STARTUP_TIMEOUTS.composeStartMs },
    );
    this.ownership = "owned";
    return result;
  }

  async stop(): Promise<CommandResult | undefined> {
    if (!this.ownsServices) return undefined;
    const env = await this.environment();
    const result = await this.command(this.dockerCommand(), [...composeArguments(this.ctx), "stop"], {
      cwd: this.composeCwd(),
      env,
      timeoutMs: 2 * 60_000,
    });
    this.ownership = "none";
    return result;
  }

  async logs(): Promise<string> {
    const env = await this.environment();
    const result = await this.command(this.dockerCommand(), [...composeArguments(this.ctx), "logs", "--tail", "120"], {
      cwd: this.composeCwd(),
      env,
      timeoutMs: 20_000,
    });
    return [result.stdout, result.stderr].filter(Boolean).join("\n");
  }
}
