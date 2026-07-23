import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const desktopDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(desktopDir, "..");
const forbidden = ["/Users/sadhanaarivoli", "/Users/arivolitirouvingadame"];

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  await walk(root);
  return files;
}

describe("packaged configuration path safety", () => {
  it("does not package a repository or developer .env file", async () => {
    const builder = await readFile(path.join(desktopDir, "electron-builder.yml"), "utf8");
    expect(builder).not.toMatch(/from:\s*\.\.\/\.env/m);
    expect(builder).not.toMatch(/to:\s*.*\.env/m);
    const extraResourceSources = [
      path.join(desktopDir, "docker-compose.packaged.yml"),
      path.join(repoRoot, "pipelines"),
      path.join(repoRoot, "plugins"),
    ];
    for (const source of extraResourceSources) {
      const names = (await collectFiles(source)).map((file) => path.basename(file));
      expect(names.some((name) => name === ".env" || name.startsWith(".env."))).toBe(false);
    }
  });

  it("contains no known developer home in packaged production inputs", async () => {
    const productionInputs = [
      path.join(desktopDir, "docker-compose.packaged.yml"),
      path.join(desktopDir, "electron-builder.yml"),
      path.join(desktopDir, "src"),
      path.join(repoRoot, "pipelines"),
      path.join(repoRoot, "plugins"),
    ];
    for (const input of productionInputs) {
      const files = (await access(input).then(() => collectFiles(input)).catch(() => [input]));
      for (const file of files.length ? files : [input]) {
        const content = await readFile(file).catch(() => Buffer.alloc(0));
        for (const value of forbidden) expect(content.includes(Buffer.from(value)), `${file} contains ${value}`).toBe(false);
      }
    }
  });

  it("contains no developer home or .env in the generated app when present", async () => {
    const resources = path.join(desktopDir, "dist/mac-arm64/Neuravian.app/Contents/Resources");
    const files = await collectFiles(resources);
    if (!files.length) return;
    for (const file of files) {
      expect(path.basename(file)).not.toMatch(/^\.env(?:\.|$)/);
      const content = await readFile(file);
      for (const value of forbidden) expect(content.includes(Buffer.from(value)), `${file} contains ${value}`).toBe(false);
    }
  });
});
