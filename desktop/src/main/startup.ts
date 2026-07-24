import { BACKEND_HEALTH_URL, FRONTEND_URL, probeService, waitForService, verifyFrontendCommit, verifyRuntimeIdentity, type HealthProbe, type RuntimeIdentity } from "./health.js";
import { SystemCheckError, runSystemChecks, type SystemCheckContext } from "./system-checks.js";
import type { DesktopCompose } from "./compose.js";
import type { StartupUpdate, SystemFacts } from "./types.js";
import { STARTUP_TIMEOUTS, withTimeout } from "./timeouts.js";
import { randomUUID } from "node:crypto";

export const DOCKER_INSTALL_URL = "https://docs.docker.com/desktop/setup/install/mac-install/";

type Trace = (stage: number | string, name: string, detail?: string, attemptId?: string, elapsedMs?: number) => void;

export interface StartupDependencies {
  systemChecks: (ctx: SystemCheckContext, trace: Trace) => Promise<SystemFacts>;
  wait: typeof waitForService;
  probe: (url: string) => Promise<HealthProbe>;
  now: () => number;
  makeAttemptId: () => string;
  runtimeIdentity: typeof verifyRuntimeIdentity;
}

const defaults: StartupDependencies = {
  systemChecks: async (ctx, trace) => await runSystemChecks(ctx, {
    trace: (stage, name, detail) => trace(stage, name, detail),
  }),
  wait: waitForService,
  probe: async (url) => await probeService(url),
  now: Date.now,
  makeAttemptId: () => randomUUID(),
  runtimeIdentity: verifyRuntimeIdentity,
};

export class StartupController {
  facts?: Partial<SystemFacts>;
  lastError?: unknown;
  currentAttemptId?: string;
  private currentPromise?: Promise<boolean>;
  private abortController?: AbortController;

