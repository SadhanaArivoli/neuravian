import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const source = resolve(desktopDir, "src", "renderer");
const destination = resolve(desktopDir, "build", "renderer");

await mkdir(destination, { recursive: true });
for (const filename of ["index.html", "styles.css", "app.js"]) {
  await cp(resolve(source, filename), resolve(destination, filename));
}
await cp(
  resolve(desktopDir, "assets", "neuroforge-splash.png"),
  resolve(destination, "neuroforge-splash.png"),
);
