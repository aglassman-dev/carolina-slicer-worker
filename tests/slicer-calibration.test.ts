import { describe, expect, it } from "vitest";
import { calculateSlicerCalibration } from "@/lib/slicing/calibration";

function sample(actualSeconds: number, actualGrams: number, excluded = false) {
  return {
    profileSetId: "p1s-04-pla",
    resolution: "standard",
    material: "PLA",
    predictedSeconds: 100,
    actualSeconds,
    predictedGrams: 10,
    actualGrams,
    excluded,
  };
}

describe("slicer calibration", () => {
  it("requires three completed prints before recommending reviewable correction factors", () => {
    expect(calculateSlicerCalibration([sample(110, 11), sample(120, 12)])).toEqual([expect.objectContaining({
      sampleCount: 2,
      status: "needs-more-data",
      timeFactor: null,
      materialFactor: null,
    })]);

    expect(calculateSlicerCalibration([
      sample(110, 11),
      sample(120, 12),
      sample(100, 10),
      sample(500, 50, true),
    ])).toEqual([expect.objectContaining({
      sampleCount: 3,
      status: "ready-for-review",
      timeFactor: 1.1,
      materialFactor: 1.1,
      timeMapeAfter: expect.any(Number),
      materialMapeAfter: expect.any(Number),
    })]);
  });

  it("keeps machine, resolution, and material groups separate", () => {
    const results = calculateSlicerCalibration([
      sample(110, 11),
      { ...sample(120, 12), material: "PETG" },
    ]);
    expect(results).toHaveLength(2);
    expect(results.map((result) => result.material)).toEqual(["PETG", "PLA"]);
  });
});
