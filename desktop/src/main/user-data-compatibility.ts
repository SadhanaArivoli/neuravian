import { type Dirent, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
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

// ── Directory / file name constants ──────────────────────────────────────────

const WORKSPACES_DIRECTORY  = "workspaces";
const PROFILES_FILE         = "workspace-profiles.json";
const CREDENTIALS_FILE      = "workspace-credentials.json";
const SESSION_DIRECTORY     = "workspace-sessions";
const RUN_HISTORY_DIRECTORY = "workspace-run-history";
const METADATA_DIRECTORY    = "workspace-metadata";

// ── Helpers ───────────────────────────────────────────────────────────────────

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
 * Copy a single file from `source` to `destination` if the source exists and the destination
 * does not. Creates intermediate directories as needed. Never overwrites; never deletes. If the
 * source is absent the call is silently a no-op. Preserves file mode on a best-effort basis.
 */
function migrateSingleFile(source: string, destination: string, log: (message: string) => void): void {
  if (!existsSync(source)) return;
  if (existsSync(destination)) {
    log(`user-data-compatibility: ${path.basename(destination)} already exists at ${destination}; leaving it untouched.`);
    return;
  }
  const sourceStat = statSync(source);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  try { chmodSync(destination, sourceStat.mode); } catch { /* best-effort permission preservation */ }
  log(`user-data-compatibility: migrated ${path.basename(source)} from ${source} (mtime ${sourceStat.mtime.toISOString()}) to ${destination}.`);
}

/**
 * Recursively copy all files under `sourceDir` into `destinationDir`, no-clobbering each
 * individual file. Creates the destination directory tree as needed. Silently skips symlinks
 * and special files — only plain files and directories are copied. If the source directory is
 * absent the call is a no-op.
 */
function migrateDirectoryTree(sourceDir: string, destinationDir: string, log: (message: string) => void): void {
  if (!existsSync(sourceDir)) return;
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(sourceDir, { withFileTypes: true });
  } catch {
    return;
  }
  mkdirSync(destinationDir, { recursive: true });
  for (const entry of entries) {
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      migrateDirectoryTree(src, dst, log);
    } else if (entry.isFile()) {
      migrateSingleFile(src, dst, log);
    }
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
 * Migrate per-profile state for every profile found in the canonical workspace-profiles.json.
 *
 * For each profile ID, the following are copied from `legacyPath` into `canonicalPath`:
 *
 *   workspace-sessions/<profileId>.json     — session state (last-synced summaries, UI state,
 *                                              50-entry display cache of recent runs)
 *   workspace-run-history/<profileId>.json  — complete durable run history (all runs ever
 *                                              launched from this profile)
 *   workspace-metadata/<profileId>/         — full offline snapshot (projects, datasets, runs)
 *                                              used as the offline fallback when the server is
 *                                              unreachable
 *
 * All three copies are no-clobber and idempotent: if the destination already exists the source
 * is ignored; subsequent calls are no-ops. The legacy originals are never modified or deleted.
 *
 * ── run-cache NOT migrated by default ────────────────────────────────────────────────────────
 *
 * run-cache/<serverIdentity>/ holds locally-downloaded artifact binary files (NIfTI outputs,
 * FreeSurfer surfaces, HTML reports, etc.) that were synced from the remote workspace. It is
 * NOT required for run listing, run history, metadata display, or log viewing — all of which
 * are served by the three files above. run-cache is only consulted when the user opens an
 * artifact for local preview or viewer launch.
 *
 * Migrating it automatically would copy potentially large binary datasets (gigabytes) without
 * user consent and without need. Users can re-download specific artifacts on demand when the
 * remote workspace is next online. If a future optimization is desired, a separate one-time
 * migration with explicit user confirmation and progress reporting would be appropriate.
 */
function migratePerProfileState(legacyPath: string, canonicalPath: string, log: (message: string) => void): void {
  const profilesPath = path.join(canonicalPath, WORKSPACES_DIRECTORY, PROFILES_FILE);
  let rawProfiles: unknown;
  try {
    rawProfiles = JSON.parse(readFileSync(profilesPath, "utf8"));
  } catch {
    return; // Profiles not readable — nothing to migrate.
  }
  if (!Array.isArray(rawProfiles)) return;

  for (const profile of rawProfiles) {
    if (!profile || typeof profile !== "object") continue;
    const profileId = (profile as Record<string, unknown>).id;
    if (typeof profileId !== "string") continue;

    migrateSingleFile(
      path.join(legacyPath, SESSION_DIRECTORY, `${profileId}.json`),
      path.join(canonicalPath, SESSION_DIRECTORY, `${profileId}.json`),
      log,
    );

    migrateSingleFile(
      path.join(legacyPath, RUN_HISTORY_DIRECTORY, `${profileId}.json`),
      path.join(canonicalPath, RUN_HISTORY_DIRECTORY, `${profileId}.json`),
      log,
    );

    migrateDirectoryTree(
      path.join(legacyPath, METADATA_DIRECTORY, profileId),
      path.join(canonicalPath, METADATA_DIRECTORY, profileId),
      log,
    );
  }
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
 * Per-profile state (sessions, run history, offline snapshots) is migrated alongside the
 * workspace files. This migration is also idempotent, so it runs on every launch and safely
 * catches the case where profile files were migrated by an earlier build that did not yet
 * migrate per-profile state.
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
    // Canonical already has workspace profiles. Per-profile state (sessions, run history,
    // offline snapshots) may not have been migrated by an earlier build — attempt it now.
    // migrateSingleFile / migrateDirectoryTree are no-clobber so this is always safe to run.
    const legacyPath = legacyCandidates.find(populated) ?? null;
    if (legacyPath) {
      migratePerProfileState(legacyPath, canonicalPath, log);
    }
    return {
      activePath: canonicalPath, canonicalPath,
      legacyPath,
      mode: "canonical", migrated: false,
    };
  }

  const legacyWithProfiles = legacyCandidates.find(hasWorkspaceProfiles);
  if (legacyWithProfiles) {
    const migrated = migrateWorkspaceFiles(legacyWithProfiles, canonicalPath, log);
    // Per-profile state must also be migrated now that profiles are in canonical.
    migratePerProfileState(legacyWithProfiles, canonicalPath, log);
    return { activePath: canonicalPath, canonicalPath, legacyPath: legacyWithProfiles, mode: "canonical", migrated };
  }

  const legacyPopulated = legacyCandidates.find(populated) ?? null;
  if (!populated(canonicalPath) && legacyPopulated) {
    app.setPath("userData", legacyPopulated);
    return { activePath: legacyPopulated, canonicalPath, legacyPath: legacyPopulated, mode: "legacy-compatible", migrated: false };
  }

  return { activePath: canonicalPath, canonicalPath, legacyPath: legacyPopulated, mode: "canonical", migrated: false };
}
