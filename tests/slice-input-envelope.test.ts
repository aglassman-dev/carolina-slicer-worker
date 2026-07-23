import { describe, expect, it } from "vitest";
import { decryptSliceInput, encryptSliceInput, normalizeSliceInput } from "@/lib/slicing/input-envelope";

function binaryStl() {
  const buffer = Buffer.alloc(84 + 50);
  buffer.writeUInt32LE(1, 80);
  const coordinates = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  coordinates.forEach((value, index) => buffer.writeFloatLE(value, 84 + 12 + index * 4));
  return buffer;
}

describe("encrypted slicer input", () => {
  it("normalizes non-millimeter STL vertices before hashing and slicing", () => {
    const normalized = normalizeSliceInput({ buffer: binaryStl(), format: "stl", sourceUnits: "in" });
    expect(normalized.readFloatLE(84 + 12)).toBeCloseTo(25.4, 4);
    expect(normalized.readFloatLE(84 + 12 + 8 * 4)).toBeCloseTo(228.6, 4);
  });

  it("round-trips authenticated input bytes and rejects tampering", () => {
    const key = Buffer.alloc(32, 7);
    const source = Buffer.from("confidential model bytes");
    const encrypted = encryptSliceInput(source, key);
    expect(encrypted).not.toContain(source);
    expect(decryptSliceInput(encrypted, key)).toEqual(source);
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 1;
    expect(() => decryptSliceInput(tampered, key)).toThrow();
  });
});
