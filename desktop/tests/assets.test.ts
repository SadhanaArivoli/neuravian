import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const expectedLogoHash = "6a074630ce385e74cba906861af4f3ae8e72840ff53172438f9b888a908d0cf3";

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

describe("desktop artwork", () => {
  it.each(["neuroforge-logo.png", "neuroforge-window.png", "neuroforge-splash.png"])(
    "preserves the supplied logo bytes in %s",
    async (fileName) => {
      expect(await sha256(path.join(desktopRoot, "assets", fileName))).toBe(expectedLogoHash);
    },
  );

  it.each([16, 32, 64, 128, 256, 512, 1024])(
    "includes the %d-pixel PNG icon",
    async (size) => {
      const icon = await stat(path.join(desktopRoot, "assets", "icons", `${size}x${size}.png`));
      expect(icon.size).toBeGreaterThan(0);
    },
  );

  it("includes a generated macOS ICNS file", async () => {
    const icon = await stat(path.join(desktopRoot, "assets", "NeuroForge.icns"));
    expect(icon.size).toBeGreaterThan(0);
  });
});

describe("startup shell", () => {
  it("renders the supplied logo and local-data assurance", async () => {
    const html = await readFile(path.join(desktopRoot, "src", "renderer", "index.html"), "utf8");
    expect(html).toContain('src="neuroforge-splash.png"');
    expect(html).toContain("does not upload your datasets");
  });
});
