import { BACKEND_HEALTH_URL, FRONTEND_URL, waitForService } from "./health.js";
import { SystemCheckError, runSystemChecks } from "./system-checks.js";
import type { DesktopCompose } from "./compose.js";
import type { StartupUpdate, SystemFacts } from "./types.js";

export const DOCKER_INSTALL_URL = "https://docs.docker.com/desktop/setup/install/mac-install/";

export interface StartupDependencies {
  systemChecks: (root: string) => Promise<SystemFacts>;
  wait: typeof waitForService;
}

export class StartupController {
  facts?: SystemFacts;
  lastError?: unknown;
  private running = false;

  constructor(
    private readonly repositoryRoot: string,
    private readonly compose: DesktopCompose,
    private readonly onUpdate: (update: StartupUpdate) => void,
    private readonly dependencies: StartupDependencies = { systemChecks: runSystemChecks, wait: waitForService },
  ) {}

  async run(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    this.lastError = undefined;
    try {
      this.onUpdate({ state: "checking-system", title: "Checking system", detail: "Verifying macOS, storage, Docker, and local ports." });
      this.facts = await this.dependencies.systemChecks(this.repositoryRoot);
      this.onUpdate({ state: "starting", title: "Starting NeuroForge", detail: "Starting the existing Docker Compose services on this Mac." });
      await this.compose.start();
      this.onUpdate({ state: "backend-starting", title: "Backend starting", detail: "Waiting for the NeuroForge API health check." });
      await this.dependencies.wait("backend", BACKEND_HEALTH_URL);
      this.onUpdate({ state: "frontend-starting", title: "Frontend starting", detail: "Waiting for the NeuroForge interface." });
      await this.dependencies.wait("frontend", FRONTEND_URL);
      this.onUpdate({ state: "ready", title: "Ready", detail: "NeuroForge is running locally." });
      return true;
    } catch (error) {
      this.lastError = error;
      const checkKind = error instanceof SystemCheckError ? error.kind : undefined;
      const kind = checkKind && checkKind !== "system" ? checkKind : "failed";
      this.onUpdate({
        state: kind,
        title: kind === "docker-missing" ? "Docker not installed"
          : kind === "docker-stopped" ? "Docker daemon stopped"
          : kind === "compose-missing" ? "Docker Compose unavailable"
          : kind === "port-conflict" ? "Port conflict"
          : "Startup failed",
        detail: error instanceof Error ? error.message : String(error),
        recoverable: true,
        dockerInstallUrl: kind === "docker-missing" ? DOCKER_INSTALL_URL : undefined,
      });
      return false;
    } finally {
      this.running = false;
    }
  }
}
