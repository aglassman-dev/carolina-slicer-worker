import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveApprovedProfileSet, type SlicerProfileCatalog } from "@/lib/slicing/profile-catalog";

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "carolina-profile-catalog-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("approved slicer profile catalog", () => {
  it("resolves only the selected profile set and records support overrides in its hash", async () => {
    const directory = await temporaryDirectory();
    const root = path.join(directory, "profiles");
    await mkdir(root);
    await writeFile(path.join(root, "machine.json"), JSON.stringify({ name: "Machine", nozzle_diameter: ["0.4"] }));
    await writeFile(path.join(root, "process.json"), JSON.stringify({ name: "Process", enable_support: "0" }));
    await writeFile(path.join(root, "filament.json"), JSON.stringify({ name: "Filament", filament_type: ["PLA"] }));
    const catalog: SlicerProfileCatalog = {
      schemaVersion: 1,
      profileRoot: root,
      sets: [{
        id: "approved",
        label: "Approved",
        machine: "machine.json",
        processes: { draft: "process.json", standard: "process.json", fine: "process.json" },
        filaments: ["filament.json"],
      }],
    };

    const profileSet = await resolveApprovedProfileSet({
      catalog,
      profileSetId: "approved",
      resolution: "standard",
      supportPolicy: "auto",
      destinationDirectory: path.join(directory, "resolved"),
    });
    expect(JSON.parse(await readFile(profileSet.paths.process, "utf8"))).toMatchObject({ enable_support: "1" });
    expect(profileSet.hashes.process).toMatch(/^[a-f0-9]{64}$/);
    await expect(resolveApprovedProfileSet({
      catalog,
      profileSetId: "unapproved",
      resolution: "standard",
      supportPolicy: "profile",
      destinationDirectory: path.join(directory, "rejected"),
    })).rejects.toThrow("not approved");
  });

  it("rejects a relative profile path that resolves outside the approved root", async () => {
    const directory = await temporaryDirectory();
    const root = path.join(directory, "profiles");
    await mkdir(root);
    await writeFile(path.join(directory, "outside.json"), JSON.stringify({ name: "Outside" }));
    const catalog: SlicerProfileCatalog = {
      schemaVersion: 1,
      profileRoot: root,
      sets: [{
        id: "escaped",
        label: "Escaped",
        machine: "../outside.json",
        processes: { draft: "../outside.json", standard: "../outside.json", fine: "../outside.json" },
        filaments: ["../outside.json"],
      }],
    };
    await expect(resolveApprovedProfileSet({
      catalog,
      profileSetId: "escaped",
      resolution: "standard",
      supportPolicy: "profile",
      destinationDirectory: path.join(directory, "resolved"),
    })).rejects.toThrow("outside the approved profile root");
  });
});
