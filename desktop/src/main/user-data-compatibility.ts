import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export interface UserDataCompatibilityResult {
  activePath: string;
  canonicalPath: string;
  legacyPath: string | null;
  mode: "canonical" | "legacy-compatible";
}

interface ElectronPaths {
  getPath(name: "appData" | "userData"): string;
  setPath(name: "userData", value: string): void;
}

function populated(directory: string): boolean {
  if (!existsSync(directory)) return false;
  try { return readdirSync(directory).length > 0; }
  catch { return false; }
}

/**
 * Keep an existing pre-release desktop profile readable after the bundle/name
 * migration. The legacy directory remains the source of truth and is never
 * moved, copied, or deleted. New installations use the canonical Neuravian
 * directory. This temporary compatibility choice also avoids copying encrypted
 * workspace credentials without first qualifying safeStorage behavior across
 * application identities.
 */
export function configureUserDataCompatibility(app: ElectronPaths): UserDataCompatibilityResult {
  const canonicalPath = app.getPath("userData");
  if (populated(canonicalPath)) {
    return { activePath: canonicalPath, canonicalPath, legacyPath: null, mode: "canonical" };
  }

  const appData = app.getPath("appData");
  const legacyCandidates = [
    path.join(appData, "NeuroForge"),
    path.join(appData, "neuroforge-desktop"),
  ];
  const legacyPath = legacyCandidates.find(populated) ?? null;
  if (!legacyPath) {
    return { activePath: canonicalPath, canonicalPath, legacyPath: null, mode: "canonical" };
  }

  app.setPath("userData", legacyPath);
  return { activePath: legacyPath, canonicalPath, legacyPath, mode: "legacy-compatible" };
}
