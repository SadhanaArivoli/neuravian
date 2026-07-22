import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";

const REQUIRED = ["docker-compose.yml", "backend", "frontend", "pipelines", "plugins"];

export function isRepositoryRoot(candidate: string): boolean {
  return REQUIRED.every((entry) => existsSync(path.join(candidate, entry)));
}

export function findRepositoryRoot(startDirectory: string, explicit = process.env.NEURAVIAN_REPO_ROOT): string {
  const candidates: string[] = [];
  if (explicit) candidates.push(path.resolve(explicit));
  let current = path.resolve(startDirectory);
  while (true) {
    candidates.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const found = candidates.find(isRepositoryRoot);
  if (!found) throw new Error("Could not locate the Neuravian repository. Set NEURAVIAN_REPO_ROOT.");
  return found;
}

export function assertReadable(pathname: string): void {
  accessSync(pathname, constants.R_OK);
}
