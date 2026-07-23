import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import occtImportJs, { type OcctImporter, type OcctMesh } from "occt-import-js";

export const CAD_CONVERTER_VERSION = "occt-import-js@0.0.23";

export type CadMeshQuality = "draft" | "standard" | "fine";

export interface CadConversionLimits {
  maxInputBytes: number;
  maxMeshes: number;
  maxTriangles: number;
}

export interface CadConversionResult {
  converterVersion: string;
  quality: CadMeshQuality;
  meshCount: number;
  triangleCount: number;
  dimensionsMm: { x: number; y: number; z: number };
  outputBytes: number;
  outputSha256: string;
}

const DEFAULT_LIMITS: CadConversionLimits = {
  maxInputBytes: 50 * 1024 * 1024,
  maxMeshes: 500,
  maxTriangles: 2_000_000,
};

const QUALITY_PARAMETERS = {
  draft: { linearDeflection: 0.002, angularDeflection: 0.5 },
  standard: { linearDeflection: 0.001, angularDeflection: 0.35 },
  fine: { linearDeflection: 0.0005, angularDeflection: 0.2 },
} as const;

function finiteNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value);
}

function meshArrays(mesh: OcctMesh) {
  const positions = mesh.attributes?.position?.array ?? [];
  const indices = mesh.index?.array ?? [];
  if (!positions.length || positions.length % 3 !== 0) throw new Error("The STEP converter returned invalid vertex data.");
  if (!indices.length || indices.length % 3 !== 0) throw new Error("The STEP converter returned invalid triangle data.");
  if (!positions.every(finiteNumber) || !indices.every((value) => Number.isInteger(value) && value >= 0)) {
    throw new Error("The STEP converter returned non-finite or invalid geometry.");
  }
  return { positions, indices };
}

function vertex(positions: number[], index: number) {
  const offset = index * 3;
  if (offset + 2 >= positions.length) throw new Error("The STEP converter returned an out-of-range triangle index.");
  return [positions[offset], positions[offset + 1], positions[offset + 2]] as const;
}

function normal(a: readonly number[], b: readonly number[], c: readonly number[]) {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const x = uy * vz - uz * vy;
  const y = uz * vx - ux * vz;
  const z = ux * vy - uy * vx;
  const magnitude = Math.hypot(x, y, z);
  return magnitude > 0 ? [x / magnitude, y / magnitude, z / magnitude] as const : [0, 0, 0] as const;
}

function binaryStl(meshes: OcctMesh[], maxTriangles: number) {
  const prepared = meshes.map(meshArrays);
  const triangleCount = prepared.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0);
  if (triangleCount < 1) throw new Error("The STEP file contains no printable triangles.");
  if (triangleCount > maxTriangles) throw new Error(`The converted STEP file exceeds the ${maxTriangles.toLocaleString()} triangle safety limit.`);

  const output = Buffer.allocUnsafe(84 + triangleCount * 50);
  output.fill(0, 0, 80);
  output.write("Carolina Quote Engine STEP conversion", 0, "ascii");
  output.writeUInt32LE(triangleCount, 80);
  let outputOffset = 84;
  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];

  for (const mesh of prepared) {
    for (let indexOffset = 0; indexOffset < mesh.indices.length; indexOffset += 3) {
      const vertices = [
        vertex(mesh.positions, mesh.indices[indexOffset]),
        vertex(mesh.positions, mesh.indices[indexOffset + 1]),
        vertex(mesh.positions, mesh.indices[indexOffset + 2]),
      ];
      const faceNormal = normal(vertices[0], vertices[1], vertices[2]);
      for (const value of faceNormal) {
        output.writeFloatLE(value, outputOffset);
        outputOffset += 4;
      }
      for (const item of vertices) {
        for (let axis = 0; axis < 3; axis += 1) {
          const value = item[axis];
          minimum[axis] = Math.min(minimum[axis], value);
          maximum[axis] = Math.max(maximum[axis], value);
          output.writeFloatLE(value, outputOffset);
          outputOffset += 4;
        }
      }
      output.writeUInt16LE(0, outputOffset);
      outputOffset += 2;
    }
  }

  return {
    output,
    triangleCount,
    dimensionsMm: {
      x: maximum[0] - minimum[0],
      y: maximum[1] - minimum[1],
      z: maximum[2] - minimum[2],
    },
  };
}

export async function convertStepToBinaryStl(input: {
  buffer: Buffer;
  outputPath: string;
  quality: CadMeshQuality;
  limits?: Partial<CadConversionLimits>;
  loadImporter?: () => Promise<OcctImporter>;
}): Promise<CadConversionResult> {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  if (!input.buffer.length) throw new Error("The STEP file is empty.");
  if (input.buffer.length > limits.maxInputBytes) throw new Error(`The STEP file exceeds the ${limits.maxInputBytes.toLocaleString()} byte conversion limit.`);

  const importer = await (input.loadImporter ?? occtImportJs)();
  const quality = QUALITY_PARAMETERS[input.quality];
  const imported = importer.ReadStepFile(new Uint8Array(input.buffer), {
    linearUnit: "millimeter",
    linearDeflectionType: "bounding_box_ratio",
    linearDeflection: quality.linearDeflection,
    angularDeflection: quality.angularDeflection,
  });
  if (!imported.success) throw new Error("The STEP converter could not read this model.");
  const meshes = imported.meshes ?? [];
  if (!meshes.length) throw new Error("The STEP file contains no convertible meshes.");
  if (meshes.length > limits.maxMeshes) throw new Error(`The STEP file exceeds the ${limits.maxMeshes.toLocaleString()} mesh safety limit.`);

  const converted = binaryStl(meshes, limits.maxTriangles);
  await writeFile(input.outputPath, converted.output, { mode: 0o600 });
  return {
    converterVersion: CAD_CONVERTER_VERSION,
    quality: input.quality,
    meshCount: meshes.length,
    triangleCount: converted.triangleCount,
    dimensionsMm: converted.dimensionsMm,
    outputBytes: converted.output.length,
    outputSha256: createHash("sha256").update(converted.output).digest("hex"),
  };
}
