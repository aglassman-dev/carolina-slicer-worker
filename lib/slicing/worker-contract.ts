import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { CadConversionResult } from "./cad-converter.ts";
import type { SlicedProductionResult } from "./slice-metadata.ts";

export const SLICE_JOB_SCHEMA_VERSION = 1;
export const SLICE_RESULT_SCHEMA_VERSION = 1;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const safeIdentifierSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/);

export const sliceJobSchema = z.object({
  schemaVersion: z.literal(SLICE_JOB_SCHEMA_VERSION),
  jobId: z.string().uuid(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  input: z.object({
    filename: z.string().min(1).max(255).refine((value) => !value.includes("/") && !value.includes("\\"), "The input filename must not contain a path."),
    format: z.enum(["stl", "step", "stp", "model-3mf", "project-3mf"]),
    byteLength: z.number().int().positive().max(50 * 1024 * 1024),
    sha256: sha256Schema,
  }),
  production: z.object({
    requestedUnits: z.number().int().min(1).max(500),
    sourceUnits: z.literal(1),
    resolution: z.enum(["draft", "standard", "fine", "embedded"]),
    supportPolicy: z.enum(["profile", "auto", "off"]),
    autoArrange: z.boolean(),
    autoOrient: z.boolean(),
    profileSetId: safeIdentifierSchema.nullable(),
  }),
}).superRefine((job, context) => {
  const createdAt = new Date(job.createdAt).getTime();
  const expiresAt = new Date(job.expiresAt).getTime();
  if (expiresAt <= createdAt || expiresAt - createdAt > 30 * 60_000) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Slicer jobs must expire after creation and within 30 minutes." });
  }
  const embeddedProject = job.input.format === "project-3mf";
  if (embeddedProject && job.production.requestedUnits !== 1) {
    context.addIssue({ code: "custom", path: ["production", "requestedUnits"], message: "Project 3MF quantity requires explicit assembly mapping." });
  }
  if (embeddedProject && (job.production.profileSetId !== null || job.production.resolution !== "embedded" || job.production.supportPolicy !== "profile")) {
    context.addIssue({ code: "custom", path: ["production"], message: "Project 3MF jobs must preserve their embedded profile, resolution, and support settings." });
  }
  if (!embeddedProject && (!job.production.profileSetId || job.production.resolution === "embedded")) {
    context.addIssue({ code: "custom", path: ["production"], message: "Raw models require an approved profile set and explicit resolution." });
  }
});

export type SliceJob = z.infer<typeof sliceJobSchema>;

export interface SignedSliceJob {
  job: SliceJob;
  signature: string;
}

export interface SliceProfileHashes {
  machine: string;
  process: string;
  filaments: string[];
}

export interface SliceWorkerResult {
  schemaVersion: typeof SLICE_RESULT_SCHEMA_VERSION;
  jobId: string;
  status: "succeeded";
  completedAt: string;
  inputSha256: string;
  cacheKey: string;
  slicer: SlicedProductionResult;
  conversion: CadConversionResult | null;
  profileSetId: string | null;
  profileHashes: SliceProfileHashes | null;
}

export interface SignedSliceWorkerResult {
  result: SliceWorkerResult;
  signature: string;
}

const filamentUsageSchema = z.object({
  id: z.string().max(120),
  type: z.string().max(120).nullable(),
  color: z.string().max(120).nullable(),
  grams: z.number().nonnegative().max(1_000_000),
  usedForModel: z.boolean(),
  usedForSupport: z.boolean(),
});

const slicedPlateSchema = z.object({
  index: z.number().int().min(1).max(10_000),
  predictedSeconds: z.number().nonnegative().max(10 * 365 * 24 * 60 * 60),
  totalGrams: z.number().nonnegative().max(1_000_000),
  objectCount: z.number().int().nonnegative().max(1_000_000),
  supportUsed: z.boolean(),
  nozzleDiameters: z.array(z.number().min(0.1).max(2)).max(16),
  filaments: z.array(filamentUsageSchema).max(64),
  warnings: z.array(z.string().max(1000)).max(100),
});

