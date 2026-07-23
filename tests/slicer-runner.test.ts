import { describe, expect, it } from "vitest";
import { buildSlicerArguments, type SlicerRunRequest } from "@/lib/slicing/slicer-runner";

const rawRequest: SlicerRunRequest = {
  executable: "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio",
  inputPath: "/private/tmp/part.stl",
  outputDirectory: "/private/tmp/slicer-job",
  outputFilename: "estimate.gcode.3mf",
  quantity: 3,
  profiles: {
    machine: "/private/tmp/profiles/machine.json",
    process: "/private/tmp/profiles/process.json",
    filaments: ["/private/tmp/profiles/filament.json"],
  },
  autoArrange: true,
  autoOrient: true,
  supportPolicy: "auto",
  maxTrianglesPerPlate: 2_000_000,
  maxSlicingSecondsPerPlate: 600,
};

describe("slicer command construction", () => {
  it("slices raw models with explicit resolved profiles and real cloned quantity", () => {
    const args = buildSlicerArguments(rawRequest);
    expect(args).toContain("--orient");
    expect(args).toContain("--arrange");
    expect(args).toContain("--clone-objects");
    expect(args).toContain("3");
    expect(args).toContain("--load-settings");
    expect(args).toContain("--load-filaments");
    expect(args).not.toContain("--enable_support=1");
    expect(args).toEqual(expect.arrayContaining(["--mtcpp", "2000000", "--mstpp", "600"]));
    expect(args).not.toContain("--export-3mf");
    expect(args.at(-1)).toBe("/private/tmp/part.stl");
  });

  it("preserves embedded project settings and exports a sliced project archive", () => {
    const args = buildSlicerArguments({
      ...rawRequest,
      inputPath: "/private/tmp/customer-project.3mf",
      quantity: 1,
      profiles: undefined,
      autoOrient: true,
    });
    expect(args).toContain("--export-3mf");
    expect(args).toContain("estimate.gcode.3mf");
    expect(args).not.toContain("--orient");
    expect(args).not.toContain("--arrange");
    expect(args).not.toContain("--load-settings");
  });

  it("fails closed for unapproved raw profiles, unsafe output names, and ambiguous project quantities", () => {
    expect(() => buildSlicerArguments({ ...rawRequest, profiles: undefined })).toThrow("Raw models require resolved");
    expect(() => buildSlicerArguments({ ...rawRequest, outputFilename: "../estimate.gcode.3mf" })).toThrow("simple .gcode.3mf");
    expect(() => buildSlicerArguments({
      ...rawRequest,
      inputPath: "/private/tmp/customer-project.3mf",
      profiles: undefined,
      quantity: 2,
    })).toThrow("explicit assembly mapping");
  });
});
