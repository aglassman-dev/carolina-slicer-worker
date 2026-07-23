import { readFile } from "node:fs/promises";
import path from "node:path";
import { calculateSlicerCalibration } from "../lib/slicing/calibration.ts";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const inputPath = argument("--input");
  if (!inputPath) throw new Error("Missing required argument --input.");
  const parsed = JSON.parse(await readFile(path.resolve(inputPath), "utf8")) as unknown;
  const samples = Array.isArray(parsed) ? parsed : (parsed as { samples?: unknown }).samples;
  process.stdout.write(`${JSON.stringify({
    generatedAt: new Date().toISOString(),
    minimumSamplesPerGroup: 3,
    applicationPolicy: "Review and approve factors before applying them to quote calculations.",
    groups: calculateSlicerCalibration(samples),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
