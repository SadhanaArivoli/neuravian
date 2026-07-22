import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceCredential, WorkspaceProfile } from "./workspace-types.js";

export interface CredentialCipher {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

/**
 * Thrown by `ConnectionProfileStore.credential()` when a stored ciphertext
 * exists but cannot be decrypted by the running application identity.
 *
 * This happens after a bundle-ID rename (e.g. org.neuroforge.desktop →
 * org.neuravian.desktop): macOS safeStorage ties ciphertext to the
 * originating bundle ID, so the new app cannot read what the old one wrote.
 * All non-secret workspace metadata remains intact and should be shown from
 * cache. The user only needs to re-enter the affected credential.
 */
export class CredentialDecryptionError extends Error {
  readonly profileId: string;
  constructor(profileId: string, cause: unknown) {
    super(`Stored credential for workspace ${profileId} could not be decrypted. ` +
      `This usually means the credential was saved by a different application identity ` +
      `(bundle ID changed). Please re-enter your username and password.`);
    this.name = "CredentialDecryptionError";
    this.profileId = profileId;
    this.cause = cause;
  }
}

interface StoredCredential {
  profileId: string;
  ciphertext: string;
}

function normalizeServerUrl(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("Workspace connections require HTTPS; HTTP is allowed only for loopback.");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

async function atomicJson(file: string, value: unknown, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, file);
}

export class ConnectionProfileStore {
  readonly profilesPath: string;
  readonly credentialsPath: string;

  constructor(
    root: string,
    private readonly cipher: CredentialCipher,
  ) {
    this.profilesPath = path.join(root, "workspace-profiles.json");
    this.credentialsPath = path.join(root, "workspace-credentials.json");
  }

  async list(): Promise<WorkspaceProfile[]> {
    const parsed = JSON.parse(await readFile(this.profilesPath, "utf8").catch(() => "[]")) as unknown;
    return Array.isArray(parsed) ? parsed as WorkspaceProfile[] : [];
  }

  async save(input: {
    id?: string;
    name: string;
    serverUrl: string;
    username?: string;
    password?: string;
    connectionMode?: "url" | "instance-id";
    instanceId?: string | null;
    awsRegion?: string | null;
  }): Promise<WorkspaceProfile> {
    const profiles = await this.list();
    const existing = input.id ? profiles.find((profile) => profile.id === input.id) : undefined;
    const id = existing?.id ?? randomUUID();
    const hasCredential = input.username !== undefined || input.password !== undefined;
    if (hasCredential && (!input.username || !input.password)) {
      throw new Error("Both username and password are required.");
    }
    if (hasCredential && !this.cipher.available()) {
      throw new Error("The operating-system credential store is unavailable.");
    }
    const connectionMode = input.connectionMode ?? existing?.connectionMode ?? "url";
    const profile: WorkspaceProfile = {
      id,
      name: input.name.trim() || "Neuravian Workspace",
      serverUrl: connectionMode === "instance-id" ? input.serverUrl : normalizeServerUrl(input.serverUrl),
      authenticationRef: hasCredential ? `os-credential:${id}` : existing?.authenticationRef ?? null,
      serverIdentity: connectionMode === "instance-id" ? null : (existing?.serverIdentity ?? null),
      lastSync: existing?.lastSync ?? null,
      connectionState: existing?.connectionState ?? "offline",
      connectionMode,
      instanceId: input.instanceId ?? existing?.instanceId ?? null,
      awsRegion: input.awsRegion ?? existing?.awsRegion ?? null,
    };
    const nextProfiles = [...profiles.filter((item) => item.id !== id), profile];
    await atomicJson(this.profilesPath, nextProfiles);
    if (hasCredential) await this.writeCredential(id, {
      username: input.username!,
      password: input.password!,
    });
    return profile;
  }

  async duplicate(profileId: string): Promise<WorkspaceProfile> {
    const profiles = await this.list();
    const source = profiles.find((item) => item.id === profileId);
    if (!source) throw new Error("Workspace profile not found.");
    const newId = randomUUID();
    const copy: WorkspaceProfile = {
      ...source,
      id: newId,
      name: `Copy of ${source.name}`,
      serverIdentity: null,
      lastSync: null,
      connectionState: "offline",
      authenticationRef: source.authenticationRef ? `os-credential:${newId}` : null,
    };
    if (source.authenticationRef) {
      const credential = await this.credential(profileId);
      if (credential) await this.writeCredential(newId, credential);
    }
    await atomicJson(this.profilesPath, [...profiles, copy]);
    return copy;
  }

  async clearCredential(profileId: string): Promise<void> {
    const profiles = await this.list();
    const profile = profiles.find((item) => item.id === profileId);
    if (profile) {
      await this.update({ ...profile, authenticationRef: null });
    }
    await atomicJson(this.credentialsPath, (await this.readCredentials()).filter(
      (item) => item.profileId !== profileId,
    ));
  }

  exportProfile(profile: WorkspaceProfile): Record<string, unknown> {
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      name: profile.name,
      serverUrl: profile.serverUrl,
      connectionMode: profile.connectionMode ?? "url",
      instanceId: profile.instanceId ?? null,
      awsRegion: profile.awsRegion ?? null,
    };
  }

  async update(profile: WorkspaceProfile): Promise<void> {
    const profiles = await this.list();
    if (!profiles.some((item) => item.id === profile.id)) throw new Error("Workspace profile not found.");
    await atomicJson(this.profilesPath, [
      ...profiles.filter((item) => item.id !== profile.id),
      profile,
    ]);
  }

  async credential(profileId: string): Promise<WorkspaceCredential | null> {
    if (!this.cipher.available()) return null;
    const stored = await this.readCredentials();
    const match = stored.find((item) => item.profileId === profileId);
    if (!match) return null;
    try {
      return JSON.parse(this.cipher.decrypt(Buffer.from(match.ciphertext, "base64"))) as WorkspaceCredential;
    } catch (cause) {
      throw new CredentialDecryptionError(profileId, cause);
    }
  }

  async remove(profileId: string): Promise<void> {
    await atomicJson(this.profilesPath, (await this.list()).filter((item) => item.id !== profileId));
    await atomicJson(this.credentialsPath, (await this.readCredentials()).filter(
      (item) => item.profileId !== profileId,
    ));
  }

  private async readCredentials(): Promise<StoredCredential[]> {
    const parsed = JSON.parse(await readFile(this.credentialsPath, "utf8").catch(() => "[]")) as unknown;
    return Array.isArray(parsed) ? parsed as StoredCredential[] : [];
  }

  private async writeCredential(profileId: string, credential: WorkspaceCredential): Promise<void> {
    const credentials = await this.readCredentials();
    const ciphertext = this.cipher.encrypt(JSON.stringify(credential)).toString("base64");
    await atomicJson(this.credentialsPath, [
      ...credentials.filter((item) => item.profileId !== profileId),
      { profileId, ciphertext },
    ]);
  }
}
