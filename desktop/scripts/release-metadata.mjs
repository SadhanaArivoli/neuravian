import { readFile } from "node:fs/promises";
import path from "node:path";

export async function loadReleaseConfig(desktopDir) {
  return JSON.parse(await readFile(path.join(desktopDir, "release.config.json"), "utf8"));
}

export function createReleaseManifest(config, commit) {
  const base = `${config.registry}/${config.namespace}`;
  return {
    schemaVersion: 1,
    version: config.version,
    commit,
    frontend: {
      repository: `${base}/${config.frontendRepository}`,
      versionRef: `${base}/${config.frontendRepository}:${config.version}`,
      commitRef: `${base}/${config.frontendRepository}:${commit}`,
    },
    backend: {
      repository: `${base}/${config.backendRepository}`,
      versionRef: `${base}/${config.backendRepository}:${config.version}`,
      commitRef: `${base}/${config.backendRepository}:${commit}`,
    },
  };
}

export async function validateReleaseContract({ repoRoot, desktopDir, manifest }) {
  const [desktopPackage, frontendPackage, backendPyproject, packagedCompose] = await Promise.all([
    readFile(path.join(desktopDir, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(repoRoot, "frontend/package.json"), "utf8").then(JSON.parse),
    readFile(path.join(repoRoot, "backend/pyproject.toml"), "utf8"),
    readFile(path.join(desktopDir, "docker-compose.packaged.yml"), "utf8"),
  ]);
  const backendVersion = backendPyproject.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const versions = {
    release: manifest.version,
    desktop: desktopPackage.version,
    frontend: frontendPackage.version,
    backend: backendVersion,
  };
  if (new Set(Object.values(versions)).size !== 1) {
    throw new Error(`Release version mismatch: ${JSON.stringify(versions)}`);
  }
  // docker-compose.packaged.yml stays static and never hardcodes a tag — it references these
  // env vars, which the Electron main process resolves to the exact commit-pinned image at
  // startup (see compose.ts imageReferences()). This check only guards against the file
  // regressing back to a hardcoded (and therefore mutable-tag-vulnerable) image reference.
  for (const [component, envVar] of [
    ["frontend", "NEURAVIAN_FRONTEND_IMAGE"],
    ["backend", "NEURAVIAN_BACKEND_IMAGE"],
  ]) {
    const expected = `image: \${${envVar}}`;
    if (!packagedCompose.includes(expected)) {
      throw new Error(`Packaged Compose ${component} image must reference \${${envVar}}, not a hardcoded tag.`);
    }
  }
  return versions;
}

export function expectedLabels(manifest, component) {
  return {
    "org.neuravian.component": component,
    "org.neuravian.git-commit": manifest.commit,
    "org.neuravian.release-version": manifest.version,
    "org.opencontainers.image.version": manifest.version,
    "org.opencontainers.image.revision": manifest.commit,
  };
}

export function verifyImageMetadata(image, manifest, component) {
  const labels = image?.Config?.Labels ?? {};
  const mismatches = [];
  for (const [name, expected] of Object.entries(expectedLabels(manifest, component))) {
    if (labels[name] !== expected) mismatches.push(`${name}: expected ${expected}; found ${labels[name] ?? "missing"}`);
  }
  if (mismatches.length) throw new Error(`${component} image metadata mismatch: ${mismatches.join("; ")}`);
  return { imageId: image.Id, repoDigests: image.RepoDigests ?? [], labels };
}
