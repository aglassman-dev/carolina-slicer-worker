import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { signSliceJob, SLICE_JOB_SCHEMA_VERSION } from "../lib/slicing/worker-contract.ts";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name: string) {
  return process.argv.includes(name);
}

function requiredValue(name: string) {
  const value = argument(name);
  if (!value) throw new Error(`Missing required argument ${name}.`);
  return value;
}

async function main() {
  const signingSecret = process.env.SLICE_JOB_SIGNING_SECRET;
  if (!signingSecret) throw new Error("SLICE_JOB_SIGNING_SECRET is required.");
  const inputPath = path.resolve(requiredValue("--input"));
  const format = requiredValue("--format");
  const input = await readFile(inputPath);
  const embeddedProject = format === "project-3mf";
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Number(argument("--expires-minutes") ?? 15) * 60_000);
  const envelope = signSliceJob({
    schemaVersion: SLICE_JOB_SCHEMA_VERSION,
    jobId: randomUUID(),
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    input: {
      filename: path.basename(inputPath),
      format,
      byteLength: input.length,
      sha256: createHash("sha256").update(input).digest("hex"),
    },
    production: {
      requestedUnits: Number(argument("--quantity") ?? 1),
      sourceUnits: 1,
      resolution: embeddedProject ? "embedded" : argument("--resolution") ?? "standard",
      supportPolicy: embeddedProject ? "profile" : argument("--supports") ?? "profile",
      autoArrange: embeddedProject ? false : !flag("--no-arrange"),
      autoOrient: embeddedProject ? false : flag("--orient"),
      profileSetId: embeddedProject ? null : requiredValue("--profile-set"),
    },
  }, signingSecret);
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  const outputPath = argument("--output");
  if (outputPath) {
    await writeFile(path.resolve(outputPath), serialized, { mode: 0o600 });
  } else {
    process.stdout.write(serialized);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
