import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const expectedLogoHash = "75a612dbf10c1f05a26366f38243f00b27cbe6fc5bb18ec64197533826b6660f";

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

describe("desktop artwork", () => {
  it.each(["neuravian-logo.png", "neuravian-window.png", "neuravian-splash.png"])(
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
    const icon = await stat(path.join(desktopRoot, "assets", "Neuravian.icns"));
    expect(icon.size).toBeGreaterThan(0);
  });
});

describe("startup shell", () => {
  it("renders the supplied logo and local-data assurance", async () => {
    const html = await readFile(path.join(desktopRoot, "src", "renderer", "index.html"), "utf8");
    expect(html).toContain('src="neuravian-splash.png"');
    expect(html).toContain("does not upload your datasets");
  });
});
