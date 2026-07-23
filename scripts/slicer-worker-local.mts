import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSlicerProfileCatalog } from "../lib/slicing/profile-catalog.ts";
import { executeSignedSliceJob } from "../lib/slicing/slice-worker.ts";
import { signSliceWorkerResult, type SignedSliceJob } from "../lib/slicing/worker-contract.ts";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string) {
  const value = argument(name);
  if (!value) throw new Error(`Missing required argument ${name}.`);
  return path.resolve(value);
}

async function main() {
  const signingSecret = process.env.SLICE_JOB_SIGNING_SECRET;
  if (!signingSecret) throw new Error("SLICE_JOB_SIGNING_SECRET is required.");
  const envelope = JSON.parse(await readFile(required("--job"), "utf8")) as SignedSliceJob;
  const inputBuffer = await readFile(required("--input"));
  const result = await executeSignedSliceJob({
    envelope,
    signingSecret,
    inputBuffer,
    context: {
      slicerExecutable: required("--engine"),
      workRoot: path.resolve(argument("--work-root") ?? path.join(os.tmpdir(), "carolina-slicer-worker")),
      profileCatalog: await loadSlicerProfileCatalog(required("--catalog")),
    },
  });
  process.stdout.write(`${JSON.stringify(signSliceWorkerResult(result, signingSecret), null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
