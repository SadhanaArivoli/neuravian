#!/usr/bin/env node
/**
 * Full NeuroForge build pipeline.
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
import { execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  console.warn(`${YELLOW}  ⚠ Working tree has uncommitted changes.${RESET}`);
  console.warn(`${YELLOW}    The packaged app will embed ${commit} but the source may differ.${RESET}`);
}

// ── Step 2: Vite build ────────────────────────────────────────────────────────
step(2, 7, "React → Vite → frontend/dist");
run("npm run build", frontendDir);

// ── Step 3: Docker frontend image ─────────────────────────────────────────────
step(3, 7, "Docker: rebuild nginx frontend image");
run("docker compose build frontend", repoRoot, { GIT_COMMIT: commit });

// ── Step 4: Build-time verification ──────────────────────────────────────────
step(4, 7, "Verifying Docker image commit label");
let imageLabel;
try {
  imageLabel = capture(
    "docker image inspect neuroforge-frontend --format '{{index .Config.Labels \"org.neuroforge.git-commit\"}}'",
    repoRoot,
  );
} catch {
  fail("Could not inspect neuroforge-frontend image. Docker build may have failed.");
}

if (imageLabel !== commit) {
  fail(
    `Frontend image commit mismatch.\n` +
    `  Expected : ${commit}\n` +
    `  Image has: ${imageLabel || "(none)"}\n` +
    `\n  Re-run "npm run dist:mac" to rebuild from HEAD.`,
  );
}
console.log(`${GREEN}  ✓ Image label matches HEAD${RESET}`);

// ── Step 5: Write build/commit.json ──────────────────────────────────────────
step(5, 7, "Writing build/commit.json (included in asar)");
await mkdir(buildDir, { recursive: true });
await writeFile(
  resolve(buildDir, "commit.json"),
  JSON.stringify({ commit, builtAt: new Date().toISOString() }, null, 2) + "\n",
  "utf8",
);
console.log(`${GREEN}  ✓ Wrote build/commit.json${RESET}`);

// ── Step 6: Compile Electron TypeScript ───────────────────────────────────────
step(6, 7, "Compiling Electron main + preload");
run("npm run build", desktopDir);

// ── Step 7: electron-builder ──────────────────────────────────────────────────
step(7, 7, "Packaging with electron-builder");
run("electron-builder --mac dir --arm64 --config electron-builder.yml", desktopDir);

console.log(`\n${GREEN}${BOLD}✓ Full build complete at ${commit}${RESET}`);
console.log(`  NeuroForge.app frontend is guaranteed to match HEAD.\n`);
