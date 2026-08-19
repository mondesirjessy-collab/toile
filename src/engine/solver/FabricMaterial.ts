/**
 * Material data used by both the UI presets and the XPBD solver.
 *
 * Values are deliberately expressed in physical/user-facing units where that
 * is meaningful (kg/m² and metres). The compliance values remain calibrated to
 * this solver; they are not vendor KES coefficients.
 */
export interface FabricCompliance {
  /** In-plane compliance across the grain (weft/trame). Higher = stretchier. */
  stretch: number;
  /** In-plane compliance along the grain (warp/chaîne). */
  stretchWarp: number;
  /** Bias/shear compliance. */
  shear: number;
  /** Bending compliance for curvature across the weft. */
  bend: number;
  /** Bending compliance for curvature along the warp/grain. */
  bendWarp: number;
  /** Tensile strain where yarn/loop straightening starts to lock (0.03 = 3%). */
  stretchLimit: number;
  /** Bias strain where the weave starts to shear-lock. */
  shearLimit: number;
}

export interface FabricDynamics {
  /** Areal density in kg/m² (e.g. 0.18 = 180 g/m²). */
  arealDensity: number;
  /**
   * Effective solver contact thickness in metres. This is intentionally larger
   * than microscope thickness on very thin cloth to keep real-time collision
   * robust at the current mesh spacing.
   */
  collisionThickness: number;
  /** Low-speed/internal velocity damping coefficient. */
  damping: number;
  /** Relative aerodynamic coupling: 1 = reference cloth. */
  airDrag: number;
  /** Coulomb threshold before contact starts sliding. */
  frictionStatic: number;
  /** Coulomb coefficient once contact is sliding. */
  frictionDynamic: number;
  /** Fold deviation before the material starts memorising a crease. */
  creaseYieldDeg: number;
  /** Rest-angle adaptation speed after yield, in s⁻¹. */
  creaseMemory: number;
  /** Recovery speed toward the original flat/rest angle, in s⁻¹. */
  creaseRecovery: number;
}

export interface FabricPhysics extends FabricCompliance, FabricDynamics {}

/** Stable order shared by saved patterns, the GPU material table and the UI. */
export const FABRIC_PRESET_NAMES = [
  'Jersey',
  'Maille',
  'Popeline',
  'Denim',
  'Lin',
  'Laine',
  'Soie',
  'Molleton',
  'Cuir',
  'Satin',
  'Twill',
  'Mousseline',
] as const;

export type FabricPresetName = (typeof FABRIC_PRESET_NAMES)[number];

/** Stable apparel range accepted by the authoring UI and persisted drafts. */
export const MIN_FABRIC_GSM = 20;
export const MAX_FABRIC_GSM = 1000;
/** Reference used by the historical mesh, whose live particles had invMass=1. */
export const REFERENCE_AREAL_DENSITY = 0.2;

/**
 * Normalize a user/laboratory grammage. Keeping this conversion in one place
 * prevents the editor (g/m²) and solver (kg/m²) from drifting apart.
 */
export function clampFabricGsm(value: number, fallback = REFERENCE_AREAL_DENSITY * 1000): number {
  const safeFallback = Number.isFinite(fallback)
    ? Math.min(MAX_FABRIC_GSM, Math.max(MIN_FABRIC_GSM, fallback))
    : REFERENCE_AREAL_DENSITY * 1000;
  if (!Number.isFinite(value)) return safeFallback;
  return Math.min(MAX_FABRIC_GSM, Math.max(MIN_FABRIC_GSM, value));
}

export function isFabricPresetName(value: unknown): value is FabricPresetName {
  return typeof value === 'string' && (FABRIC_PRESET_NAMES as readonly string[]).includes(value);
}

/**
 * Material 0 always means “inherit the live global fabric”. Explicit presets
 * start at 1, which lets old meshes/patterns remain byte-compatible.
 */
export function fabricMaterialId(preset: FabricPresetName | undefined): number {
  return preset === undefined ? 0 : FABRIC_PRESET_NAMES.indexOf(preset) + 1;
}

/**
 * Scale the mesh's legacy inverse masses for a material density. Zeros (cut or
 * pinned particles) remain zero. The function is pure so material mass changes
 * can be regression-tested without a GPU.
 */
export function scaleInverseMasses(
  base: ArrayLike<number>,
  arealDensity: number,
  referenceDensity = REFERENCE_AREAL_DENSITY,
): Float32Array<ArrayBuffer> {
  const density = clampFabricGsm(arealDensity * 1000, referenceDensity * 1000) / 1000;
  const scale = referenceDensity / density;
  const out = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) {
    const value = base[i] ?? 0;
    out[i] = value > 0 ? value * scale : 0;
  }
  return out;
}

