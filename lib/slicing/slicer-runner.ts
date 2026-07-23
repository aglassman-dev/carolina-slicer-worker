import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseRawSlicerResult, parseSlicedProductionArchive, type SlicedProductionResult } from "./slice-metadata.ts";

export interface SlicerProfilePaths {
  machine: string;
  process: string;
  filaments: string[];
}

export interface SlicerRunRequest {
  executable: string;
  inputPath: string;
  outputDirectory: string;
  outputFilename: string;
  quantity: number;
  profiles?: SlicerProfilePaths;
  autoArrange?: boolean;
  autoOrient?: boolean;
  supportPolicy?: "profile" | "auto" | "off";
  timeoutMs?: number;
  maxTrianglesPerPlate?: number;
  maxSlicingSecondsPerPlate?: number;
  maxOutputBytes?: number;
}

export interface SlicerRunResult {
  outputPath: string;
  artifacts: string[];
  metadata: SlicedProductionResult;
  stdout: string;
  stderr: string;
}

function validateOutputFilename(value: string) {
  if (!/^[a-zA-Z0-9._-]+\.gcode\.3mf$/i.test(value)) throw new Error("The slicer output filename must be a simple .gcode.3mf filename.");
}

function projectInput(inputPath: string) {
  return inputPath.toLowerCase().endsWith(".3mf");
}

function usesEmbeddedProject(request: SlicerRunRequest) {
  return projectInput(request.inputPath) && !request.profiles;
}

export function buildSlicerArguments(request: SlicerRunRequest) {
  validateOutputFilename(request.outputFilename);
  if (!Number.isInteger(request.quantity) || request.quantity < 1 || request.quantity > 500) throw new Error("Slicer quantity must be an integer from 1 to 500.");
  const embeddedProject = usesEmbeddedProject(request);
  if (!embeddedProject && !request.profiles) throw new Error("Raw models require resolved machine, process, and filament profiles.");
  if (embeddedProject && request.quantity !== 1) throw new Error("Project 3MF quantity changes require explicit assembly mapping and are not enabled in the proof of concept.");

  const args = ["--debug", "2"];
  if (request.autoOrient && !embeddedProject) args.push("--orient", "1");
  if (request.autoArrange !== false && !embeddedProject) args.push("--arrange", "1");
  if (request.quantity > 1) args.push("--clone-objects", String(request.quantity));
  if (request.profiles) {
    args.push("--load-settings", `${request.profiles.machine};${request.profiles.process}`);
    args.push("--load-filaments", request.profiles.filaments.join(";"));
  }
  if (request.maxTrianglesPerPlate) {
    if (!Number.isInteger(request.maxTrianglesPerPlate) || request.maxTrianglesPerPlate < 1 || request.maxTrianglesPerPlate > 5_000_000) {
      throw new Error("The slicer triangle limit must be an integer from 1 to 5,000,000.");
    }
    args.push("--mtcpp", String(request.maxTrianglesPerPlate));
  }
  if (request.maxSlicingSecondsPerPlate) {
    if (!Number.isInteger(request.maxSlicingSecondsPerPlate) || request.maxSlicingSecondsPerPlate < 1 || request.maxSlicingSecondsPerPlate > 3_600) {
      throw new Error("The per-plate slicer time limit must be an integer from 1 to 3,600 seconds.");
    }
    args.push("--mstpp", String(request.maxSlicingSecondsPerPlate));
  }
  args.push("--slice", "0", "--outputdir", request.outputDirectory);
  if (embeddedProject) args.push("--export-3mf", request.outputFilename);
  args.push(request.inputPath);
  return args;
}

async function execute(executable: string, args: string[], timeoutMs: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`The slicer exceeded its ${Math.round(timeoutMs / 1000)} second time limit.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-200_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-200_000); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function enforceArtifactBudget(paths: string[], maxOutputBytes = 200 * 1024 * 1024) {
  const sizes = await Promise.all(paths.map(async (artifactPath) => (await stat(artifactPath)).size));
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  if (totalBytes > maxOutputBytes) throw new Error(`Slicer artifacts exceed the ${maxOutputBytes.toLocaleString()} byte safety limit.`);
}

export async function runSlicer(request: SlicerRunRequest): Promise<SlicerRunResult> {
  await access(request.executable);
  await access(request.inputPath);
  await mkdir(request.outputDirectory, { recursive: true, mode: 0o700 });
  const existingArtifacts = (await readdir(request.outputDirectory)).filter((filename) => (
    filename === request.outputFilename || filename === "result.json" || /^plate_\d+\.gcode$/i.test(filename)
  ));
  if (existingArtifacts.length) throw new Error("The slicer output directory must not contain artifacts from a previous job.");
  const args = buildSlicerArguments(request);
  const processResult = await execute(request.executable, args, request.timeoutMs ?? 10 * 60_000);
  if (processResult.code !== 0) {
    const detail = [processResult.stderr, processResult.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`Slicer failed with exit code ${processResult.code ?? "unknown"}.${detail ? ` ${detail.slice(-2000)}` : ""}`);
  }

  const embeddedProject = usesEmbeddedProject(request);
  if (embeddedProject) {
    const outputPath = path.join(request.outputDirectory, request.outputFilename);
    await access(outputPath);
    await enforceArtifactBudget([outputPath], request.maxOutputBytes);
    const metadata = parseSlicedProductionArchive(await readFile(outputPath));
    return { outputPath, artifacts: [outputPath], metadata, stdout: processResult.stdout, stderr: processResult.stderr };
  }

  const resultPath = path.join(request.outputDirectory, "result.json");
  await access(resultPath);
  const gcodePaths = (await readdir(request.outputDirectory))
    .filter((filename) => /^plate_\d+\.gcode$/i.test(filename))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((filename) => path.join(request.outputDirectory, filename));
  if (!gcodePaths.length) throw new Error("The slicer completed without producing plate G-code.");
  await enforceArtifactBudget([resultPath, ...gcodePaths], request.maxOutputBytes);
  const metadata = parseRawSlicerResult(await readFile(resultPath), await Promise.all(gcodePaths.map((gcodePath) => readFile(gcodePath, "utf8"))));
  return {
    outputPath: resultPath,
    artifacts: [resultPath, ...gcodePaths],
    metadata,
    stdout: processResult.stdout,
    stderr: processResult.stderr,
  };
}
