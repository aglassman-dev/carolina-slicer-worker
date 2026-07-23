import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeSignedSliceJob } from "@/lib/slicing/slice-worker";
import { signSliceJob, SLICE_JOB_SCHEMA_VERSION } from "@/lib/slicing/worker-contract";

const temporaryDirectories: string[] = [];
const secret = "test-only-slicer-signing-secret-with-more-than-32-bytes";

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "carolina-slice-worker-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("isolated slice worker", () => {
  it("verifies input, returns normalized metadata, and removes decrypted job artifacts", async () => {
    const inputBuffer = Buffer.from("project bytes");
    const now = new Date("2026-07-23T16:00:00.000Z");
    const jobId = randomUUID();
    const envelope = signSliceJob({
      schemaVersion: SLICE_JOB_SCHEMA_VERSION,
      jobId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
      input: {
        filename: "project.3mf",
        format: "project-3mf",
        byteLength: inputBuffer.length,
        sha256: createHash("sha256").update(inputBuffer).digest("hex"),
      },
      production: {
        requestedUnits: 1,
        sourceUnits: 1,
        resolution: "embedded",
        supportPolicy: "profile",
        autoArrange: false,
        autoOrient: false,
        profileSetId: null,
      },
    }, secret);
    const workRoot = await temporaryDirectory();
    const runSlicer = vi.fn(async () => ({
      outputPath: "/private/deleted/result.gcode.3mf",
      artifacts: ["/private/deleted/result.gcode.3mf"],
      stdout: "",
      stderr: "",
      metadata: {
        slicerVersion: "BambuStudio 02.06.01.55",
        plateCount: 2,
        objectCount: 18,
        predictedSeconds: 70_948,
        totalGrams: 703.82,
        supportUsed: true,
        colors: ["#FFFFFF"],
        materialTypes: ["PLA"],
        nozzleDiameters: [0.4],
        warnings: [],
        plates: [],
      },
    }));

    const result = await executeSignedSliceJob({
      envelope,
      signingSecret: secret,
      inputBuffer,
      context: {
        slicerExecutable: "/trusted/BambuStudio",
        workRoot,
        profileCatalog: { schemaVersion: 1, profileRoot: "/trusted/profiles", sets: [] },
      },
      dependencies: {
        now: () => new Date("2026-07-23T16:01:00.000Z"),
        runSlicer,
      },
    });
    expect(result).toMatchObject({
      jobId,
      status: "succeeded",
      inputSha256: envelope.job.input.sha256,
      profileSetId: null,
      profileHashes: null,
      conversion: null,
      slicer: { objectCount: 18, totalGrams: 703.82 },
    });
    expect(result.cacheKey).toMatch(/^[a-f0-9]{64}$/);
    expect(runSlicer).toHaveBeenCalledWith(expect.objectContaining({
      quantity: 1,
      profiles: undefined,
      maxTrianglesPerPlate: 2_000_000,
    }));
    expect(await readdir(workRoot)).toEqual([]);
  });

  it("rejects mismatched bytes before creating a job workspace", async () => {
    const inputBuffer = Buffer.from("actual");
    const now = new Date("2026-07-23T16:00:00.000Z");
    const envelope = signSliceJob({
      schemaVersion: SLICE_JOB_SCHEMA_VERSION,
      jobId: randomUUID(),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
      input: {
        filename: "project.3mf",
        format: "project-3mf",
        byteLength: inputBuffer.length,
        sha256: createHash("sha256").update("different").digest("hex"),
      },
      production: {
        requestedUnits: 1,
        sourceUnits: 1,
        resolution: "embedded",
        supportPolicy: "profile",
        autoArrange: false,
        autoOrient: false,
        profileSetId: null,
      },
    }, secret);
    const workRoot = await temporaryDirectory();
    await expect(executeSignedSliceJob({
      envelope,
      signingSecret: secret,
      inputBuffer,
      context: {
        slicerExecutable: "/trusted/BambuStudio",
        workRoot,
        profileCatalog: { schemaVersion: 1, profileRoot: "/trusted/profiles", sets: [] },
      },
      dependencies: { now: () => new Date("2026-07-23T16:01:00.000Z") },
    })).rejects.toThrow("hash does not match");
    expect(await readdir(workRoot)).toEqual([]);
  });

  it("removes decrypted artifacts when slicing fails after workspace creation", async () => {
    const inputBuffer = Buffer.from("project bytes");
    const now = new Date("2026-07-23T16:00:00.000Z");
    const envelope = signSliceJob({
      schemaVersion: SLICE_JOB_SCHEMA_VERSION,
      jobId: randomUUID(),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
      input: {
        filename: "project.3mf",
        format: "project-3mf",
        byteLength: inputBuffer.length,
        sha256: createHash("sha256").update(inputBuffer).digest("hex"),
      },
      production: {
        requestedUnits: 1,
        sourceUnits: 1,
        resolution: "embedded",
        supportPolicy: "profile",
        autoArrange: false,
        autoOrient: false,
        profileSetId: null,
      },
    }, secret);
    const workRoot = await temporaryDirectory();
    await expect(executeSignedSliceJob({
      envelope,
      signingSecret: secret,
      inputBuffer,
      context: {
        slicerExecutable: "/trusted/BambuStudio",
        workRoot,
        profileCatalog: { schemaVersion: 1, profileRoot: "/trusted/profiles", sets: [] },
      },
      dependencies: {
        now: () => new Date("2026-07-23T16:01:00.000Z"),
        runSlicer: async () => {
          throw new Error("simulated slicer failure");
        },
      },
    })).rejects.toThrow("simulated slicer failure");
    expect(await readdir(workRoot)).toEqual([]);
  });
});