/** Per-particle density scaling used when one garment mixes several fabrics. */
export function scaleInverseMassesByMaterial(
  base: ArrayLike<number>,
  materialIds: ArrayLike<number>,
  materials: readonly Pick<FabricDynamics, 'arealDensity'>[],
  referenceDensity = REFERENCE_AREAL_DENSITY,
): Float32Array<ArrayBuffer> {
  const out = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) {
    const value = base[i] ?? 0;
    const id = Math.max(0, Math.min(materials.length - 1, Math.round(materialIds[i] ?? 0)));
    const density = clampFabricGsm(
      (materials[id]?.arealDensity ?? referenceDensity) * 1000,
      referenceDensity * 1000,
    ) / 1000;
    out[i] = value > 0 ? value * (referenceDensity / density) : 0;
  }
  return out;
}

/**
 * Calibrated qualitative starting points. They separate construction and
 * weight as well as elasticity, while remaining stable in the real-time mesh.
 * A measured KES/FAST import can later replace any of these values directly.
 */
export const FABRIC_PHYSICS: Record<FabricPresetName, FabricPhysics> = {
  Jersey: {
    stretch: 3e-6,
    stretchWarp: 8e-7,
    shear: 1e-5,
    bend: 2.4e-4,
    bendWarp: 1.7e-4,
    stretchLimit: 0.35,
    shearLimit: 0.45,
    arealDensity: 0.18,
    collisionThickness: 0.005,
    damping: 0.7,
    airDrag: 1.0,
    frictionStatic: 0.6,
    frictionDynamic: 0.44,
    creaseYieldDeg: 55,
    creaseMemory: 0.08,
    creaseRecovery: 0.8,
  },
  Maille: {
    stretch: 8e-6,
    stretchWarp: 2e-6,
    shear: 1.2e-5,
    bend: 2.8e-4,
    bendWarp: 2.1e-4,
    stretchLimit: 0.55,
    shearLimit: 0.55,
    arealDensity: 0.24,
    collisionThickness: 0.006,
    damping: 1.05,
    airDrag: 0.9,
    frictionStatic: 0.65,
    frictionDynamic: 0.5,
    creaseYieldDeg: 65,
    creaseMemory: 0.05,
    creaseRecovery: 1.2,
  },
  Popeline: {
    stretch: 5e-8,
    stretchWarp: 2e-8,
    shear: 1.5e-6,
    bend: 3.5e-5,
    bendWarp: 2.5e-5,
    stretchLimit: 0.03,
    shearLimit: 0.12,
    arealDensity: 0.12,
    collisionThickness: 0.0035,
    damping: 0.35,
    airDrag: 1.1,
    frictionStatic: 0.5,
    frictionDynamic: 0.36,
    creaseYieldDeg: 35,
    creaseMemory: 0.35,
    creaseRecovery: 0.12,
  },
  Denim: {
    stretch: 1e-8,
    stretchWarp: 8e-9,
    shear: 1e-7,
    bend: 6e-6,
    bendWarp: 4e-6,
    stretchLimit: 0.02,
    shearLimit: 0.08,
    arealDensity: 0.4,
    collisionThickness: 0.007,
    damping: 0.8,
    airDrag: 0.35,
    frictionStatic: 0.75,
    frictionDynamic: 0.58,
    creaseYieldDeg: 22,
    creaseMemory: 1.2,
    creaseRecovery: 0.03,
  },
  Lin: {
    stretch: 3e-8,
    stretchWarp: 3e-8,
    shear: 2e-6,
    bend: 9e-5,
    bendWarp: 6e-5,
    stretchLimit: 0.025,
    shearLimit: 0.1,
    arealDensity: 0.19,
    collisionThickness: 0.004,
    damping: 0.45,
    airDrag: 0.65,
    frictionStatic: 0.62,
    frictionDynamic: 0.47,
    creaseYieldDeg: 28,
    creaseMemory: 0.8,
    creaseRecovery: 0.04,
  },
  Laine: {
    stretch: 8e-8,
    stretchWarp: 5e-8,
    shear: 3e-6,
    bend: 1.8e-4,
    bendWarp: 1.3e-4,
    stretchLimit: 0.06,
    shearLimit: 0.2,
    arealDensity: 0.3,
    collisionThickness: 0.008,
    damping: 1.2,
    airDrag: 0.85,
    frictionStatic: 0.72,
    frictionDynamic: 0.55,
    creaseYieldDeg: 45,
    creaseMemory: 0.25,
    creaseRecovery: 0.5,
  },
  Soie: {
    stretch: 1e-8,
    stretchWarp: 1e-8,
    shear: 1.5e-5,
    bend: 6e-4,
    bendWarp: 4.5e-4,
    stretchLimit: 0.03,
    shearLimit: 0.25,
    arealDensity: 0.08,
    collisionThickness: 0.0025,
    damping: 0.25,
    airDrag: 1.6,
    frictionStatic: 0.28,
    frictionDynamic: 0.18,
    creaseYieldDeg: 50,
    creaseMemory: 0.12,
    creaseRecovery: 0.3,
  },
  Molleton: {
    stretch: 6e-6,
    stretchWarp: 1.5e-6,
    shear: 1.1e-5,
    bend: 3.2e-4,
    bendWarp: 2.4e-4,
    stretchLimit: 0.45,
    shearLimit: 0.5,
    arealDensity: 0.33,
    collisionThickness: 0.009,
    damping: 1.1,
    airDrag: 0.7,
    frictionStatic: 0.7,
    frictionDynamic: 0.55,
    creaseYieldDeg: 70,
    creaseMemory: 0.04,
    creaseRecovery: 1.1,
  },
  Cuir: {
    stretch: 5e-9,
    stretchWarp: 5e-9,
    shear: 5e-8,
    bend: 3e-6,
    bendWarp: 2.5e-6,
    stretchLimit: 0.015,
    shearLimit: 0.06,
    arealDensity: 0.55,
    collisionThickness: 0.009,
    damping: 0.9,
    airDrag: 0.25,
    frictionStatic: 0.8,
    frictionDynamic: 0.62,
    creaseYieldDeg: 18,
    creaseMemory: 1.5,
    creaseRecovery: 0.02,
  },
  Satin: {
    stretch: 1e-8,
    stretchWarp: 1e-8,
    shear: 1e-5,
    bend: 5e-4,
    bendWarp: 3.8e-4,
    stretchLimit: 0.03,
    shearLimit: 0.22,
    arealDensity: 0.13,
    collisionThickness: 0.003,
    damping: 0.28,
    airDrag: 1.3,
    frictionStatic: 0.3,
    frictionDynamic: 0.2,
    creaseYieldDeg: 48,
    creaseMemory: 0.15,
    creaseRecovery: 0.28,
  },
  Twill: {
    stretch: 3e-8,
    stretchWarp: 2e-8,
    shear: 8e-7,
    bend: 2e-5,
    bendWarp: 1.4e-5,
    stretchLimit: 0.025,
    shearLimit: 0.1,
    arealDensity: 0.26,
    collisionThickness: 0.005,
    damping: 0.55,
    airDrag: 0.6,
    frictionStatic: 0.6,
    frictionDynamic: 0.46,
    creaseYieldDeg: 30,
    creaseMemory: 0.6,
    creaseRecovery: 0.1,
  },
  Mousseline: {
    stretch: 2e-8,
    stretchWarp: 2e-8,
    shear: 2e-5,
    bend: 7e-4,
    bendWarp: 5.5e-4,
    stretchLimit: 0.03,
    shearLimit: 0.3,
    arealDensity: 0.045,
    collisionThickness: 0.0022,
    damping: 0.2,
    airDrag: 1.9,
    frictionStatic: 0.32,
    frictionDynamic: 0.2,
    creaseYieldDeg: 55,
    creaseMemory: 0.1,
    creaseRecovery: 0.35,
  },
};

