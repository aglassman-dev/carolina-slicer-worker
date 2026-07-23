import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { parseRawSlicerResult, parseSlicedProductionArchive } from "@/lib/slicing/slice-metadata";

describe("production slice metadata", () => {
  it("reads authoritative totals and manufacturing details from a sliced project archive", () => {
    const zip = new AdmZip();
    zip.addFile("Metadata/slice_info.config", Buffer.from(`<?xml version="1.0"?>
      <config>
        <header><header_item key="X-BBL-Client-Version" value="02.06.01.55"/></header>
        <plate>
          <metadata key="index" value="1"/>
          <metadata key="prediction" value="3600"/>
          <metadata key="weight" value="42.5"/>
          <metadata key="support_used" value="true"/>
          <object identify_id="1" name="Model A" skipped="false"/>
          <object identify_id="2" name="Model B" skipped="true"/>
          <filament id="1" type="PLA" color="#FFFFFF" used_g="40" used_for_object="true"/>
          <filament id="2" type="PVA" color="#000000" used_g="2.5" used_for_support="true"/>
          <nozzle id="1" nozzle_diameter="0.4"/>
          <warning msg="sample_warning"/>
        </plate>
      </config>`));

    expect(parseSlicedProductionArchive(zip.toBuffer())).toMatchObject({
      slicerVersion: "02.06.01.55",
      plateCount: 1,
      objectCount: 1,
      predictedSeconds: 3600,
      totalGrams: 42.5,
      supportUsed: true,
      colors: ["#FFFFFF", "#000000"],
      materialTypes: ["PLA", "PVA"],
      nozzleDiameters: [0.4],
      warnings: ["sample_warning"],
    });
  });

  it("combines raw-model result.json totals with G-code material and support headers", () => {
    const result = {
      error_string: "Success.",
      return_code: 0,
      sliced_plates: [{
        id: 1,
        total_predication: 1348.392,
        feature_type_times: { "Support interface": 23.5 },
        filaments: [
          { filament_id: "PLA-ID", id: 1, main_used_g: 10, total_used_g: 10.5 },
          { filament_id: "PVA-ID", id: 2, main_used_g: 1.25, total_used_g: 1.5 },
        ],
        objects: [{ name: "part-1" }, { name: "part-2" }, { name: "part-3" }],
        warning_message: "thin_wall",
      }],
    };
    const gcode = `; HEADER_BLOCK_START
; BambuStudio 02.06.01.55
; HEADER_BLOCK_END
; enable_support = 1
; filament_colour = #00AE42;#FFFFFF
; filament_is_support = 0,1
; filament_type = PLA;PVA
; nozzle_diameter = 0.4
`;

    expect(parseRawSlicerResult(JSON.stringify(result), [gcode])).toMatchObject({
      slicerVersion: "BambuStudio 02.06.01.55",
      plateCount: 1,
      objectCount: 3,
      predictedSeconds: 1348.392,
      totalGrams: 12,
      supportUsed: true,
      colors: ["#00AE42", "#FFFFFF"],
      materialTypes: ["PLA", "PVA"],
      nozzleDiameters: [0.4],
      warnings: ["thin_wall"],
      plates: [{
        filaments: [
          { id: "PLA-ID", grams: 10.5, usedForModel: true, usedForSupport: false },
          { id: "PVA-ID", grams: 1.5, usedForModel: false, usedForSupport: true },
        ],
      }],
    });
  });

  it("rejects incomplete or failed slicer output", () => {
    expect(() => parseRawSlicerResult('{"return_code":1,"error_string":"Could not arrange","sliced_plates":[]}', [])).toThrow("Could not arrange");
    expect(() => parseRawSlicerResult('{"sliced_plates":[{}]}', [])).toThrow("unsuccessful result");
    expect(() => parseRawSlicerResult('{"return_code":0,"sliced_plates":[]}', [])).toThrow("no completed plates");
  });
});
