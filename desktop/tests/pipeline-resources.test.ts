/**
 * Verifies that pipelines/schema/*.json files are bundled and recursively copied.
 *
 * Root cause: electron-builder filtered pipelines to *.yaml / *.yml only, so
 * manifest.schema.json and plugin.schema.json were silently dropped from the
 * bundle and never reached the container's /pipelines/schema/ directory.
 */
import { cp, mkdir, readFile, rm, mkdtemp } from "node:fs/promises";
import { access, constants } from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fsAccess = promisify(access);

const DESKTOP_DIR = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..");

const REPO_PIPELINES = path.join(REPO_ROOT, "pipelines");
const REPO_SCHEMA_DIR = path.join(REPO_PIPELINES, "schema");
const MANIFEST_SCHEMA = path.join(REPO_SCHEMA_DIR, "manifest.schema.json");
const PLUGIN_SCHEMA = path.join(REPO_SCHEMA_DIR, "plugin.schema.json");

const BUILDER_CONFIG = path.join(DESKTOP_DIR, "electron-builder.yml");

const DIST_PIPELINES = path.join(
  DESKTOP_DIR,
  "dist/mac-arm64/Neuravian.app/Contents/Resources/app-resources/pipelines",
);

// ---------------------------------------------------------------------------
// Source files must exist in the repository
// ---------------------------------------------------------------------------
describe("repository — pipelines/schema source files", () => {
  it("manifest.schema.json exists in the repo", async () => {
    await expect(
      fsAccess(MANIFEST_SCHEMA, constants.R_OK),
    ).resolves.toBeUndefined();
  });

  it("plugin.schema.json exists in the repo", async () => {
    await expect(
      fsAccess(PLUGIN_SCHEMA, constants.R_OK),
    ).resolves.toBeUndefined();
  });

  it("manifest.schema.json is valid JSON", async () => {
    const text = await readFile(MANIFEST_SCHEMA, "utf8");
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// electron-builder.yml must not filter out json files
// ---------------------------------------------------------------------------
describe("electron-builder.yml — pipelines filter", () => {
  it("does not restrict pipelines to yaml/yml only", async () => {
    const text = await readFile(BUILDER_CONFIG, "utf8");
    // Locate the pipelines extraResource block and check that a yaml-only
    // filter has not been re-introduced.
    const lines = text.split("\n");
    const pipelinesIdx = lines.findIndex((l) => l.includes("app-resources/pipelines"));
    // Grab the next few lines to check for a filter block.
    const block = lines.slice(pipelinesIdx, pipelinesIdx + 10).join("\n");
    // A filter that includes only yaml/yml would exclude json schema files.
    expect(block).not.toMatch(/filter:[\s\S]*\*\*\/\*\.ya?ml[\s\S]*(?!json)/);
  });

  it("does not have a yaml-only filter that would exclude json schema files", async () => {
    const text = await readFile(BUILDER_CONFIG, "utf8");
    // If both a yaml filter AND a json filter are present that is fine.
    // The failure case is yaml filter present with NO json filter.
    const hasPipelinesYamlFilter = /from: \.\.\/pipelines[\s\S]*?filter:[\s\S]*?\*\*\/\*\.ya?ml/m.test(text);
    const hasPipelinesJsonFilter = /from: \.\.\/pipelines[\s\S]*?filter:[\s\S]*?\*\*\/\*\.json/m.test(text);
    if (hasPipelinesYamlFilter) {
      // If there is a yaml filter, json must also be present.
      expect(hasPipelinesJsonFilter).toBe(true);
    }
    // If there is no yaml filter at all (filter removed), that is also fine.
  });
});

// ---------------------------------------------------------------------------
// Built bundle must include the json schema files
// ---------------------------------------------------------------------------
describe("built .app bundle — pipelines/schema", () => {
  async function bundlePresent(): Promise<boolean> {
    try {
      await fsAccess(DIST_PIPELINES, constants.R_OK);
      return true;
    } catch { return false; }
  }

  it("bundles manifest.schema.json", async () => {
    if (!await bundlePresent()) {
      console.log("[skip] dist/ not present; run electron-builder first");
      return;
    }
    await expect(
      fsAccess(path.join(DIST_PIPELINES, "schema", "manifest.schema.json"), constants.R_OK),
    ).resolves.toBeUndefined();
  });

  it("bundles plugin.schema.json", async () => {
    if (!await bundlePresent()) {
      console.log("[skip] dist/ not present; run electron-builder first");
      return;
    }
    await expect(
      fsAccess(path.join(DIST_PIPELINES, "schema", "plugin.schema.json"), constants.R_OK),
    ).resolves.toBeUndefined();
  });

  it("schema/artifact_types.yaml is also present", async () => {
    if (!await bundlePresent()) return;
    await expect(
      fsAccess(path.join(DIST_PIPELINES, "schema", "artifact_types.yaml"), constants.R_OK),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Startup copy — fs.cp recursive copies nested json files
// ---------------------------------------------------------------------------
describe("startup resource copy — recursive schema copy", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeSourceTree(): Promise<string> {
    const src = await mkdtemp(path.join(os.tmpdir(), "neuravian-src-"));
    tmpDirs.push(src);
    const schema = path.join(src, "pipelines", "schema");
    await mkdir(schema, { recursive: true });
    await Promise.all([
      import("node:fs/promises").then(({ writeFile }) => Promise.all([
        writeFile(path.join(src, "pipelines", "mriqc.yaml"), "name: mriqc\n"),
        writeFile(path.join(schema, "manifest.schema.json"), '{"$schema":"http://json-schema.org/draft-07/schema"}'),
        writeFile(path.join(schema, "plugin.schema.json"), '{"$schema":"http://json-schema.org/draft-07/schema"}'),
        writeFile(path.join(schema, "artifact_types.yaml"), "types: []\n"),
      ])),
    ]);
    return src;
  }

  it("cp recursive copies manifest.schema.json into the destination", async () => {
    const src = await makeSourceTree();
    const dst = await mkdtemp(path.join(os.tmpdir(), "neuravian-dst-"));
    tmpDirs.push(dst);

    await cp(
      path.join(src, "pipelines"),
      path.join(dst, "pipelines"),
      { recursive: true, force: true, errorOnExist: false },
    );

    await expect(
      fsAccess(path.join(dst, "pipelines", "schema", "manifest.schema.json"), constants.R_OK),
    ).resolves.toBeUndefined();
  });

  it("cp recursive copies plugin.schema.json into the destination", async () => {
    const src = await makeSourceTree();
    const dst = await mkdtemp(path.join(os.tmpdir(), "neuravian-dst-"));
    tmpDirs.push(dst);

    await cp(
      path.join(src, "pipelines"),
      path.join(dst, "pipelines"),
      { recursive: true, force: true, errorOnExist: false },
    );

    await expect(
      fsAccess(path.join(dst, "pipelines", "schema", "plugin.schema.json"), constants.R_OK),
    ).resolves.toBeUndefined();
  });

  it("cp force:true refreshes a stale existing file", async () => {
    const src = await makeSourceTree();
    const dst = await mkdtemp(path.join(os.tmpdir(), "neuravian-dst-"));
    tmpDirs.push(dst);

    // Pre-populate the destination with an old (wrong) version.
    const staleSchema = path.join(dst, "pipelines", "schema");
    await mkdir(staleSchema, { recursive: true });
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(path.join(staleSchema, "manifest.schema.json"), '{"stale":true}'),
    );

    // Copy again with force:true — should overwrite.
    await cp(
      path.join(src, "pipelines"),
      path.join(dst, "pipelines"),
      { recursive: true, force: true, errorOnExist: false },
    );

    const text = await readFile(
      path.join(dst, "pipelines", "schema", "manifest.schema.json"),
      "utf8",
    );
    expect(text).not.toContain('"stale":true');
    expect(text).toContain("json-schema.org");
  });

  it("cp copies yaml manifests alongside json schema files", async () => {
    const src = await makeSourceTree();
    const dst = await mkdtemp(path.join(os.tmpdir(), "neuravian-dst-"));
    tmpDirs.push(dst);

    await cp(
      path.join(src, "pipelines"),
      path.join(dst, "pipelines"),
      { recursive: true, force: true, errorOnExist: false },
    );

    await expect(
      fsAccess(path.join(dst, "pipelines", "mriqc.yaml"), constants.R_OK),
    ).resolves.toBeUndefined();
    await expect(
      fsAccess(path.join(dst, "pipelines", "schema", "artifact_types.yaml"), constants.R_OK),
    ).resolves.toBeUndefined();
  });
});
