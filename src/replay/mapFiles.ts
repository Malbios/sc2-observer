import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * The map a replay asks for, found in the maps folder.
 *
 * A replay names its map by the path it had where it was recorded, such as
 * `Melee/Flat128.SC2Map` from Blizzard's map pack layout, and the client in
 * the container opens exactly that path, case-sensitively. So the exact path
 * is tried first, then the file name anywhere in the folder, ignoring case.
 */
export function findMapFile(mapsDir: string, requested: string): string | null {
  const exact = join(mapsDir, requested);
  if (requested !== "" && existsWithExactName(exact)) return exact;

  const wanted = basename(requested.replace(/\\/g, "/")).toLowerCase();
  if (wanted === "") return null;
  return findByName(mapsDir, wanted);
}

/** Windows finds a file whatever the letter case; SC2 on Linux does not. */
function existsWithExactName(file: string): boolean {
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  try {
    return readdirSync(dirname(file)).includes(basename(file));
  } catch {
    return false;
  }
}

function findByName(dir: string, wanted: string): string | null {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const file = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === wanted);
  if (file) return join(dir, file.name);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findByName(join(dir, entry.name), wanted);
    if (found) return found;
  }
  return null;
}