  constructor(
    private readonly checkContext: SystemCheckContext,
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
      const facts = await withTimeout(
        this.dependencies.systemChecks(this.checkContext, (stage, name, detail) => this.trace(stage, name, detail, attemptId, this.dependencies.now() - startedAt)),
        "System check",
        STARTUP_TIMEOUTS.systemCheckMs,
      );
      this.facts = facts;
      this.compose.setDockerPath(facts.dockerPath);
      this.trace(6, "system checks completed", undefined, attemptId, this.dependencies.now() - startedAt);

      // Ensure the exact commit-pinned images this build expects are present locally before
      // inspecting the stack. compose.pull() only fetches what's missing — a locally-built,
      // unpublished image already satisfies its own commit tag and is never touched — so this
      // is safe to run every launch without forcing a network round-trip on a dev build.
      if (this.compose.ctx.packaged) {
        failedStage = "image pull";
        this.update(attemptId, startedAt, {
          state: "starting", title: "Downloading Neuravian images",
          detail: "Checking the packaged backend and frontend images.", stage: "image pull",
        });
        await this.compose.pull();
      }

      failedStage = "existing stack detection";
      const stack = await this.compose.inspectStack();
      this.trace(11.7, "stack detected", JSON.stringify({
        project: stack.project, detected: stack.detected, ownership: stack.detected ? "neuravian-managed" : "none",
        compatible: stack.compatible, running: stack.running,
        containers: stack.containers.map((item) => ({ service: item.service, image: item.image, imageId: item.imageId })),
      }), attemptId, this.dependencies.now() - startedAt);
      const [backendExisting, frontendExisting] = await Promise.all([
        this.dependencies.probe(BACKEND_HEALTH_URL),
        this.dependencies.probe(FRONTEND_URL),
      ]);
      let runtimeIdentity: RuntimeIdentity | null = null;
      if (stack.detected && stack.compatible && backendExisting.healthy && frontendExisting.healthy) {
        runtimeIdentity = await this.dependencies.runtimeIdentity(
          FRONTEND_URL, BACKEND_HEALTH_URL, stack.expectedVersion, this.compose.ctx.packaged,
        );
      }
      if (stack.detected && stack.compatible && runtimeIdentity?.compatible) {
        this.compose.attachExternal();
        this.trace(12, "compatible managed stack attached", JSON.stringify({
          ownership: "neuravian-managed", frontendCommit: runtimeIdentity.frontendCommit,
          backendVersion: runtimeIdentity.backendVersion,
          images: stack.containers.map((item) => ({ service: item.service, imageId: item.imageId })),
        }), attemptId, this.dependencies.now() - startedAt);
        this.trace(13, "backend health polling started", BACKEND_HEALTH_URL, attemptId, this.dependencies.now() - startedAt);
        this.trace(14, "backend health succeeded", `status=${backendExisting.status}`, attemptId, this.dependencies.now() - startedAt);
        this.trace(15, "frontend health polling started", FRONTEND_URL, attemptId, this.dependencies.now() - startedAt);
        this.trace(16, "frontend health succeeded", `status=${frontendExisting.status}`, attemptId, this.dependencies.now() - startedAt);
        this.trace(17, "ready event emitted from main process", "ownership=external", attemptId, this.dependencies.now() - startedAt);
        const externalWarn = await verifyFrontendCommit(FRONTEND_URL);
        if (externalWarn) this.trace("WARN", "frontend commit mismatch", externalWarn, attemptId, this.dependencies.now() - startedAt);
        this.update(attemptId, startedAt, { state: "ready", title: "Ready", detail: externalWarn ?? "Connected to the existing local Neuravian services.", stage: "ready" });
        return true;
      }

      const recreationReasons = [
        ...stack.reasons,
        ...(runtimeIdentity?.reasons ?? []),
      ];
      const recreateManaged = stack.detected && (
        !stack.compatible
        || Boolean(backendExisting.healthy && frontendExisting.healthy && runtimeIdentity && !runtimeIdentity.compatible)
      );
      if (recreateManaged) {
        this.trace(11.8, "managed stack recreation required", JSON.stringify({
          ownership: "neuravian-managed", reasons: recreationReasons,
        }), attemptId, this.dependencies.now() - startedAt);
      }

      if (facts.occupiedPorts.length && (
        !stack.detected
        || (!stack.running && !backendExisting.healthy && !frontendExisting.healthy)
      )) {
        throw new SystemCheckError(
          "port-conflict",
          `Local port${facts.occupiedPorts.length === 1 ? "" : "s"} ${facts.occupiedPorts.join(", ")} ${facts.occupiedPorts.length === 1 ? "is" : "are"} occupied by services that are not recognized as the compatible Neuravian-managed Compose stack.`,
        );
      }

      failedStage = "Compose start";
      this.update(attemptId, startedAt, { state: "starting", title: "Starting Neuravian", detail: "Starting the local Docker services.", stage: "Compose start" });
      this.trace(12, "Compose start invoked", "ownership=desktop", attemptId, this.dependencies.now() - startedAt);
      await this.compose.start(recreateManaged);

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
      const startedIdentity = await this.dependencies.runtimeIdentity(
        FRONTEND_URL, BACKEND_HEALTH_URL, stack.expectedVersion, this.compose.ctx.packaged,
      );
      if (!startedIdentity.compatible) {
        throw new Error(`Recreated Neuravian stack identity check failed: ${startedIdentity.reasons.join("; ")}`);
      }
      this.trace(17, "ready event emitted from main process", "ownership=desktop", attemptId, this.dependencies.now() - startedAt);
      const commitWarn = await verifyFrontendCommit(FRONTEND_URL);
      if (commitWarn) this.trace("WARN", "frontend commit mismatch", commitWarn, attemptId, this.dependencies.now() - startedAt);
      this.update(attemptId, startedAt, { state: "ready", title: "Ready", detail: commitWarn ?? "Neuravian is running locally.", stage: "ready" });
      const finalStack = await this.compose.inspectStack();
      this.trace(17.5, "final managed image identities", JSON.stringify(finalStack.containers.map((item) => ({
        service: item.service, image: item.image, imageId: item.imageId,
      }))), attemptId, this.dependencies.now() - startedAt);
      return true;
    } catch (error) {
      if (this.currentAttemptId !== attemptId) return false;
      this.lastError = error;
      const checkKind = error instanceof SystemCheckError ? error.kind : undefined;
      if (error instanceof SystemCheckError && error.facts) this.facts = { ...this.facts, ...error.facts };
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
