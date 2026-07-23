import type { FabricPhysics } from '../engine/solver/FabricMaterial';

export const SUPPORTED_RESOLUTIONS = [32, 64, 128] as const;
export type SupportedResolution = (typeof SUPPORTED_RESOLUTIONS)[number];
export const GLOBAL_FABRIC_INHERIT_VALUE = '__global__';

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

export function normalizeSelectValue<T extends string>(
  value: unknown,
  options: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && options.includes(value as T)
    ? (value as T)
    : fallback;
}

export function inheritedFabricLabel(globalPreset: string): string {
  return `🧵 Tissu global — ${globalPreset}`;
}

export function pieceFabricSelectEnabled(
  scene: string,
  hasActivePiece: boolean,
): boolean {
  return scene === 'atelier' && hasActivePiece;
}

const FABRIC_PHYSICS_KEYS: readonly (keyof FabricPhysics)[] = [
  'stretch',
  'stretchWarp',
  'shear',
  'bend',
  'bendWarp',
  'stretchLimit',
  'shearLimit',
  'arealDensity',
  'collisionThickness',
  'damping',
  'airDrag',
  'frictionStatic',
  'frictionDynamic',
  'creaseYieldDeg',
  'creaseMemory',
  'creaseRecovery',
];

/**
 * Slider values round-trip through log10 and percentages, so equality needs a
 * scale-aware machine tolerance rather than brittle string/JSON comparison.
 */
export function sameFabricPhysics(
  current: FabricPhysics,
  baseline: FabricPhysics,
): boolean {
  return FABRIC_PHYSICS_KEYS.every((key) => {
    const a = current[key];
    const b = baseline[key];
    const scale = Math.max(1, Math.abs(a), Math.abs(b));
    return Math.abs(a - b) <= Number.EPSILON * scale * 32;
  });
}

export function fabricProfileReport(
  current: FabricPhysics,
  baseline: FabricPhysics,
  baseName: string,
  calibratedReport: string,
): string {
  return sameFabricPhysics(current, baseline)
    ? calibratedReport
    : `modifié (base ${baseName})`;
}
