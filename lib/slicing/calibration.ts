import { z } from "zod";

export const calibrationSampleSchema = z.object({
  profileSetId: z.string().min(1).max(100),
  resolution: z.enum(["draft", "standard", "fine"]),
  material: z.string().min(1).max(100),
  predictedSeconds: z.number().positive(),
  actualSeconds: z.number().positive(),
  predictedGrams: z.number().positive(),
  actualGrams: z.number().positive(),
  completedAt: z.string().datetime().optional(),
  excluded: z.boolean().optional().default(false),
  notes: z.string().max(1000).optional(),
});

export type CalibrationSample = z.infer<typeof calibrationSampleSchema>;

export interface CalibrationGroupResult {
  profileSetId: string;
  resolution: "draft" | "standard" | "fine";
  material: string;
  sampleCount: number;
  status: "needs-more-data" | "ready-for-review";
  timeFactor: number | null;
  materialFactor: number | null;
  timeMapeBefore: number | null;
  timeMapeAfter: number | null;
  materialMapeBefore: number | null;
  materialMapeAfter: number | null;
}

function rounded(value: number, places: number) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mape(samples: CalibrationSample[], predicted: (sample: CalibrationSample) => number, actual: (sample: CalibrationSample) => number) {
  return samples.reduce((sum, sample) => sum + Math.abs(actual(sample) - predicted(sample)) / actual(sample), 0) / samples.length * 100;
}

export function calculateSlicerCalibration(sampleInput: unknown): CalibrationGroupResult[] {
  const samples = z.array(calibrationSampleSchema).parse(sampleInput).filter((sample) => !sample.excluded);
  const groups = new Map<string, CalibrationSample[]>();
  for (const sample of samples) {
    const key = `${sample.profileSetId}\0${sample.resolution}\0${sample.material.toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }

  return [...groups.values()].map((group): CalibrationGroupResult => {
    const representative = group[0];
    if (group.length < 3) {
      return {
        profileSetId: representative.profileSetId,
        resolution: representative.resolution,
        material: representative.material,
        sampleCount: group.length,
        status: "needs-more-data",
        timeFactor: null,
        materialFactor: null,
        timeMapeBefore: null,
        timeMapeAfter: null,
        materialMapeBefore: null,
        materialMapeAfter: null,
      };
    }
    const timeFactor = median(group.map((sample) => sample.actualSeconds / sample.predictedSeconds));
    const materialFactor = median(group.map((sample) => sample.actualGrams / sample.predictedGrams));
    return {
      profileSetId: representative.profileSetId,
      resolution: representative.resolution,
      material: representative.material,
      sampleCount: group.length,
      status: "ready-for-review",
      timeFactor: rounded(timeFactor, 4),
      materialFactor: rounded(materialFactor, 4),
      timeMapeBefore: rounded(mape(group, (sample) => sample.predictedSeconds, (sample) => sample.actualSeconds), 2),
      timeMapeAfter: rounded(mape(group, (sample) => sample.predictedSeconds * timeFactor, (sample) => sample.actualSeconds), 2),
      materialMapeBefore: rounded(mape(group, (sample) => sample.predictedGrams, (sample) => sample.actualGrams), 2),
      materialMapeAfter: rounded(mape(group, (sample) => sample.predictedGrams * materialFactor, (sample) => sample.actualGrams), 2),
    };
  }).sort((left, right) => (
    left.profileSetId.localeCompare(right.profileSetId)
    || left.resolution.localeCompare(right.resolution)
    || left.material.localeCompare(right.material)
  ));
}
