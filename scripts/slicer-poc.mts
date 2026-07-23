import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveSlicerProfile, writeResolvedSlicerProfile } from "../lib/slicing/profile-resolver.ts";
import { runSlicer, type SlicerProfilePaths } from "../lib/slicing/slicer-runner.ts";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name: string) {
  return process.argv.includes(name);
}

function required(name: string) {
  const value = argument(name);
  if (!value) throw new Error(`Missing required argument ${name}.`);
  return path.resolve(value);
}

async function main() {
  const executable = required("--engine");
  const inputPath = required("--input");
  const outputRoot = path.resolve(argument("--output-dir") ?? "tmp/slicer-poc");
  const outputDirectory = path.join(outputRoot, `job-${randomUUID()}`);
  const quantity = Number(argument("--quantity") ?? 1);
  const embeddedProject = flag("--embedded-project");
  const support = argument("--supports") ?? "profile";
  if (!["profile", "auto", "off"].includes(support)) throw new Error("--supports must be profile, auto, or off.");
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });

  let profiles: SlicerProfilePaths | undefined;
  const profileHashes: Record<string, string> = {};
  if (!embeddedProject) {
    const profileRoot = required("--profile-root");
    const profileDirectory = path.join(outputDirectory, "resolved-profiles");
    await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
    const machine = await resolveSlicerProfile({ profilePath: required("--machine-profile"), searchRoots: [profileRoot] });
    const processProfile = await resolveSlicerProfile({
      profilePath: required("--process-profile"),
      searchRoots: [profileRoot],
      overrides: support === "profile" ? undefined : { enable_support: support === "auto" ? "1" : "0" },
    });
    const filament = await resolveSlicerProfile({ profilePath: required("--filament-profile"), searchRoots: [profileRoot] });
    profiles = {
      machine: await writeResolvedSlicerProfile(machine, path.join(profileDirectory, "machine.json")),
      process: await writeResolvedSlicerProfile(processProfile, path.join(profileDirectory, "process.json")),
      filaments: [await writeResolvedSlicerProfile(filament, path.join(profileDirectory, "filament-1.json"))],
    };
    profileHashes.machine = machine.sha256;
    profileHashes.process = processProfile.sha256;
    profileHashes.filament = filament.sha256;
  }

  const result = await runSlicer({
    executable,
    inputPath,
    outputDirectory,
    outputFilename: "production-estimate.gcode.3mf",
    quantity,
    profiles,
    autoArrange: true,
    autoOrient: flag("--orient"),
    supportPolicy: support as "profile" | "auto" | "off",
  });

  process.stdout.write(`${JSON.stringify({
    status: "sliced",
    input: path.basename(inputPath),
    output: result.outputPath,
    artifacts: result.artifacts,
    quantity,
    profileHashes,
    ...result.metadata,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
