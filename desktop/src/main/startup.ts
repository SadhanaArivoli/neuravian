import { BACKEND_HEALTH_URL, FRONTEND_URL, probeService, waitForService, type HealthProbe } from "./health.js";
import { SystemCheckError, runSystemChecks } from "./system-checks.js";
import type { DesktopCompose } from "./compose.js";
import type { StartupUpdate, SystemFacts } from "./types.js";
import { STARTUP_TIMEOUTS, withTimeout } from "./timeouts.js";
import { randomUUID } from "node:crypto";

export const DOCKER_INSTALL_URL = "https://docs.docker.com/desktop/setup/install/mac-install/";

type Trace = (stage: number | string, name: string, detail?: string, attemptId?: string, elapsedMs?: number) => void;

export interface StartupDependencies {
  systemChecks: (root: string, trace: Trace) => Promise<SystemFacts>;
  wait: typeof waitForService;
  probe: (url: string) => Promise<HealthProbe>;
  now: () => number;
  makeAttemptId: () => string;
}

const defaults: StartupDependencies = {
  systemChecks: async (root, trace) => await runSystemChecks(root, {
    trace: (stage, name, detail) => trace(stage, name, detail),
  }),
  wait: waitForService,
  probe: async (url) => await probeService(url),
  now: Date.now,
  makeAttemptId: () => randomUUID(),
};

export class StartupController {
  facts?: SystemFacts;
  lastError?: unknown;
  currentAttemptId?: string;
  private currentPromise?: Promise<boolean>;
  private abortController?: AbortController;

  constructor(
    private readonly repositoryRoot: string,
    private readonly compose: DesktopCompose,
    private readonly onUpdate: (update: StartupUpdate) => void,
    private readonly trace: Trace = () => undefined,
    private readonly dependencies: StartupDependencies = defaults,
  ) {}

  run(): Promise<boolean> {
    if (this.currentPromise) return this.currentPromise;
    const attemptId = this.dependencies.makeAttemptId();
    this.currentAttemptId = attemptId;
    this.abortController = new AbortController();
    const promise = this.execute(attemptId, this.abortController.signal)
      .finally(() => { if (this.currentPromise === promise) this.currentPromise = undefined; });
    this.currentPromise = promise;
    return promise;
  }

  retry(): Promise<boolean> {
    if (this.currentPromise) return this.currentPromise;
    this.abortController?.abort();
    return this.run();
  }

  private update(attemptId: string, startedAt: number, update: StartupUpdate): void {
    if (this.currentAttemptId !== attemptId) return;
    this.onUpdate({ ...update, attemptId, elapsedMs: this.dependencies.now() - startedAt });
  }

