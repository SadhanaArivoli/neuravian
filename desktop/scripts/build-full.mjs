#!/usr/bin/env node
/**
 * Full Neuravian build pipeline.
 *
 * Guarantees that the packaged app always ships the frontend at HEAD.
 * Run via:  npm run dist:mac   (from desktop/)
 *
 * Steps
 *  1. Record HEAD commit.
 *  2. Vite build  (frontend/src → frontend/dist).
 *  3. Docker rebuild  (bakes frontend/dist into nginx image with GIT_COMMIT label).
 *  4. Build-time verification  (inspect image label; fail if SHA mismatch).
 *  5. Write desktop/build/commit.json  (included in asar for runtime check).
 *  6. Compile Electron TypeScript + copy renderer.
 *  7. electron-builder package.
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createReleaseManifest, loadReleaseConfig, validateReleaseContract, verifyImageMetadata,
} from "./release-metadata.mjs";

const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const CYAN   = "\x1b[36m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";

function step(n, total, label) {
  console.log(`\n${BOLD}[${n}/${total}] ${label}${RESET}`);
}

function run(cmd, cwd, env = {}) {
  console.log(`${CYAN}→ ${cmd}${RESET}`);
  execSync(cmd, { cwd, stdio: "inherit", shell: true, env: { ...process.env, ...env } });
}

function capture(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: "utf8", shell: true }).trim();
}

function fail(msg) {
  console.error(`\n${RED}✗ BUILD FAILED: ${msg}${RESET}\n`);
  process.exit(1);
}

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot   = resolve(desktopDir, "..");
const frontendDir = resolve(repoRoot, "frontend");
const buildDir   = resolve(desktopDir, "build");
const releaseConfig = await loadReleaseConfig(desktopDir);
const VERSION = releaseConfig.version;

// ── Step 1: HEAD commit ───────────────────────────────────────────────────────
step(1, 7, "Resolving HEAD commit");
let commit;
try {
  commit = capture("git rev-parse HEAD", repoRoot);
} catch {
  fail("Not in a git repository. Cannot guarantee build integrity.");
}
console.log(`${GREEN}  commit = ${commit}${RESET}`);

const dirty = capture("git status --porcelain", repoRoot);
if (dirty) {
  fail("Release builds require a clean working tree so image metadata identifies the exact source.");
}
const manifest = createReleaseManifest(releaseConfig, commit);
try {
  await validateReleaseContract({ repoRoot, desktopDir, manifest });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

// ── Step 2: Vite build ────────────────────────────────────────────────────────
step(2, 7, "React → Vite → frontend/dist");
run("npm run build", frontendDir);

// ── Step 3: Docker images (frontend + backend) ───────────────────────────────
step(3, 7, "Docker: build exact packaged GHCR image references locally");
const buildEnvironment = { ...process.env };
execFileSync("docker", ["build", "--build-arg", `GIT_COMMIT=${commit}`, "--build-arg", `RELEASE_VERSION=${VERSION}`,
  "-t", manifest.frontend.versionRef, "-t", manifest.frontend.commitRef,
  "-f", "frontend/Dockerfile", "."], { cwd: repoRoot, stdio: "inherit", env: buildEnvironment });
execFileSync("docker", ["build", "--build-arg", `GIT_COMMIT=${commit}`, "--build-arg", `RELEASE_VERSION=${VERSION}`,
  "-t", manifest.backend.versionRef, "-t", manifest.backend.commitRef,
  "."], { cwd: resolve(repoRoot, "backend"), stdio: "inherit", env: buildEnvironment });
console.log(`${GREEN}  Built locally without pushing: ${manifest.frontend.versionRef}, ${manifest.backend.versionRef}${RESET}`);

// ── Step 4: Build-time verification ──────────────────────────────────────────
step(4, 7, "Verifying frontend and backend release metadata");
for (const component of ["frontend", "backend"]) {
  for (const ref of [manifest[component].versionRef, manifest[component].commitRef]) {
    try {
      const image = JSON.parse(execFileSync("docker", ["image", "inspect", ref], { cwd: repoRoot, encoding: "utf8" }))[0];
      verifyImageMetadata(image, manifest, component);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}
console.log(`${GREEN}  ✓ Both images match release ${VERSION} at ${commit}${RESET}`);

// ── Step 5: Write build/commit.json ──────────────────────────────────────────
step(5, 7, "Writing build/commit.json (included in asar)");
await mkdir(buildDir, { recursive: true });
await writeFile(
  resolve(buildDir, "commit.json"),
  JSON.stringify({ commit, builtAt: new Date().toISOString() }, null, 2) + "\n",
  "utf8",
);
await writeFile(resolve(buildDir, "release.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`${GREEN}  ✓ Wrote build/commit.json${RESET}`);

// ── Step 6: Compile Electron TypeScript ───────────────────────────────────────
step(6, 7, "Compiling Electron main + preload");
run("npm run build", desktopDir);

// ── Step 7: electron-builder ──────────────────────────────────────────────────
step(7, 7, "Packaging with electron-builder (dir + dmg + zip)");
run("electron-builder --mac dir dmg zip --arm64 --config electron-builder.yml", desktopDir);

const distDir = resolve(desktopDir, "dist");
const dmg = `${distDir}/Neuravian-${VERSION}-arm64.dmg`;
const zip = `${distDir}/Neuravian-${VERSION}-arm64-mac.zip`;

// Generate SHA-256 checksums.
step(7, 7, "Generating SHA256SUMS.txt");
const { createHash } = await import("node:crypto");
const { readFile: rf } = await import("node:fs/promises");
const lines = [];
for (const [file, name] of [[dmg, `Neuravian-${VERSION}-arm64.dmg`], [zip, `Neuravian-${VERSION}-arm64-mac.zip`]]) {
  try {
    const buf = await rf(file);
    const hash = createHash("sha256").update(buf).digest("hex");
    lines.push(`${hash}  ${name}`);
    console.log(`${GREEN}  ${hash}  ${name}${RESET}`);
  } catch {
    console.warn(`${YELLOW}  ⚠ Could not hash ${name} (file may not exist)${RESET}`);
  }
}
if (lines.length) {
  await writeFile(resolve(distDir, "SHA256SUMS.txt"), lines.join("\n") + "\n", "utf8");
  console.log(`${GREEN}  ✓ Wrote dist/SHA256SUMS.txt${RESET}`);
}

console.log(`\n${GREEN}${BOLD}✓ Full build complete at ${commit}${RESET}`);
console.log(`  Neuravian.app frontend is guaranteed to match HEAD.\n`);