/** Four aligned vec4s consumed directly by the WebGPU material shaders. */
export const FABRIC_GPU_FLOATS = 16;

/** Global/inherited material first, followed by the seven stable presets. */
export function fabricMaterialTable(global: FabricPhysics): FabricPhysics[] {
  return [
    { ...global },
    ...FABRIC_PRESET_NAMES.map((name) => ({ ...FABRIC_PHYSICS[name] })),
  ];
}

export interface FabricMaterialSelection {
  preset?: FabricPresetName;
  /** Optional piece-specific override in the unit shown on fabric labels. */
  arealDensityGsm?: number;
}

export interface FabricMaterialLibrary {
  materials: FabricPhysics[];
  /** One material id for each input selection, in the same order. */
  ids: Uint32Array<ArrayBuffer>;
  /** Stable 0..7 construction ids used by the renderer's visual palette. */
  baseIds: Uint32Array<ArrayBuffer>;
  /** Density variants that must keep following live global fabric settings. */
  globalVariantIds: number[];
}

/**
 * Append deduplicated density variants after the stable global/preset table.
 * Every property except areal mass still comes from the selected construction,
 * because GSM alone cannot infer stretch, bending, friction or thickness.
 */
export function fabricMaterialLibrary(
  global: FabricPhysics,
  selections: readonly FabricMaterialSelection[],
): FabricMaterialLibrary {
  const materials = fabricMaterialTable(global);
  const ids = new Uint32Array(selections.length);
  const baseIds = new Uint32Array(selections.length);
  const variants = new Map<string, number>();
  const globalVariantIds: number[] = [];

  selections.forEach((selection, index) => {
    const baseId = fabricMaterialId(selection.preset);
    baseIds[index] = baseId;
    const rawGsm = selection.arealDensityGsm;
    if (rawGsm === undefined || !Number.isFinite(rawGsm)) {
      ids[index] = baseId;
      return;
    }
    const gsm = clampFabricGsm(rawGsm);
    // Imported values may contain harmless floating noise. A milligram per m²
    // is far below the solver's useful precision and makes a stable cache key.
    const key = `${baseId}:${gsm.toFixed(3)}`;
    let id = variants.get(key);
    if (id === undefined) {
      id = materials.length;
      materials.push({ ...materials[baseId]!, arealDensity: gsm / 1000 });
      variants.set(key, id);
      if (baseId === 0) globalVariantIds.push(id);
    }
    ids[index] = id;
  });

  return { materials, ids, baseIds, globalVariantIds };
}

