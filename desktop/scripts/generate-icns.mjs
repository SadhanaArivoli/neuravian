import { readFile, writeFile } from "node:fs/promises";
import png2icons from "png2icons";

const [, , sourcePath, outputPath] = process.argv;
if (!sourcePath || !outputPath) {
  throw new Error("Usage: node generate-icns.mjs source.png output.icns");
}

const source = await readFile(sourcePath);
const output = png2icons.createICNS(source, png2icons.BILINEAR, 0);
if (!output) throw new Error("png2icons could not create an ICNS asset");
await writeFile(outputPath, output);
