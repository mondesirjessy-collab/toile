export const SUPPORTED_RESOLUTIONS = [32, 64, 128] as const;
export type SupportedResolution = (typeof SUPPORTED_RESOLUTIONS)[number];

/** Keep values coming from DOM option controls inside the supported GPU grids. */
export function normalizeResolution(
  value: unknown,
  fallback: SupportedResolution,
): SupportedResolution {
  const numeric = typeof value === 'number' ? value : Number(value);
  return (SUPPORTED_RESOLUTIONS as readonly number[]).includes(numeric)
    ? (numeric as SupportedResolution)
    : fallback;
}

export function resolutionRebuildMessage(resolution: SupportedResolution): string {
  return `Reconstruction ${resolution} × ${resolution} en cours…`;
}
