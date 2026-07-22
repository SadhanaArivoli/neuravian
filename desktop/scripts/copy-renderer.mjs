import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const source = resolve(desktopDir, "src", "renderer");
const destination = resolve(desktopDir, "build", "renderer");

await mkdir(destination, { recursive: true });
// Remove any stale pre-release splash asset so electron-builder cannot retain
// it in app.asar when packaging over an existing build directory.
await rm(resolve(destination, "neuroforge-splash.png"), { force: true });
for (const filename of ["index.html", "styles.css", "app.js"]) {
  await cp(resolve(source, filename), resolve(destination, filename));
}
await cp(
  resolve(desktopDir, "assets", "neuravian-splash.png"),
  resolve(destination, "neuravian-splash.png"),
);
