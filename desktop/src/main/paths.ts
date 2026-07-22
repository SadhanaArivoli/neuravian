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

export interface RuntimePaths {
  /** Directory containing docker-compose.yml, pipelines/, plugins/. Read-only. */
  resourcesRoot: string;
  /** Writable directory for the SQLite database, run logs, and derivatives. */
  dataDir: string;
  /** True when running from a packaged .app; false in development. */
  packaged: boolean;
}

/**
 * Resolve the correct runtime paths for both packaged and development modes.
 *
 * Packaged (.app):
 *   - resourcesRoot  = Contents/Resources/app-resources  (extraResources destination)
 *   - dataDir        = ~/Library/Application Support/neuravian-desktop/data
 *
 * Development (source checkout):
 *   - resourcesRoot  = repository root (located by walking up from __dirname)
 *   - dataDir        = <repositoryRoot>/data
 */
export function resolveRuntimePaths(options: {
  isPackaged: boolean;
  resourcesPath: string;
  userDataPath: string;
  dirname: string;
}): RuntimePaths {
  const { isPackaged, resourcesPath, userDataPath, dirname } = options;

  if (isPackaged) {
    const resourcesRoot = path.join(resourcesPath, "app-resources");
    const dataDir = path.join(userDataPath, "data");
    return { resourcesRoot, dataDir, packaged: true };
  }

  // Development: walk up from __dirname to find the repository root.
  // Honour the NEURAVIAN_REPO_ROOT override for CI or non-standard layouts.
  const repoRoot = findRepositoryRoot(dirname);
  return {
    resourcesRoot: repoRoot,
    dataDir: path.join(repoRoot, "data"),
    packaged: false,
  };
}

export function assertReadable(pathname: string): void {
  accessSync(pathname, constants.R_OK);
}
