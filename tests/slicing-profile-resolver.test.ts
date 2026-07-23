import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSlicerProfile, writeResolvedSlicerProfile } from "@/lib/slicing/profile-resolver";

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "carolina-slicer-profile-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("slicer profile resolution", () => {
  it("flattens inherited and included profile fragments and records an immutable hash", async () => {
    const root = await temporaryDirectory();
    await mkdir(path.join(root, "profiles"));
    await writeFile(path.join(root, "profiles", "base.json"), JSON.stringify({
      name: "Base machine",
      type: "machine",
      nozzle_diameter: ["0.4"],
      printable_height: "250",
    }));
    await writeFile(path.join(root, "profiles", "shared.json"), JSON.stringify({
      name: "Shared overrides",
      type: "machine",
      bed_type: "textured",
    }));
    const childPath = path.join(root, "profiles", "child.json");
    await writeFile(childPath, JSON.stringify({
      name: "Approved machine",
      type: "machine",
      inherits: "Base machine",
      include: ["Shared overrides"],
      printable_height: "256",
    }));

    const first = await resolveSlicerProfile({ profilePath: childPath, searchRoots: [root] });
    const second = await resolveSlicerProfile({ profilePath: childPath, searchRoots: [root] });
    expect(first.profile).toMatchObject({
      name: "Approved machine",
      type: "machine",
      nozzle_diameter: ["0.4"],
      printable_height: "256",
      bed_type: "textured",
    });
    expect(first.profile).not.toHaveProperty("inherits");
    expect(first.profile).not.toHaveProperty("include");
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.sha256).toBe(second.sha256);

    const outputPath = path.join(root, "resolved.json");
    await writeResolvedSlicerProfile(first, outputPath);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(first.profile);
  });

  it("rejects missing and circular dependencies instead of silently using a partial profile", async () => {
    const root = await temporaryDirectory();
    const missingPath = path.join(root, "missing.json");
    await writeFile(missingPath, JSON.stringify({ name: "Child", inherits: "Does not exist" }));
    await expect(resolveSlicerProfile({ profilePath: missingPath, searchRoots: [root] })).rejects.toThrow("Missing inherited slicer profile");

    await writeFile(path.join(root, "a.json"), JSON.stringify({ name: "A", inherits: "B" }));
    await writeFile(path.join(root, "b.json"), JSON.stringify({ name: "B", inherits: "A" }));
    await expect(resolveSlicerProfile({ profilePath: path.join(root, "a.json"), searchRoots: [root] })).rejects.toThrow("Circular slicer profile inheritance");
  });

  it("applies explicit worker overrides before hashing the resolved profile", async () => {
    const root = await temporaryDirectory();
    const profilePath = path.join(root, "process.json");
    await writeFile(profilePath, JSON.stringify({ name: "Process", enable_support: "0" }));
    const original = await resolveSlicerProfile({ profilePath, searchRoots: [root] });
    const overridden = await resolveSlicerProfile({ profilePath, searchRoots: [root], overrides: { enable_support: "1" } });
    expect(overridden.profile.enable_support).toBe("1");
    expect(overridden.sha256).not.toBe(original.sha256);
  });
});
