import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createSliceCacheKey,
  signSliceJob,
  signSliceWorkerResult,
  SLICE_JOB_SCHEMA_VERSION,
  SLICE_RESULT_SCHEMA_VERSION,
  verifySignedSliceJob,
  verifySignedSliceWorkerResult,
  type SliceWorkerResult,
} from "@/lib/slicing/worker-contract";

const secret = "test-only-slicer-signing-secret-with-more-than-32-bytes";
const inputSha256 = createHash("sha256").update("model").digest("hex");

function rawJob() {
  const now = new Date("2026-07-23T16:00:00.000Z");
  return {
    schemaVersion: SLICE_JOB_SCHEMA_VERSION,
    jobId: randomUUID(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
    input: { filename: "model.step", format: "step", byteLength: 5, sha256: inputSha256 },
    production: {
      requestedUnits: 4,
      sourceUnits: 1,
      resolution: "standard",
      supportPolicy: "auto",
      autoArrange: true,
      autoOrient: true,
      profileSetId: "medium-04-pla",
    },
  };
}

describe("signed slicer worker contracts", () => {
  it("authenticates a short-lived raw-model job and rejects tampering or expiry", () => {
    const job = rawJob();
    const envelope = signSliceJob(job, secret);
    expect(verifySignedSliceJob(envelope, secret, new Date("2026-07-23T16:01:00.000Z"))).toEqual(job);
    expect(() => verifySignedSliceJob({
      ...envelope,
      job: { ...envelope.job, production: { ...envelope.job.production, requestedUnits: 40 } },
    }, secret, new Date("2026-07-23T16:01:00.000Z"))).toThrow("signature is invalid");
    expect(() => verifySignedSliceJob(envelope, secret, new Date("2026-07-23T16:16:00.000Z"))).toThrow("expired");
  });

  it("rejects ambiguous project quantities and raw jobs without approved profiles", () => {
    expect(() => signSliceJob({
      ...rawJob(),
      input: { ...rawJob().input, filename: "project.3mf", format: "project-3mf" },
      production: { ...rawJob().production, requestedUnits: 2, resolution: "embedded", supportPolicy: "profile", profileSetId: null },
    }, secret)).toThrow("assembly mapping");
    expect(() => signSliceJob({
      ...rawJob(),
      production: { ...rawJob().production, profileSetId: null },
    }, secret)).toThrow("approved profile set");
    expect(() => signSliceJob({
      ...rawJob(),
      expiresAt: "2026-07-23T17:00:00.000Z",
    }, secret)).toThrow("within 30 minutes");
  });

  it("signs worker results and creates stable cache identities", () => {
    const envelope = signSliceJob(rawJob(), secret);
    const cacheKey = createSliceCacheKey({
      job: envelope.job,
      slicerVersion: "BambuStudio 02.06.01.55",
      profileHashes: { machine: "a".repeat(64), process: "b".repeat(64), filaments: ["c".repeat(64)] },
      converterVersion: "occt-import-js@0.0.23",
    });
    const result = {
      schemaVersion: SLICE_RESULT_SCHEMA_VERSION,
      jobId: envelope.job.jobId,
      status: "succeeded",
      completedAt: "2026-07-23T16:02:00.000Z",
      inputSha256,
      cacheKey,
      slicer: {
        slicerVersion: "BambuStudio 02.06.01.55",
        plateCount: 1,
        objectCount: 4,
        predictedSeconds: 1200,
        totalGrams: 10,
        supportUsed: false,
        colors: ["#FFFFFF"],
        materialTypes: ["PLA"],
        nozzleDiameters: [0.4],
        warnings: [],
        plates: [],
      },
      conversion: null,
      profileSetId: "medium-04-pla",
      profileHashes: null,
    } satisfies SliceWorkerResult;
    expect(cacheKey).toMatch(/^[a-f0-9]{64}$/);
    const signed = signSliceWorkerResult(result, secret);
    expect(verifySignedSliceWorkerResult(signed, secret)).toEqual(result);
    expect(() => verifySignedSliceWorkerResult({
      ...signed,
      result: { ...signed.result, cacheKey: "0".repeat(64) },
    }, secret)).toThrow("signature is invalid");
    const malformed = signSliceWorkerResult({
      ...result,
      slicer: { ...result.slicer, predictedSeconds: -1 },
    } as SliceWorkerResult, secret);
    expect(() => verifySignedSliceWorkerResult(malformed, secret)).toThrow();
  });
});
