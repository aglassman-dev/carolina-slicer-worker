import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CAD_CONVERTER_VERSION, convertStepToBinaryStl } from "@/lib/slicing/cad-converter";

const temporaryDirectories: string[] = [];
const require = createRequire(import.meta.url);

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "carolina-cad-converter-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("STEP conversion", () => {
  it("converts a real STEP cube into a bounded binary STL", async () => {
    const packageMain = require.resolve("occt-import-js");
    const stepPath = path.resolve(path.dirname(packageMain), "../test/testfiles/cube-10x10mm/Cube 10x10.stp");
    const directory = await temporaryDirectory();
    const outputPath = path.join(directory, "cube.stl");
    const result = await convertStepToBinaryStl({
      buffer: await readFile(stepPath),
      outputPath,
      quality: "standard",
    });
    const output = await readFile(outputPath);

    expect(result.converterVersion).toBe(CAD_CONVERTER_VERSION);
    expect(result.meshCount).toBe(1);
    expect(result.triangleCount).toBeGreaterThan(0);
    expect(result.dimensionsMm).toEqual({ x: 10, y: 10, z: 10 });
    expect(result.outputBytes).toBe(84 + result.triangleCount * 50);
    expect(result.outputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(output.readUInt32LE(80)).toBe(result.triangleCount);
  });

  it("fails closed when converted geometry exceeds its triangle budget", async () => {
    const directory = await temporaryDirectory();
    const outputPath = path.join(directory, "too-large.stl");
    await expect(convertStepToBinaryStl({
      buffer: Buffer.from("valid input placeholder"),
      outputPath,
      quality: "draft",
      limits: { maxTriangles: 1 },
      loadImporter: async () => ({
        ReadStepFile: () => ({
          success: true,
          meshes: [{
            attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0] } },
            index: { array: [0, 1, 2, 1, 3, 2] },
          }],
        }),
      }),
    })).rejects.toThrow("triangle safety limit");
  });
});
