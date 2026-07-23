import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export async function canonicalDirectory(value: string): Promise<string> {
  if (!value || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error("Dataset root must be an absolute directory path.");
  }
  const resolved = await realpath(path.resolve(value));
  if (!(await stat(resolved)).isDirectory()) throw new Error("Dataset root must be a directory.");
  return resolved;
}

export function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function belongsToDifferentMacUser(candidate: string, currentHome: string): boolean {
  if (!candidate.startsWith("/Users/")) return false;
  return !isPathWithin(candidate, currentHome);
}
