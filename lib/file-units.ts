export type LengthUnit = "mm" | "cm" | "in" | "m" | "ft" | "um";

export type IntakeUnitStatus = "not_applicable" | "checking" | "required" | "resolved";

export interface IntakeFile {
  id: string;
  file: File;
  units: LengthUnit | null;
  unitStatus: IntakeUnitStatus;
}

export const USER_UNIT_OPTIONS: Array<{ value: LengthUnit; label: string }> = [
  { value: "mm", label: "Millimeters (mm)" },
  { value: "cm", label: "Centimeters (cm)" },
  { value: "in", label: "Inches (in)" },
];

const UNIT_TO_MM: Record<LengthUnit, number> = {
  mm: 1,
  cm: 10,
  in: 25.4,
  m: 1000,
  ft: 304.8,
  um: 0.001,
};

export function unitScaleToMm(unit: LengthUnit | null | undefined) {
  return unit ? UNIT_TO_MM[unit] : 1;
}

export function isLengthUnit(value: unknown): value is LengthUnit {
  return typeof value === "string" && value in UNIT_TO_MM;
}

export function fileExtension(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".gcode.3mf")) return ".gcode.3mf";
  return lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
}

export function initialUnitStatus(name: string): IntakeUnitStatus {
  const ext = fileExtension(name);
  if (ext === ".stl" || ext === ".obj") return "required";
  if (ext === ".step" || ext === ".stp") return "checking";
  return "not_applicable";
}

export function threeMfUnit(text: string): LengthUnit {
  const declared = text.match(/<model\b[^>]*\bunit=["']([^"']+)["']/i)?.[1]?.toLowerCase();
  if (declared === "centimeter") return "cm";
  if (declared === "inch") return "in";
  if (declared === "meter") return "m";
  if (declared === "foot") return "ft";
  if (declared === "micron") return "um";
  return "mm";
}

export function stepUnit(text: string): LengthUnit | null {
  if (/CONVERSION_BASED_UNIT\s*\(\s*['"](?:INCH|INCHES)['"]/i.test(text)) return "in";
  if (/CONVERSION_BASED_UNIT\s*\(\s*['"](?:FOOT|FEET)['"]/i.test(text)) return "ft";
  if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/i.test(text)) return "mm";
  if (/SI_UNIT\s*\(\s*\.CENTI\.\s*,\s*\.METRE\.\s*\)/i.test(text)) return "cm";
  if (/SI_UNIT\s*\(\s*\.MICRO\.\s*,\s*\.METRE\.\s*\)/i.test(text)) return "um";
  if (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.\s*\)/i.test(text)) return "m";
  return null;
}