export function packFabricMaterialTable(materials: readonly FabricPhysics[]): Float32Array {
  const out = new Float32Array(Math.max(1, materials.length) * FABRIC_GPU_FLOATS);
  materials.forEach((p, index) => {
    out.set(
      [
        p.stretch,
        p.stretchWarp,
        p.shear,
        p.bend,
        p.bendWarp,
        p.stretchLimit,
        p.shearLimit,
        p.arealDensity,
        p.collisionThickness,
        p.damping,
        p.airDrag,
        p.frictionStatic,
        p.frictionDynamic,
        (p.creaseYieldDeg * Math.PI) / 180,
        p.creaseMemory,
        p.creaseRecovery,
      ],
      index * FABRIC_GPU_FLOATS,
    );
  });
  return out;
}

export interface FabricProfileDocument {
  format: 'toile-fabric';
  version: 1;
  name: string;
  /** Measurement/calibration provenance, e.g. "KES", "FAST" or a lab name. */
  source?: string;
  physics: FabricPhysics;
}

/** Build a portable, versioned material document from live solver settings. */
export function makeFabricProfile(
  name: string,
  physics: FabricPhysics,
  source?: string,
): FabricProfileDocument {
  return {
    format: 'toile-fabric',
    version: 1,
    name: name.trim() || 'Tissu mesuré',
    ...(source?.trim() ? { source: source.trim() } : {}),
    physics: { ...physics },
  };
}

/**
 * Validate a .toile-fabric.json document. Bounds mirror the public controls and
 * deliberately reject NaN/Infinity and unphysical solver values.
 */
export function sanitizeFabricProfile(raw: unknown): FabricProfileDocument | null {
  const d = raw as Partial<FabricProfileDocument> & { physics?: Partial<FabricPhysics> };
  if (d?.format !== 'toile-fabric' || d.version !== 1 || !d.physics) return null;
  const p = d.physics;
  const finite = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  const valid =
    finite(p.stretch, 1e-9, 1e-3) &&
    finite(p.stretchWarp, 1e-9, 1e-3) &&
    finite(p.shear, 1e-9, 1e-3) &&
    finite(p.bend, 1e-9, 1e-3) &&
    finite(p.bendWarp, 1e-9, 1e-3) &&
    finite(p.stretchLimit, 0.01, 0.7) &&
    finite(p.shearLimit, 0.03, 0.7) &&
    finite(p.arealDensity, MIN_FABRIC_GSM / 1000, MAX_FABRIC_GSM / 1000) &&
    finite(p.collisionThickness, 0.002, 0.01) &&
    finite(p.damping, 0.1, 2) &&
    finite(p.airDrag, 0.2, 2) &&
    finite(p.frictionStatic, 0, 1) &&
    finite(p.frictionDynamic, 0, p.frictionStatic) &&
    finite(p.creaseYieldDeg, 5, 85) &&
    finite(p.creaseMemory, 0, 2) &&
    finite(p.creaseRecovery, 0, 2);
  if (!valid) return null;
  return makeFabricProfile(
    typeof d.name === 'string' ? d.name.slice(0, 80) : 'Tissu mesuré',
    p as FabricPhysics,
    typeof d.source === 'string' ? d.source.slice(0, 120) : undefined,
  );
}
