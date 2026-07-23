import AdmZip from "adm-zip";

function attributes(tag: string) {
  return new Map([...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map((match) => [match[1].toLowerCase(), match[2]]));
}

function numeric(value: string | undefined) {
  if (!value) return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export interface SlicedFilamentUsage {
  id: string;
  type: string | null;
  color: string | null;
  grams: number;
  usedForModel: boolean;
  usedForSupport: boolean;
}

export interface SlicedPlateResult {
  index: number;
  predictedSeconds: number;
  totalGrams: number;
  objectCount: number;
  supportUsed: boolean;
  nozzleDiameters: number[];
  filaments: SlicedFilamentUsage[];
  warnings: string[];
}

export interface SlicedProductionResult {
  slicerVersion: string | null;
  plateCount: number;
  objectCount: number;
  predictedSeconds: number;
  totalGrams: number;
  supportUsed: boolean;
  colors: string[];
  materialTypes: string[];
  nozzleDiameters: number[];
  warnings: string[];
  plates: SlicedPlateResult[];
}

interface RawSlicerFilament {
  filament_id?: unknown;
  id?: unknown;
  main_used_g?: unknown;
  total_used_g?: unknown;
}

interface RawSlicerObject {
  name?: unknown;
}

interface RawSlicerPlate {
  feature_type_times?: unknown;
  filaments?: unknown;
  id?: unknown;
  objects?: unknown;
  total_predication?: unknown;
  warning_message?: unknown;
}

interface RawSlicerResult {
  error_string?: unknown;
  return_code?: unknown;
  sliced_plates?: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function gcodeSetting(gcode: string, key: string) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return gcode.match(new RegExp(`^;\\s*${escapedKey}\\s*[=:]\\s*(.*?)\\s*$`, "mi"))?.[1]?.trim() ?? "";
}

function settingList(value: string, separator: RegExp = /;/) {
  if (!value) return [];
  return value.split(separator).map((item) => item.trim()).filter(Boolean);
}

function rawSlicerVersion(gcode: string) {
  return gcode.match(/^;\s*(BambuStudio|OrcaSlicer)\s+([^\s]+)\s*$/mi)?.slice(1).join(" ") ?? null;
}

/**
 * Parses the structured result.json and G-code headers emitted by Bambu Studio
 * and OrcaSlicer for raw model inputs. The JSON is authoritative for production
 * totals; G-code headers supplement it with material, color, nozzle, and support
 * settings that result.json does not expose.
 */
export function parseRawSlicerResult(resultJson: Buffer | string, gcodes: string[]): SlicedProductionResult {
  const parsed = JSON.parse(Buffer.isBuffer(resultJson) ? resultJson.toString("utf8") : resultJson) as RawSlicerResult;
  if (typeof parsed.return_code !== "number" || parsed.return_code !== 0) {
    throw new Error(`The slicer reported an unsuccessful result: ${stringValue(parsed.error_string) || "unknown error"}.`);
  }

  const rawPlates = arrayValue(parsed.sliced_plates).map((item) => record(item) as RawSlicerPlate | null).filter((item): item is RawSlicerPlate => item !== null);
  if (!rawPlates.length) throw new Error("The slicer result contains no completed plates.");

  const plates = rawPlates.map((rawPlate, plateOffset): SlicedPlateResult => {
    const gcode = gcodes[plateOffset] ?? gcodes[0] ?? "";
    const materialTypes = settingList(gcodeSetting(gcode, "filament_type"));
    const colors = settingList(gcodeSetting(gcode, "filament_colour"));
    const supportFlags = settingList(gcodeSetting(gcode, "filament_is_support"), /[,;]/).map((value) => value === "1");
    const nozzleDiameters = settingList(gcodeSetting(gcode, "nozzle_diameter"), /[,;]/)
      .map((value) => numeric(value))
      .filter((value): value is number => value !== null);
    const supportEnabled = gcodeSetting(gcode, "enable_support") === "1";
    const featureTimes = record(rawPlate.feature_type_times);
    const supportUsed = supportEnabled && Boolean(featureTimes && Object.entries(featureTimes).some(([name, value]) => (
      name.toLowerCase().includes("support") && numberValue(value) > 0
    )));
    const rawFilaments = arrayValue(rawPlate.filaments).map((item) => record(item) as RawSlicerFilament | null).filter((item): item is RawSlicerFilament => item !== null);
    const filaments = rawFilaments.map((rawFilament, filamentOffset): SlicedFilamentUsage => {
      const grams = numberValue(rawFilament.total_used_g) || numberValue(rawFilament.main_used_g);
      return {
        id: String(rawFilament.filament_id ?? rawFilament.id ?? filamentOffset + 1),
        type: materialTypes[filamentOffset] ?? materialTypes[0] ?? null,
        color: colors[filamentOffset] ?? colors[0] ?? null,
        grams,
        usedForModel: grams > 0 && !supportFlags[filamentOffset],
        usedForSupport: grams > 0 && Boolean(supportFlags[filamentOffset]),
      };
    });
    const warning = stringValue(rawPlate.warning_message);
    const objects = arrayValue(rawPlate.objects).map((item) => record(item) as RawSlicerObject | null).filter((item): item is RawSlicerObject => item !== null);

    return {
      index: numberValue(rawPlate.id) || plateOffset + 1,
      predictedSeconds: numberValue(rawPlate.total_predication),
      totalGrams: filaments.reduce((sum, item) => sum + item.grams, 0),
      objectCount: objects.length,
      supportUsed,
      nozzleDiameters,
      filaments,
      warnings: warning ? [warning] : [],
    };
  });

  const materialTypes = [...new Set(plates.flatMap((plate) => plate.filaments.map((item) => item.type).filter((item): item is string => Boolean(item))))];
  const colors = [...new Set(plates.flatMap((plate) => plate.filaments.map((item) => item.color).filter((item): item is string => Boolean(item))))];
  const nozzleDiameters = [...new Set(plates.flatMap((plate) => plate.nozzleDiameters))];
  const warnings = [...new Set(plates.flatMap((plate) => plate.warnings))];
  return {
    slicerVersion: gcodes.map(rawSlicerVersion).find((value): value is string => Boolean(value)) ?? null,
    plateCount: plates.length,
    objectCount: plates.reduce((sum, plate) => sum + plate.objectCount, 0),
    predictedSeconds: plates.reduce((sum, plate) => sum + plate.predictedSeconds, 0),
    totalGrams: Math.round(plates.reduce((sum, plate) => sum + plate.totalGrams, 0) * 100) / 100,
    supportUsed: plates.some((plate) => plate.supportUsed),
    colors,
    materialTypes,
    nozzleDiameters,
    warnings,
    plates,
  };
}

export function parseSlicedProductionArchive(buffer: Buffer): SlicedProductionResult {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntries().find((item) => item.entryName.toLowerCase().endsWith("metadata/slice_info.config"));
  if (!entry) throw new Error("The sliced 3MF does not contain Metadata/slice_info.config.");
  const xml = entry.getData().toString("utf8");
  const slicerVersion = xml.match(/<header_item\b[^>]*key=["']X-BBL-Client-Version["'][^>]*value=["']([^"']+)["']/i)?.[1] ?? null;
  const plates: SlicedPlateResult[] = [];

  for (const match of xml.matchAll(/<plate\b[^>]*>([\s\S]*?)<\/plate>/gi)) {
    const plate = match[1];
    const metadata = new Map<string, string>();
    for (const metadataMatch of plate.matchAll(/<metadata\b[^>]*\/?>/gi)) {
      const values = attributes(metadataMatch[0]);
      const key = values.get("key")?.toLowerCase();
      if (key) metadata.set(key, values.get("value") ?? "");
    }
    const filaments = [...plate.matchAll(/<filament\b[^>]*\/?>/gi)].map((filamentMatch) => {
      const values = attributes(filamentMatch[0]);
      return {
        id: values.get("id") ?? "",
        type: values.get("type")?.trim() || null,
        color: values.get("color")?.trim() || null,
        grams: numeric(values.get("used_g")) ?? 0,
        usedForModel: values.get("used_for_object")?.toLowerCase() === "true",
        usedForSupport: values.get("used_for_support")?.toLowerCase() === "true",
      };
    });
    const warnings = [...plate.matchAll(/<warning\b[^>]*\/?>/gi)].map((warningMatch) => attributes(warningMatch[0]).get("msg") ?? "unknown_slicer_warning");
    const nozzleDiameters = [...plate.matchAll(/<nozzle\b[^>]*\/?>/gi)]
      .map((nozzleMatch) => numeric(attributes(nozzleMatch[0]).get("nozzle_diameter")))
      .filter((value): value is number => value !== null);
    const objects = [...plate.matchAll(/<object\b[^>]*\/?>/gi)]
      .filter((objectMatch) => attributes(objectMatch[0]).get("skipped")?.toLowerCase() !== "true");
    plates.push({
      index: numeric(metadata.get("index")) ?? plates.length + 1,
      predictedSeconds: numeric(metadata.get("prediction")) ?? 0,
      totalGrams: numeric(metadata.get("weight")) ?? filaments.reduce((sum, item) => sum + item.grams, 0),
      objectCount: objects.length,
      supportUsed: metadata.get("support_used")?.toLowerCase() === "true",
      nozzleDiameters,
      filaments,
      warnings,
    });
  }

  if (!plates.length) throw new Error("The sliced 3MF contains no completed plate metadata.");
  const materialTypes = [...new Set(plates.flatMap((plate) => plate.filaments.map((item) => item.type).filter((item): item is string => Boolean(item))))];
  const colors = [...new Set(plates.flatMap((plate) => plate.filaments.map((item) => item.color).filter((item): item is string => Boolean(item))))];
  const nozzleDiameters = [...new Set(plates.flatMap((plate) => plate.nozzleDiameters))];
  const warnings = [...new Set(plates.flatMap((plate) => plate.warnings))];
  return {
    slicerVersion,
    plateCount: plates.length,
    objectCount: plates.reduce((sum, plate) => sum + plate.objectCount, 0),
    predictedSeconds: plates.reduce((sum, plate) => sum + plate.predictedSeconds, 0),
    totalGrams: Math.round(plates.reduce((sum, plate) => sum + plate.totalGrams, 0) * 100) / 100,
    supportUsed: plates.some((plate) => plate.supportUsed),
    colors,
    materialTypes,
    nozzleDiameters,
    warnings,
    plates,
  };
}
