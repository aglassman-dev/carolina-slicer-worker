import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type SlicerProfile = Record<string, unknown> & {
  name?: string;
  type?: string;
  inherits?: string;
  include?: string[];
};

interface IndexedProfile {
  filePath: string;
  profile: SlicerProfile;
}

export interface ResolvedProfile {
  sourcePath: string;
  profile: SlicerProfile;
  sha256: string;
}

async function jsonFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) return jsonFiles(filePath);
    return entry.isFile() && entry.name.toLowerCase().endsWith(".json") ? [filePath] : [];
  }));
  return nested.flat();
}

function withoutInheritance(profile: SlicerProfile) {
  const resolved = { ...profile };
  delete resolved.inherits;
  delete resolved.include;
  return resolved;
}

function profileHash(profile: SlicerProfile) {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}

export async function resolveSlicerProfile(input: { profilePath: string; searchRoots: string[]; overrides?: SlicerProfile }): Promise<ResolvedProfile> {
  const roots = [...new Set([path.dirname(input.profilePath), ...input.searchRoots])];
  const paths = (await Promise.all(roots.map((root) => jsonFiles(root)))).flat();
  const registry = new Map<string, IndexedProfile>();

  for (const filePath of paths) {
    const profile = JSON.parse(await readFile(filePath, "utf8")) as SlicerProfile;
    if (profile.name && !registry.has(profile.name)) registry.set(profile.name, { filePath, profile });
  }

  const target = JSON.parse(await readFile(input.profilePath, "utf8")) as SlicerProfile;
  const cache = new Map<string, SlicerProfile>();

  function resolve(profile: SlicerProfile, sourcePath: string, stack: string[]): SlicerProfile {
    const cacheKey = `${profile.type ?? "unknown"}:${profile.name ?? sourcePath}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    if (stack.includes(cacheKey)) throw new Error(`Circular slicer profile inheritance: ${[...stack, cacheKey].join(" -> ")}`);

    const nextStack = [...stack, cacheKey];
    let resolved: SlicerProfile = {};
    if (profile.inherits) {
      const parent = registry.get(profile.inherits);
      if (!parent) throw new Error(`Missing inherited slicer profile "${profile.inherits}" required by ${profile.name ?? sourcePath}.`);
      resolved = { ...resolved, ...resolve(parent.profile, parent.filePath, nextStack) };
    }
    for (const includeName of profile.include ?? []) {
      const included = registry.get(includeName);
      if (!included) throw new Error(`Missing included slicer profile "${includeName}" required by ${profile.name ?? sourcePath}.`);
      resolved = { ...resolved, ...resolve(included.profile, included.filePath, nextStack) };
    }
    resolved = { ...resolved, ...withoutInheritance(profile) };
    cache.set(cacheKey, resolved);
    return resolved;
  }

  const profile = { ...resolve(target, input.profilePath, []), ...input.overrides };
  return { sourcePath: input.profilePath, profile, sha256: profileHash(profile) };
}

export async function writeResolvedSlicerProfile(resolved: ResolvedProfile, destination: string) {
  await writeFile(destination, `${JSON.stringify(resolved.profile, null, 2)}\n`, { mode: 0o600 });
  return destination;
}