const slicedProductionResultSchema = z.object({
  slicerVersion: z.string().max(200).nullable(),
  plateCount: z.number().int().min(1).max(10_000),
  objectCount: z.number().int().min(1).max(1_000_000),
  predictedSeconds: z.number().positive().max(10 * 365 * 24 * 60 * 60),
  totalGrams: z.number().positive().max(1_000_000),
  supportUsed: z.boolean(),
  colors: z.array(z.string().max(120)).max(64),
  materialTypes: z.array(z.string().max(120)).max(64),
  nozzleDiameters: z.array(z.number().min(0.1).max(2)).max(16),
  warnings: z.array(z.string().max(1000)).max(100),
  plates: z.array(slicedPlateSchema).max(10_000),
});

export const sliceWorkerResultSchema = z.object({
  schemaVersion: z.literal(SLICE_RESULT_SCHEMA_VERSION),
  jobId: z.string().uuid(),
  status: z.literal("succeeded"),
  completedAt: z.string().datetime(),
  inputSha256: sha256Schema,
  cacheKey: sha256Schema,
  slicer: slicedProductionResultSchema,
  conversion: z.object({
    converterVersion: z.string().min(1).max(200),
    quality: z.enum(["draft", "standard", "fine"]),
    meshCount: z.number().int().positive().max(500),
    triangleCount: z.number().int().positive().max(5_000_000),
    dimensionsMm: z.object({ x: z.number().nonnegative(), y: z.number().nonnegative(), z: z.number().nonnegative() }),
    outputBytes: z.number().int().positive().max(200 * 1024 * 1024),
    outputSha256: sha256Schema,
  }).nullable(),
  profileSetId: safeIdentifierSchema.nullable(),
  profileHashes: z.object({
    machine: sha256Schema,
    process: sha256Schema,
    filaments: z.array(sha256Schema).min(1).max(64),
  }).nullable(),
});

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
}

function signingKey(secret: string) {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("The slicer job signing secret must be at least 32 bytes.");
  return secret;
}

export function signSliceJob(jobInput: unknown, secret: string): SignedSliceJob {
  const job = sliceJobSchema.parse(jobInput);
  const signature = createHmac("sha256", signingKey(secret)).update(canonicalize(job)).digest("hex");
  return { job, signature };
}

export function verifySignedSliceJob(envelopeInput: unknown, secret: string, now = new Date()): SliceJob {
  const envelope = z.object({ job: sliceJobSchema, signature: z.string().regex(/^[a-f0-9]{64}$/) }).parse(envelopeInput);
  const expected = createHmac("sha256", signingKey(secret)).update(canonicalize(envelope.job)).digest();
  const received = Buffer.from(envelope.signature, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error("The slicer job signature is invalid.");
  if (new Date(envelope.job.createdAt).getTime() > now.getTime() + 5 * 60_000) throw new Error("The slicer job creation time is in the future.");
  if (new Date(envelope.job.expiresAt).getTime() <= now.getTime()) throw new Error("The slicer job has expired.");
  return envelope.job;
}

export function createSliceCacheKey(input: {
  job: SliceJob;
  slicerVersion: string | null;
  profileHashes: SliceProfileHashes | null;
  converterVersion: string | null;
}) {
  return createHash("sha256").update(canonicalize({
    schemaVersion: SLICE_RESULT_SCHEMA_VERSION,
    inputSha256: input.job.input.sha256,
    inputFormat: input.job.input.format,
    production: input.job.production,
    slicerVersion: input.slicerVersion,
    profileHashes: input.profileHashes,
    converterVersion: input.converterVersion,
  })).digest("hex");
}

export function signSliceWorkerResult(result: SliceWorkerResult, secret: string): SignedSliceWorkerResult {
  const signature = createHmac("sha256", signingKey(secret)).update(canonicalize(result)).digest("hex");
  return { result, signature };
}

export function verifySignedSliceWorkerResult(envelopeInput: unknown, secret: string) {
  const envelope = z.object({
    result: sliceWorkerResultSchema,
    signature: z.string().regex(/^[a-f0-9]{64}$/),
  }).parse(envelopeInput);
  const expected = createHmac("sha256", signingKey(secret)).update(canonicalize(envelope.result)).digest();
  const received = Buffer.from(envelope.signature, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error("The slicer result signature is invalid.");
  return envelope.result;
}
