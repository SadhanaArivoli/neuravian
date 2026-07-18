import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConnectionProfileStore,
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
});
