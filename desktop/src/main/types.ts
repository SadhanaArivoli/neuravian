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
  recoverable?: boolean;
  dockerInstallUrl?: string;
}

export interface SystemFacts {
  macOSVersion: string;
  architecture: string;
  memoryGiB: number;
  diskAvailableGiB: number;
  dockerVersion: string;
  composeVersion: string;
  repositoryRoot: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
