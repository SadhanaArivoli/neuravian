#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyImageMetadata } from "./release-metadata.mjs";

export function verifyRemoteImages(manifest, runner = execFileSync) {
  const verified = {};
  for (const component of ["frontend", "backend"]) {
    for (const ref of [manifest[component].versionRef, manifest[component].commitRef]) {
      runner("docker", ["pull", ref], { stdio: "inherit" });
      const raw = runner("docker", ["image", "inspect", ref], { encoding: "utf8" });
      const image = JSON.parse(raw)[0];
      verified[`${component}:${ref}`] = verifyImageMetadata(image, manifest, component);
    }
  }
  return verified;
}

async function main() {
  const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await readFile(path.join(desktopDir, "build/release.json"), "utf8"));
  const verified = verifyRemoteImages(manifest);
  console.log(JSON.stringify({ release: manifest, verified }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
