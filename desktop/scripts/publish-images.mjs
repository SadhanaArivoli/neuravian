#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyImageMetadata } from "./release-metadata.mjs";
import { verifyRemoteImages } from "./verify-release-images.mjs";

export function publishPlan(manifest, { publish = false, stable = false } = {}) {
  if (!publish) throw new Error("Publishing is disabled. Re-run with --publish after authenticating to GHCR.");
  const commands = [];
  for (const component of ["frontend", "backend"]) {
    commands.push(["push", manifest[component].versionRef], ["push", manifest[component].commitRef]);
    if (stable) {
      const latest = `${manifest[component].repository}:latest`;
      commands.push(["tag", manifest[component].versionRef, latest], ["push", latest]);
    }
  }
  return commands;
}

async function main() {
  const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await readFile(path.join(desktopDir, "build/release.json"), "utf8"));
  for (const component of ["frontend", "backend"]) {
    for (const ref of [manifest[component].versionRef, manifest[component].commitRef]) {
      const image = JSON.parse(execFileSync("docker", ["image", "inspect", ref], { encoding: "utf8" }))[0];
      verifyImageMetadata(image, manifest, component);
    }
  }
  const commands = publishPlan(manifest, {
    publish: process.argv.includes("--publish"),
    stable: process.argv.includes("--stable"),
  });
  for (const args of commands) execFileSync("docker", args, { stdio: "inherit" });
  verifyRemoteImages(manifest);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
