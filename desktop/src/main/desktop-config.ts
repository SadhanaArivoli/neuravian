import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { belongsToDifferentMacUser, canonicalDirectory } from "./dataset-root.js";

export interface DesktopConfig {
  datasetsDir: string;
}

interface StoredConfig {
  version: number;
  datasetsDir: string;
}

const CONFIG_VERSION = 1;

export interface DesktopConfigContext {
  documentsPath: string;
  homePath: string;
  onMigration?: (message: string) => void;
}

async function defaultDatasetsDir(context: DesktopConfigContext): Promise<string> {
  return canonicalDirectory(context.documentsPath);
}

export async function loadDesktopConfig(userDataPath: string, context: DesktopConfigContext): Promise<DesktopConfig> {
  const configPath = path.join(userDataPath, "config.json");
  try {
    const raw = JSON.parse(await readFile(configPath, "utf-8")) as StoredConfig;
    if (typeof raw.version !== "number" || raw.version !== CONFIG_VERSION || !raw.datasetsDir) {
      const defaults = { datasetsDir: await defaultDatasetsDir(context) };
      await saveDesktopConfig(userDataPath, defaults);
      return defaults;
    }
    let canonical: string;
    try {
      canonical = await canonicalDirectory(raw.datasetsDir);
    } catch {
      canonical = "";
    }
    if (!canonical || belongsToDifferentMacUser(canonical, context.homePath)) {
      const fresh = { datasetsDir: await defaultDatasetsDir(context) };
      context.onMigration?.(`Stale dataset root migrated from ${raw.datasetsDir} to ${fresh.datasetsDir}`);
      await saveDesktopConfig(userDataPath, fresh);
      return fresh;
    }
    if (canonical !== raw.datasetsDir) await saveDesktopConfig(userDataPath, { datasetsDir: canonical });
    return { datasetsDir: canonical };
  } catch {
    const defaults = { datasetsDir: await defaultDatasetsDir(context) };
    await saveDesktopConfig(userDataPath, defaults);
    return defaults;
  }
}

export async function saveDesktopConfig(userDataPath: string, config: DesktopConfig): Promise<void> {
  await mkdir(userDataPath, { recursive: true });
  const stored: StoredConfig = { version: CONFIG_VERSION, datasetsDir: await canonicalDirectory(config.datasetsDir) };
  await writeFile(path.join(userDataPath, "config.json"), JSON.stringify(stored, null, 2));
}