  private async execute(attemptId: string, signal: AbortSignal): Promise<boolean> {
    const startedAt = this.dependencies.now();
    let failedStage = "system checks";
    this.lastError = undefined;
    try {
      this.trace(5, "system checks started", undefined, attemptId, 0);
      this.update(attemptId, startedAt, { state: "checking-system", title: "Checking system", detail: "Verifying macOS, storage, Docker, and local services.", stage: "system checks" });
      this.facts = await withTimeout(
        this.dependencies.systemChecks(this.repositoryRoot, (stage, name, detail) => this.trace(stage, name, detail, attemptId, this.dependencies.now() - startedAt)),
        "System check",
        STARTUP_TIMEOUTS.systemCheckMs,
      );
      this.trace(6, "system checks completed", undefined, attemptId, this.dependencies.now() - startedAt);

      failedStage = "existing service detection";
      const [backendExisting, frontendExisting] = await Promise.all([
        this.dependencies.probe(BACKEND_HEALTH_URL),
        this.dependencies.probe(FRONTEND_URL),
      ]);
      if (backendExisting.healthy && frontendExisting.healthy) {
        this.compose.attachExternal();
        this.trace(12, "existing healthy stack detected", `${BACKEND_HEALTH_URL}=${backendExisting.status}; ${FRONTEND_URL}=${frontendExisting.status}`, attemptId, this.dependencies.now() - startedAt);
        this.trace(13, "backend health polling started", BACKEND_HEALTH_URL, attemptId, this.dependencies.now() - startedAt);
        this.trace(14, "backend health succeeded", `status=${backendExisting.status}`, attemptId, this.dependencies.now() - startedAt);
        this.trace(15, "frontend health polling started", FRONTEND_URL, attemptId, this.dependencies.now() - startedAt);
        this.trace(16, "frontend health succeeded", `status=${frontendExisting.status}`, attemptId, this.dependencies.now() - startedAt);
        this.trace(17, "ready event emitted from main process", "ownership=external", attemptId, this.dependencies.now() - startedAt);
        this.update(attemptId, startedAt, { state: "ready", title: "Ready", detail: "Connected to the existing local NeuroForge services.", stage: "ready" });
        return true;
      }

      if (this.facts.occupiedPorts.length) {
        throw new SystemCheckError(
          "port-conflict",
          `Local port${this.facts.occupiedPorts.length === 1 ? "" : "s"} ${this.facts.occupiedPorts.join(", ")} ${this.facts.occupiedPorts.length === 1 ? "is" : "are"} occupied, but the NeuroForge health checks did not both succeed.`,
        );
      }

      failedStage = "Compose start";
      this.update(attemptId, startedAt, { state: "starting", title: "Starting NeuroForge", detail: "Starting the existing Docker Compose services on this Mac.", stage: "Compose start" });
      this.trace(12, "Compose start invoked", "ownership=desktop", attemptId, this.dependencies.now() - startedAt);
      await this.compose.start();

      failedStage = "backend health";
      this.update(attemptId, startedAt, { state: "backend-starting", title: "Backend starting", detail: `Waiting for ${BACKEND_HEALTH_URL}.`, stage: "backend health" });
      this.trace(13, "backend health polling started", BACKEND_HEALTH_URL, attemptId, this.dependencies.now() - startedAt);
      await this.dependencies.wait("backend", BACKEND_HEALTH_URL, { timeoutMs: STARTUP_TIMEOUTS.backendHealthMs, signal });
      this.trace(14, "backend health succeeded", BACKEND_HEALTH_URL, attemptId, this.dependencies.now() - startedAt);

      failedStage = "frontend health";
      this.update(attemptId, startedAt, { state: "frontend-starting", title: "Frontend starting", detail: `Waiting for ${FRONTEND_URL}.`, stage: "frontend health" });
      this.trace(15, "frontend health polling started", FRONTEND_URL, attemptId, this.dependencies.now() - startedAt);
      await this.dependencies.wait("frontend", FRONTEND_URL, { timeoutMs: STARTUP_TIMEOUTS.frontendHealthMs, signal });
      this.trace(16, "frontend health succeeded", FRONTEND_URL, attemptId, this.dependencies.now() - startedAt);
      this.trace(17, "ready event emitted from main process", "ownership=desktop", attemptId, this.dependencies.now() - startedAt);
      this.update(attemptId, startedAt, { state: "ready", title: "Ready", detail: "NeuroForge is running locally.", stage: "ready" });
      return true;
    } catch (error) {
      if (this.currentAttemptId !== attemptId) return false;
      this.lastError = error;
      const checkKind = error instanceof SystemCheckError ? error.kind : undefined;
      const kind = checkKind && checkKind !== "system" ? checkKind : "failed";
      const [backend, frontend] = await Promise.all([
        this.dependencies.probe(BACKEND_HEALTH_URL),
        this.dependencies.probe(FRONTEND_URL),
      ]);
      const elapsedMs = this.dependencies.now() - startedAt;
      this.trace("FAILED", failedStage, error instanceof Error ? error.message : String(error), attemptId, elapsedMs);
      this.update(attemptId, startedAt, {
        state: kind,
        title: kind === "docker-missing" ? "Docker not installed"
          : kind === "docker-stopped" ? "Docker daemon stopped"
          : kind === "compose-missing" ? "Docker Compose unavailable"
          : kind === "port-conflict" ? "Port conflict"
          : "Startup failed",
        detail: error instanceof Error ? error.message : String(error),
        stage: failedStage,
        recoverable: true,
        dockerInstallUrl: kind === "docker-missing" ? DOCKER_INSTALL_URL : undefined,
        browserAvailable: backend.healthy && frontend.healthy,
        dockerRelevant: ["docker-missing", "docker-stopped", "compose-missing"].includes(kind),
      });
      return false;
    }
  }
}
