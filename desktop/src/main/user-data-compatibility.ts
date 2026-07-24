import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface UserDataCompatibilityResult {
  activePath: string;
  canonicalPath: string;
  legacyPath: string | null;
  mode: "canonical" | "legacy-compatible";
  /** True if workspace profile/credential files were just copied from the legacy directory into canonicalPath. */
  migrated: boolean;
}

interface ElectronPaths {
  getPath(name: "appData" | "userData"): string;
  setPath(name: "userData", value: string): void;
}

const WORKSPACES_DIRECTORY = "workspaces";
const PROFILES_FILE = "workspace-profiles.json";
const CREDENTIALS_FILE = "workspace-credentials.json";

function populated(directory: string): boolean {
  if (!existsSync(directory)) return false;
  try { return readdirSync(directory).length > 0; }
  catch { return false; }
}

/**
 * True only if `directory/workspaces/workspace-profiles.json` exists and parses as a JSON
 * array. This is the actual migration signal — unlike `populated()`, it ignores Electron's
 * own runtime housekeeping files (Cache, GPUCache, Preferences, Local State, Session Storage,
 * etc.), which get written to userData on every launch regardless of whether the user has ever
 * configured a cloud workspace. A missing or corrupt file is treated as "no workspace data"
 * rather than thrown.
 */
function hasWorkspaceProfiles(directory: string): boolean {
  const file = path.join(directory, WORKSPACES_DIRECTORY, PROFILES_FILE);
  if (!existsSync(file)) return false;
  try {
    return Array.isArray(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return false;
  }
}

/**
 * Copies `workspace-profiles.json` and `workspace-credentials.json` (if present) from the
 * legacy directory into the canonical one. Never touches the legacy originals, and never
 * overwrites a file that already exists at the destination — so this is safe to call on every
 * launch: the first call migrates, every later call is a no-op once the destination file exists.
 */
function migrateWorkspaceFiles(legacyPath: string, canonicalPath: string, log: (message: string) => void): boolean {
  const legacyDirectory = path.join(legacyPath, WORKSPACES_DIRECTORY);
  const canonicalDirectory = path.join(canonicalPath, WORKSPACES_DIRECTORY);
  let migratedAny = false;
  for (const fileName of [PROFILES_FILE, CREDENTIALS_FILE]) {
    const source = path.join(legacyDirectory, fileName);
    const destination = path.join(canonicalDirectory, fileName);
    if (!existsSync(source)) continue;
    if (existsSync(destination)) {
      log(`user-data-compatibility: ${fileName} already exists at ${destination}; leaving it untouched.`);
      continue;
    }
    const sourceStat = statSync(source);
    mkdirSync(canonicalDirectory, { recursive: true });
    copyFileSync(source, destination);
    try { chmodSync(destination, sourceStat.mode); } catch { /* best-effort permission preservation */ }
    migratedAny = true;
    log(`user-data-compatibility: migrated ${fileName} from ${source} (mtime ${sourceStat.mtime.toISOString()}) to ${destination}.`);
  }
  return migratedAny;
}

/**
 * Keep an existing pre-release desktop profile readable after the bundle/name migration. The
 * legacy directory remains the source of truth for anything not yet migrated and is never
 * moved or deleted. New installations use the canonical Neuravian directory.
 *
 * The canonical directory only "wins" outright when it already has its own migrated workspace
 * data (`workspaces/workspace-profiles.json`). Electron/Chromium populate a fresh userData
 * directory with runtime files (Cache, GPUCache, Preferences, Local State, Session Storage, ...)
 * on every launch, so merely checking "does the canonical directory have any files" is not a
 * reliable signal that migration has happened — it previously caused the canonical directory to
 * be treated as authoritative before any cloud workspace profile had ever been copied into it.
 *
 * When the canonical directory lacks workspace data but a legacy directory has valid workspace
 * profiles, those files (and any encrypted credentials) are copied — never moved — into the
 * canonical directory once, and all future launches use the canonical directory from then on.
 *
 * When neither directory has workspace data, but the canonical directory is otherwise completely
 * empty and a legacy directory has other application data, the legacy directory is used directly
 * (unchanged behavior, keeps existing legacy-only users on their existing data without creating
 * a canonical directory at all).
 */
export function configureUserDataCompatibility(
  app: ElectronPaths,
  log: (message: string) => void = (message) => console.log(message),
): UserDataCompatibilityResult {
  const canonicalPath = app.getPath("userData");
  const appData = app.getPath("appData");
  const legacyCandidates = [
    path.join(appData, "NeuroForge"),
    path.join(appData, "neuroforge-desktop"),
  ];

  if (hasWorkspaceProfiles(canonicalPath)) {
    return {
      activePath: canonicalPath, canonicalPath,
      legacyPath: legacyCandidates.find(populated) ?? null,
      mode: "canonical", migrated: false,
    };
  }

  const legacyWithProfiles = legacyCandidates.find(hasWorkspaceProfiles);
  if (legacyWithProfiles) {
    const migrated = migrateWorkspaceFiles(legacyWithProfiles, canonicalPath, log);
    return { activePath: canonicalPath, canonicalPath, legacyPath: legacyWithProfiles, mode: "canonical", migrated };
  }

  const legacyPopulated = legacyCandidates.find(populated) ?? null;
  if (!populated(canonicalPath) && legacyPopulated) {
    app.setPath("userData", legacyPopulated);
    return { activePath: legacyPopulated, canonicalPath, legacyPath: legacyPopulated, mode: "legacy-compatible", migrated: false };
  }

  return { activePath: canonicalPath, canonicalPath, legacyPath: legacyPopulated, mode: "canonical", migrated: false };
}
