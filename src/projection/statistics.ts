import { z } from 'zod';

export const projectionParametersSchema = z.object({
  recentWeight: z.number().min(0).max(0.75),
  halfLife: z.number().min(1).max(12),
  priorGames: z.number().min(0).max(12),
}).strict();
export type ProjectionParameters = z.infer<typeof projectionParametersSchema>;
export const DEFAULT_PROJECTION_PARAMETERS: Readonly<ProjectionParameters> = Object.freeze({
  recentWeight: 0.25, halfLife: 4, priorGames: 0.5,
});
export const PROJECTION_MODEL_VERSION = 'ensemble-v1';

export function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function quantile(values: readonly number[], probability: number): number {
  if (!values.length || probability < 0 || probability > 1 || !Number.isFinite(probability)) {
    throw new Error('A quantile needs observations and a probability from zero through one.');
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.some((value) => !Number.isFinite(value))) throw new Error('Quantile observations must be finite.');
  const index = (sorted.length - 1) * probability;
  const low = Math.floor(index);
  return sorted[low]! + (sorted[Math.ceil(index)]! - sorted[low]!) * (index - low);
}

/** Combine a stable mean with recency, then shrink small samples toward a position prior. */
export function forecastMean(
  values: readonly number[],
  priorMean: number | null = null,
  parameters: ProjectionParameters = DEFAULT_PROJECTION_PARAMETERS,
): number {
  if (!values.length || values.some((value) => !Number.isFinite(value))) {
    throw new Error('A forecast needs finite completed game scores.');
  }
  if (priorMean !== null && !Number.isFinite(priorMean)) throw new Error('The position prior must be finite.');
  const config = projectionParametersSchema.parse(parameters);
  let weightedSum = 0;
  let weightSum = 0;
  for (let index = 0; index < values.length; index += 1) {
    const weight = 2 ** (-(values.length - index - 1) / config.halfLife);
    weightedSum += weight * values[index]!;
    weightSum += weight;
  }
  const estimate = mean(values) * (1 - config.recentWeight) + weightedSum / weightSum * config.recentWeight;
  const priorWeight = priorMean === null ? 0 : config.priorGames;
  return (estimate * values.length + (priorMean ?? 0) * priorWeight) / (values.length + priorWeight);
}

/** Chronological residuals never use the predicted game's result as an input. */
export function rollingResiduals(values: readonly number[], parameters: ProjectionParameters): number[] {
  return values.slice(3).map((actual, index) => actual - forecastMean(values.slice(0, index + 3), null, parameters));
}

export function forecastInterval(
  center: number,
  residuals: readonly number[],
  fallbackScores: readonly number[],
): { lower: number; upper: number; level: number; calibrationSamples: number; method: string } {
  if (!Number.isFinite(center)) throw new Error('The forecast center must be finite.');
  if ([...residuals, ...fallbackScores].some((value) => !Number.isFinite(value))) throw new Error('Interval observations must be finite.');
  const eligible = residuals;
  if (eligible.length >= 20) {
    // Finite-sample conformal rank. Coverage under season drift still requires empirical verification.
    const sorted = eligible.map(Math.abs).sort((a, b) => a - b);
    const rank = Math.min(sorted.length, Math.ceil((sorted.length + 1) * 0.8));
    const width = sorted[rank - 1]!;
    return { lower: center - width, upper: center + width, level: 0.8,
      calibrationSamples: eligible.length, method: 'rolling-residual' };
  }
  const average = mean(fallbackScores);
  const variance = fallbackScores.length > 1
    ? fallbackScores.reduce((sum, value) => sum + (value - average) ** 2, 0) / (fallbackScores.length - 1)
    : 0;
  const width = Math.max(1.282 * Math.sqrt(variance * (1 + 1 / Math.max(1, fallbackScores.length))), Math.abs(center) * 0.35, 3);
  return { lower: center - width, upper: center + width, level: 0.8,
    calibrationSamples: eligible.length, method: 'uncalibrated-small-sample' };
}

export function normalCdf(value: number): number {
  const x = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * x);
  const density = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  const upper = density * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return value >= 0 ? 1 - upper : upper;
}
