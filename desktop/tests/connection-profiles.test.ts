import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConnectionProfileStore,
  CredentialDecryptionError,
  type CredentialCipher,
} from "../src/main/connection-profiles.js";

const cipher: CredentialCipher = {
  available: () => true,
  encrypt: (value) => Buffer.from(value.split("").reverse().join("")),
  decrypt: (value) => value.toString().split("").reverse().join(""),
};

describe("connection profiles", () => {
  it("stores profile metadata separately from encrypted credentials", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nf-profile-"));
    const store = new ConnectionProfileStore(root, cipher);
    const profile = await store.save({
      name: "AWS EC2",
      serverUrl: "https://example.org/",
      username: "researcher",
      password: "not-plaintext",
    });

    expect(profile.serverUrl).toBe("https://example.org");
    expect(await store.credential(profile.id)).toEqual({
      username: "researcher",
      password: "not-plaintext",
    });
    expect(await readFile(store.profilesPath, "utf8")).not.toContain("not-plaintext");
    expect(await readFile(store.credentialsPath, "utf8")).not.toContain("not-plaintext");
  });

  it("rejects non-loopback plaintext HTTP", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nf-profile-"));
    const store = new ConnectionProfileStore(root, cipher);
    await expect(store.save({ name: "Unsafe", serverUrl: "http://example.org" }))
      .rejects.toThrow("require HTTPS");
    await expect(store.save({ name: "Local", serverUrl: "http://127.0.0.1:8000" }))
      .resolves.toMatchObject({ serverUrl: "http://127.0.0.1:8000" });
  });

  it("fails closed when the operating-system credential store is unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nf-profile-"));
    const store = new ConnectionProfileStore(root, { ...cipher, available: () => false });
    await expect(store.save({
      name: "AWS",
      serverUrl: "https://example.org",
      username: "user",
      password: "secret",
    })).rejects.toThrow("credential store is unavailable");
  });

  it("throws CredentialDecryptionError when safeStorage rejects decryption (cross-bundle-ID)", async () => {
    // Simulate the NeuroForge → Neuravian bundle-ID migration:
    // credentials were encrypted by the old app identity and cannot be decrypted by the new one.
    const root = await mkdtemp(path.join(tmpdir(), "nf-profile-"));
    const encryptingCipher: CredentialCipher = {
      available: () => true,
      encrypt: (v) => Buffer.from(v),
      decrypt: () => { throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString."); },
    };
    const store = new ConnectionProfileStore(root, encryptingCipher);
    const profile = await store.save({
      name: "AWS",
      serverUrl: "https://example.org",
      username: "researcher",
      password: "secret",
    });
    await expect(store.credential(profile.id)).rejects.toBeInstanceOf(CredentialDecryptionError);
    await expect(store.credential(profile.id)).rejects.toThrow("could not be decrypted");
    // Profile metadata (name, url, etc.) is still readable despite the broken credential.
    const profiles = await store.list();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe("AWS");
    expect(profiles[0].serverUrl).toBe("https://example.org");
  });

  it("returns null when cipher is unavailable (does not reach decrypt)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nf-profile-"));
    const unavailableCipher: CredentialCipher = {
      available: () => false,
      encrypt: () => Buffer.alloc(0),
      decrypt: () => { throw new Error("should not be called"); },
    };
    const store = new ConnectionProfileStore(root, unavailableCipher);
    expect(await store.credential("nonexistent-id")).toBeNull();
  });

  it("returns null when no credential has been stored for a profile ID", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nf-profile-"));
    const store = new ConnectionProfileStore(root, cipher);
    await store.save({ name: "No-auth workspace", serverUrl: "https://example.org" });
    const profiles = await store.list();
    expect(await store.credential(profiles[0].id)).toBeNull();
  });
});
