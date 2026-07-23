import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { convertStepToBinaryStl, type CadConversionLimits, type CadConversionResult } from "./cad-converter.ts";
import { resolveApprovedProfileSet, type SlicerProfileCatalog } from "./profile-catalog.ts";
import { runSlicer } from "./slicer-runner.ts";
import {
  createSliceCacheKey,
  SLICE_RESULT_SCHEMA_VERSION,
  verifySignedSliceJob,
  type SignedSliceJob,
  type SliceProfileHashes,
  type SliceWorkerResult,
} from "./worker-contract.ts";

export interface SliceWorkerLimits {
  maxInputBytes: number;
  maxMeshes: number;
  maxTriangles: number;
  maxTrianglesPerPlate: number;
  maxSlicingSecondsPerPlate: number;
  maxOutputBytes: number;
  timeoutMs: number;
}

export interface SliceWorkerContext {
  slicerExecutable: string;
  workRoot: string;
  profileCatalog: SlicerProfileCatalog;
  limits?: Partial<SliceWorkerLimits>;
}

interface SliceWorkerDependencies {
  convertStep: typeof convertStepToBinaryStl;
  runSlicer: typeof runSlicer;
  now: () => Date;
}

const DEFAULT_LIMITS: SliceWorkerLimits = {
  maxInputBytes: 50 * 1024 * 1024,
  maxMeshes: 500,
  maxTriangles: 2_000_000,
  maxTrianglesPerPlate: 2_000_000,
  maxSlicingSecondsPerPlate: 600,
  maxOutputBytes: 200 * 1024 * 1024,
  timeoutMs: 12 * 60_000,
};

const DEFAULT_DEPENDENCIES: SliceWorkerDependencies = {
  convertStep: convertStepToBinaryStl,
  runSlicer,
  now: () => new Date(),
};

function inputExtension(format: "stl" | "step" | "stp" | "model-3mf" | "project-3mf") {
  if (format === "model-3mf" || format === "project-3mf") return ".3mf";
  return `.${format}`;
}

function validateInput(buffer: Buffer, expectedBytes: number, expectedSha256: string, maxInputBytes: number) {
  if (buffer.length !== expectedBytes) throw new Error("The slicer input length does not match the signed job.");
  if (buffer.length > maxInputBytes) throw new Error(`The slicer input exceeds the ${maxInputBytes.toLocaleString()} byte worker limit.`);
  const actualSha256 = createHash("sha256").update(buffer).digest("hex");
  if (actualSha256 !== expectedSha256) throw new Error("The slicer input hash does not match the signed job.");
}

export async function executeSignedSliceJob(input: {
  envelope: SignedSliceJob;
  signingSecret: string;
  inputBuffer: Buffer;
  context: SliceWorkerContext;
  dependencies?: Partial<SliceWorkerDependencies>;
}): Promise<SliceWorkerResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...input.dependencies };
  const now = dependencies.now();
  const job = verifySignedSliceJob(input.envelope, input.signingSecret, now);
  const limits = { ...DEFAULT_LIMITS, ...input.context.limits };
  validateInput(input.inputBuffer, job.input.byteLength, job.input.sha256, limits.maxInputBytes);

  await mkdir(input.context.workRoot, { recursive: true, mode: 0o700 });
  const jobDirectory = await mkdtemp(path.join(input.context.workRoot, "slice-job-"));
  await chmod(jobDirectory, 0o700);

  try {
    const sourcePath = path.join(jobDirectory, `source${inputExtension(job.input.format)}`);
    await writeFile(sourcePath, input.inputBuffer, { mode: 0o600 });
    const outputDirectory = path.join(jobDirectory, "output");
    const profileDirectory = path.join(jobDirectory, "profiles");
    let modelPath = sourcePath;
    let conversion: CadConversionResult | null = null;
    let profileHashes: SliceProfileHashes | null = null;
    let profiles: Awaited<ReturnType<typeof resolveApprovedProfileSet>>["paths"] | undefined;

    if (job.input.format === "step" || job.input.format === "stp") {
      modelPath = path.join(jobDirectory, "converted.stl");
      conversion = await dependencies.convertStep({
        buffer: input.inputBuffer,
        outputPath: modelPath,
        quality: job.production.resolution === "embedded" ? "standard" : job.production.resolution,
        limits: {
          maxInputBytes: limits.maxInputBytes,
          maxMeshes: limits.maxMeshes,
          maxTriangles: limits.maxTriangles,
        } satisfies CadConversionLimits,
      });
    }

    const embeddedProject = job.input.format === "project-3mf";
    if (!embeddedProject) {
      if (!job.production.profileSetId || job.production.resolution === "embedded") throw new Error("The signed raw-model job is missing an approved profile selection.");
      const resolved = await resolveApprovedProfileSet({
        catalog: input.context.profileCatalog,
        profileSetId: job.production.profileSetId,
        resolution: job.production.resolution,
        supportPolicy: job.production.supportPolicy,
        destinationDirectory: profileDirectory,
      });
      profiles = resolved.paths;
      profileHashes = resolved.hashes;
    }

    const sliced = await dependencies.runSlicer({
      executable: input.context.slicerExecutable,
      inputPath: modelPath,
      outputDirectory,
      outputFilename: "production-estimate.gcode.3mf",
      quantity: job.production.requestedUnits,
      profiles,
      autoArrange: job.production.autoArrange,
      autoOrient: job.production.autoOrient,
      supportPolicy: job.production.supportPolicy,
      timeoutMs: limits.timeoutMs,
      maxTrianglesPerPlate: limits.maxTrianglesPerPlate,
      maxSlicingSecondsPerPlate: limits.maxSlicingSecondsPerPlate,
      maxOutputBytes: limits.maxOutputBytes,
    });
    if (sliced.metadata.objectCount < 1 || sliced.metadata.predictedSeconds <= 0 || sliced.metadata.totalGrams <= 0) {
      throw new Error("The slicer did not return complete production time, material, and object totals.");
    }

    const cacheKey = createSliceCacheKey({
      job,
      slicerVersion: sliced.metadata.slicerVersion,
      profileHashes,
      converterVersion: conversion?.converterVersion ?? null,
    });
    return {
      schemaVersion: SLICE_RESULT_SCHEMA_VERSION,
      jobId: job.jobId,
      status: "succeeded",
      completedAt: dependencies.now().toISOString(),
      inputSha256: job.input.sha256,
      cacheKey,
      slicer: sliced.metadata,
      conversion,
      profileSetId: job.production.profileSetId,
      profileHashes,
    };
  } finally {
    await rm(jobDirectory, { recursive: true, force: true });
  }
}
