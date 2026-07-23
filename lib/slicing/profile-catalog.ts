import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveSlicerProfile, writeResolvedSlicerProfile } from "./profile-resolver.ts";
import type { SlicerProfilePaths } from "./slicer-runner.ts";
import type { SliceProfileHashes } from "./worker-contract.ts";

const relativeProfilePath = z.string().min(1).max(500).refine((value) => !path.isAbsolute(value) && !value.includes("\0"), "Profile paths must be relative to the approved profile root.");

export const slicerProfileCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  profileRoot: z.string().min(1),
  sets: z.array(z.object({
    id: z.string().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/),
    label: z.string().min(1).max(200),
    machine: relativeProfilePath,
    processes: z.object({
      draft: relativeProfilePath,
      standard: relativeProfilePath,
      fine: relativeProfilePath,
    }),
    filaments: z.array(relativeProfilePath).min(1).max(16),
  })).min(1),
});

export type SlicerProfileCatalog = z.infer<typeof slicerProfileCatalogSchema>;

export async function loadSlicerProfileCatalog(catalogPath: string) {
  return slicerProfileCatalogSchema.parse(JSON.parse(await readFile(catalogPath, "utf8")));
}

async function approvedPath(profileRoot: string, relativePath: string) {
  const root = await realpath(profileRoot);
  const candidate = await realpath(path.resolve(root, relativePath));
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error("A slicer profile resolves outside the approved profile root.");
  return candidate;
}

export async function resolveApprovedProfileSet(input: {
  catalog: SlicerProfileCatalog;
  profileSetId: string;
  resolution: "draft" | "standard" | "fine";
  supportPolicy: "profile" | "auto" | "off";
  destinationDirectory: string;
}): Promise<{ paths: SlicerProfilePaths; hashes: SliceProfileHashes; label: string }> {
  const profileSet = input.catalog.sets.find((item) => item.id === input.profileSetId);
  if (!profileSet) throw new Error(`Slicer profile set "${input.profileSetId}" is not approved by this worker.`);
  await mkdir(input.destinationDirectory, { recursive: true, mode: 0o700 });

  const machinePath = await approvedPath(input.catalog.profileRoot, profileSet.machine);
  const processPath = await approvedPath(input.catalog.profileRoot, profileSet.processes[input.resolution]);
  const filamentPaths = await Promise.all(profileSet.filaments.map((item) => approvedPath(input.catalog.profileRoot, item)));
  const searchRoots = [await realpath(input.catalog.profileRoot)];
  const [machine, processProfile, ...filaments] = await Promise.all([
    resolveSlicerProfile({ profilePath: machinePath, searchRoots }),
    resolveSlicerProfile({
      profilePath: processPath,
      searchRoots,
      overrides: input.supportPolicy === "profile" ? undefined : { enable_support: input.supportPolicy === "auto" ? "1" : "0" },
    }),
    ...filamentPaths.map((profilePath) => resolveSlicerProfile({ profilePath, searchRoots })),
  ]);

  const resolvedMachinePath = await writeResolvedSlicerProfile(machine, path.join(input.destinationDirectory, "machine.json"));
  const resolvedProcessPath = await writeResolvedSlicerProfile(processProfile, path.join(input.destinationDirectory, "process.json"));
  const resolvedFilamentPaths = await Promise.all(filaments.map((filament, index) => (
    writeResolvedSlicerProfile(filament, path.join(input.destinationDirectory, `filament-${index + 1}.json`))
  )));

  return {
    label: profileSet.label,
    paths: {
      machine: resolvedMachinePath,
      process: resolvedProcessPath,
      filaments: resolvedFilamentPaths,
    },
    hashes: {
      machine: machine.sha256,
      process: processProfile.sha256,
      filaments: filaments.map((filament) => filament.sha256),
    },
  };
}
