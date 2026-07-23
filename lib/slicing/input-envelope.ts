import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { unitScaleToMm, type LengthUnit } from "../file-units.ts";

const SLICE_INPUT_MAGIC = Buffer.from("CQESLICE1", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;

function scaleBinaryStl(buffer: Buffer, scale: number) {
  if (buffer.length < 84) return null;
  const triangleCount = buffer.readUInt32LE(80);
  if (84 + triangleCount * 50 !== buffer.length) return null;
  const scaled = Buffer.from(buffer);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const recordStart = 84 + triangle * 50;
    for (let coordinate = 0; coordinate < 9; coordinate += 1) {
      const offset = recordStart + 12 + coordinate * 4;
      scaled.writeFloatLE(scaled.readFloatLE(offset) * scale, offset);
    }
  }
  return scaled;
}

function scaleAsciiStl(buffer: Buffer, scale: number) {
  const text = buffer.toString("utf8");
  if (!/^\s*solid\b/i.test(text) || !/\bvertex\s+/i.test(text)) return null;
  return Buffer.from(text.replace(
    /(\bvertex\s+)(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s+(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s+(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/gi,
    (_match, prefix: string, x: string, y: string, z: string) => `${prefix}${Number(x) * scale} ${Number(y) * scale} ${Number(z) * scale}`,
  ), "utf8");
}

export function normalizeSliceInput(input: {
  buffer: Buffer;
  format: "stl" | "step" | "stp" | "model-3mf" | "project-3mf";
  sourceUnits?: LengthUnit | null;
}) {
  if (input.format !== "stl") return Buffer.from(input.buffer);
  const scale = unitScaleToMm(input.sourceUnits ?? "mm");
  if (scale === 1) return Buffer.from(input.buffer);
  const scaled = scaleBinaryStl(input.buffer, scale) ?? scaleAsciiStl(input.buffer, scale);
  if (!scaled) throw new Error("The STL could not be normalized to millimeters for automatic slicing.");
  return scaled;
}

export function encryptSliceInput(buffer: Buffer, key: Buffer) {
  if (key.length !== 32) throw new Error("The slicer input key must contain 32 bytes.");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([SLICE_INPUT_MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptSliceInput(envelope: Buffer, key: Buffer) {
  const contentStart = SLICE_INPUT_MAGIC.length + IV_BYTES + TAG_BYTES;
  if (key.length !== 32 || envelope.length < contentStart || !envelope.subarray(0, SLICE_INPUT_MAGIC.length).equals(SLICE_INPUT_MAGIC)) {
    throw new Error("The encrypted slicer input is invalid.");
  }
  const ivStart = SLICE_INPUT_MAGIC.length;
  const tagStart = ivStart + IV_BYTES;
  const decipher = createDecipheriv("aes-256-gcm", key, envelope.subarray(ivStart, tagStart));
  decipher.setAuthTag(envelope.subarray(tagStart, contentStart));
  return Buffer.concat([decipher.update(envelope.subarray(contentStart)), decipher.final()]);
}
