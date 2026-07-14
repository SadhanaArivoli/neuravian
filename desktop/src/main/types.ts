export type StartupState =
  | "checking-system"
  | "docker-missing"
  | "docker-stopped"
  | "compose-missing"
  | "port-conflict"
  | "starting"
  | "backend-starting"
  | "frontend-starting"
  | "ready"
  | "failed"
  | "shutting-down";

export interface StartupUpdate {
  state: StartupState;
  title: string;
  detail: string;
  attemptId?: string;
  stage?: string;
  elapsedMs?: number;
  recoverable?: boolean;
  dockerInstallUrl?: string;
  browserAvailable?: boolean;
  dockerRelevant?: boolean;
}

export interface SystemFacts {
  macOSVersion: string;
  architecture: string;
  memoryGiB: number;
  diskAvailableGiB: number;
  dockerVersion: string;
  composeVersion: string;
  repositoryRoot: string;
  occupiedPorts: number[];
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
