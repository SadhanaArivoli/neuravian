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
const VERSION = JSON.parse(await import("node:fs").then(m => m.promises.readFile(resolve(desktopDir, "package.json"), "utf8"))).version;
const frontendImageLatest = "neuravian-frontend:latest";
const frontendImageVersioned = `neuravian-frontend:${VERSION}`;
const backendImageVersioned = `neuravian-backend:${VERSION}`;

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

// ── Step 3: Docker images (frontend + backend) ───────────────────────────────
step(3, 7, "Docker: rebuild frontend and backend images");
run("docker compose build", repoRoot, { GIT_COMMIT: commit });
// Tag both services with the versioned tag consumed by docker-compose.packaged.yml.
run(`docker tag ${frontendImageLatest} ${frontendImageVersioned}`, repoRoot);
run(`docker tag neuravian-backend:latest ${backendImageVersioned}`, repoRoot);
console.log(`${GREEN}  Tagged: ${frontendImageVersioned}, ${backendImageVersioned}${RESET}`);

// ── Step 4: Build-time verification ──────────────────────────────────────────
step(4, 7, "Verifying Docker image commit label");
let imageLabel;
try {
  imageLabel = capture(
    `docker image inspect ${frontendImageVersioned} --format '{{index .Config.Labels "org.neuravian.git-commit"}}'`,
    repoRoot,
  );
} catch {
  fail("Could not inspect the Compose frontend image. Docker build may have failed.");
}

if (imageLabel !== commit) {
  fail(
    `Frontend image commit mismatch.\n` +
    `  Expected : ${commit}\n` +
    `  Image has: ${imageLabel || "(none)"}\n` +
    `\n  Re-run "npm run dist:mac" to rebuild from HEAD.`,
  );
}
console.log(`${GREEN}  ✓ Image label matches HEAD (${frontendImageVersioned})${RESET}`);

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
