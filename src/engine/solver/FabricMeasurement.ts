import {
  MAX_FABRIC_GSM,
  MIN_FABRIC_GSM,
  makeFabricProfile,
  type FabricPhysics,
  type FabricProfileDocument,
} from './FabricMaterial';

export type FabricMeasurementSystem = 'KES' | 'FAST';

/**
 * Normalised low-stress laboratory measurements.
 *
 * Bending is stored in µN·m and shear rigidity in N/m so KES and FAST reports
 * can share the same conversion path. Extensions are percentages measured by
 * the source system (KES EM or FAST E100 unless a report says otherwise).
 */
export interface FabricLabMeasurements {
  system: FabricMeasurementSystem;
  name: string;
  arealDensityGsm: number;
  thicknessMm: number;
  extensionWarpPct: number;
  extensionWeftPct: number;
  bendingWarpUNm: number;
  bendingWeftUNm: number;
  shearRigidityNm?: number;
  biasExtensionPct?: number;
  frictionMiu?: number;
  tensileRecoveryPct?: number;
  bendingHysteresisRatio?: number;
}

export interface FabricMeasurementConversion {
  profile: FabricProfileDocument;
  system: FabricMeasurementSystem;
  confidence: 'élevée' | 'moyenne';
  measured: string[];
  estimated: string[];
  warnings: string[];
  measurements: FabricLabMeasurements;
}

export type FabricMeasurementParseResult =
  | { ok: true; conversion: FabricMeasurementConversion }
  | { ok: false; error: string };

type FlatValues = Record<string, unknown>;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Log-space interpolation keeps the solver's compliance decades smooth. */
function logInterpolate(value: number, anchors: ReadonlyArray<readonly [number, number]>): number {
  const first = anchors[0]!;
  const last = anchors[anchors.length - 1]!;
  if (value <= first[0]) return first[1];
  if (value >= last[0]) return last[1];
  for (let i = 1; i < anchors.length; i++) {
    const upper = anchors[i]!;
    const lower = anchors[i - 1]!;
    if (value <= upper[0]) {
      const t = (value - lower[0]) / (upper[0] - lower[0]);
      return 10 ** (Math.log10(lower[1]) + t * (Math.log10(upper[1]) - Math.log10(lower[1])));
    }
  }
  return last[1];
}

const EXTENSION_TO_COMPLIANCE: ReadonlyArray<readonly [number, number]> = [
  [1, 3e-9],
  [2, 1e-8],
  [3, 3e-8],
  [6, 8e-8],
  [15, 4e-7],
  [25, 1e-6],
  [35, 3e-6],
  [55, 8e-6],
  [70, 2e-5],
];

const SHEAR_TO_COMPLIANCE: ReadonlyArray<readonly [number, number]> = [
  [4, 1.5e-5],
  [8, 8e-6],
  [15, 3e-6],
  [30, 8e-7],
  [60, 1e-7],
  [120, 1e-8],
  [250, 2e-9],
];

const BENDING_TO_COMPLIANCE: ReadonlyArray<readonly [number, number]> = [
  [1, 8e-4],
  [5, 3e-4],
  [10, 1.5e-4],
  [30, 4e-5],
  [60, 1e-5],
  [120, 2e-6],
  [300, 3e-7],
];

/**
 * Convert physical low-stress measurements to this XPBD solver's calibrated
 * coefficients. The mapping is explicit and versionable: it is not presented
 * as a universal KES/FAST equation.
 */
export function convertFabricMeasurements(input: FabricLabMeasurements): FabricMeasurementConversion {
  const warnings: string[] = [];
  const estimated: string[] = [];
  const measured = [
    'masse surfacique',
    'épaisseur',
    'extension chaîne',
    'extension trame',
    'flexion chaîne',
    'flexion trame',
  ];
  const positive = (value: number, fallback: number, label: string): number => {
    if (Number.isFinite(value) && value > 0) return value;
    warnings.push(`${label} invalide : valeur de calibration utilisée`);
    return fallback;
  };
  const rawDensityGsm = positive(input.arealDensityGsm, 180, 'masse surfacique');
  const rawThicknessMm = positive(input.thicknessMm, 0.6, 'épaisseur');
  const rawWarpExtension = positive(input.extensionWarpPct, 3, 'extension chaîne');
  const rawWeftExtension = positive(input.extensionWeftPct, 5, 'extension trame');
  const rawBendingWarp = positive(input.bendingWarpUNm, 35, 'flexion chaîne');
  const rawBendingWeft = positive(input.bendingWeftUNm, 25, 'flexion trame');

  const densityGsm = clamp(rawDensityGsm, MIN_FABRIC_GSM, MAX_FABRIC_GSM);
  if (densityGsm !== rawDensityGsm) {
    warnings.push(
      `masse limitée à la plage stable de TOILE (${MIN_FABRIC_GSM}–${MAX_FABRIC_GSM} g/m²)`,
    );
  }
  const realThicknessMm = clamp(rawThicknessMm, 0.05, 5);
  if (realThicknessMm !== rawThicknessMm) warnings.push('épaisseur labo limitée à 0,05–5 mm');
  const warpExtension = clamp(rawWarpExtension, 1, 70);
  const weftExtension = clamp(rawWeftExtension, 1, 70);
  if (warpExtension !== rawWarpExtension || weftExtension !== rawWeftExtension) {
    warnings.push('extension limitée à la plage du solveur (1–70 %)');
  }

  let shearRigidity = input.shearRigidityNm;
  if (shearRigidity == null && input.biasExtensionPct != null && input.biasExtensionPct > 0) {
    // FAST defines G ≈ 123 / EB5, with EB5 expressed as a percentage.
    shearRigidity = 123 / input.biasExtensionPct;
    measured.push('extension biais');
  } else if (shearRigidity != null) {
    measured.push('rigidité de cisaillement');
  }
  shearRigidity = clamp(shearRigidity ?? 18, 0.5, 500);
  if (input.shearRigidityNm == null && input.biasExtensionPct == null) {
    estimated.push('cisaillement');
    warnings.push('cisaillement absent : valeur textile médiane utilisée');
  }

  const densityKg = densityGsm / 1000;
  // Actual textile thickness is below the collision distance supported by the
  // current real-time mesh. Mass participates in this effective contact shell
  // so a dense/thick denim remains visibly bulkier than silk.
  const collisionThickness = clamp(
    0.002 + realThicknessMm * 0.002 + densityKg * 0.008,
    0.002,
    0.01,
  );
  estimated.push('épaisseur de collision', 'amortissement', 'prise au vent');

  let frictionStatic: number;
  if (input.frictionMiu != null) {
    frictionStatic = clamp(input.frictionMiu * 1.8, 0.15, 0.9);
    measured.push('friction KES MIU');
    estimated.push('contact tissu-avatar');
    warnings.push('MIU est converti en contact tissu-avatar ; ce n’est pas le même couple de surfaces');
  } else {
    frictionStatic = 0.5;
    estimated.push('friction');
    warnings.push(`${input.system} ne fournit pas ici de friction exploitable : μ=0,50 utilisé`);
  }

  let creaseYieldDeg = 42;
  let creaseMemory = 0.25;
  let creaseRecovery = 0.25;
  if (input.bendingHysteresisRatio != null) {
    const ratio = clamp(input.bendingHysteresisRatio, 0, 2);
    creaseYieldDeg = clamp(58 - ratio * 25, 12, 70);
    creaseMemory = clamp(0.05 + ratio * 0.9, 0.03, 1.8);
    creaseRecovery = clamp(1.2 / (1 + ratio * 8), 0.03, 1.2);
    measured.push('hystérésis de flexion');
  } else if (input.tensileRecoveryPct != null) {
    const recovery = clamp(input.tensileRecoveryPct, 10, 100);
    creaseRecovery = clamp(0.03 + ((recovery - 10) / 90) * 1.17, 0.03, 1.2);
    creaseMemory = clamp(1.1 - creaseRecovery * 0.75, 0.08, 1.2);
    creaseYieldDeg = clamp(25 + recovery * 0.35, 20, 65);
    measured.push('résilience');
    estimated.push('hystérésis de flexion');
    warnings.push('la résilience en traction guide le pli, faute d’hystérésis de flexion');
  } else {
    const meanBend = Math.sqrt(rawBendingWarp * rawBendingWeft);
    const stiffness = clamp((Math.log10(meanBend) - Math.log10(3)) / 2, 0, 1);
    creaseMemory = 0.12 + stiffness * 0.65;
    creaseRecovery = 0.7 - stiffness * 0.6;
    creaseYieldDeg = 52 - stiffness * 25;
    estimated.push('mémoire et récupération des plis');
    warnings.push('hystérésis absente : comportement du pli estimé depuis la rigidité');
  }

  const physics: FabricPhysics = {
    stretch: logInterpolate(weftExtension, EXTENSION_TO_COMPLIANCE),
    stretchWarp: logInterpolate(warpExtension, EXTENSION_TO_COMPLIANCE),
    shear: logInterpolate(shearRigidity, SHEAR_TO_COMPLIANCE),
    bend: logInterpolate(clamp(rawBendingWeft, 0.1, 1000), BENDING_TO_COMPLIANCE),
    bendWarp: logInterpolate(clamp(rawBendingWarp, 0.1, 1000), BENDING_TO_COMPLIANCE),
    stretchLimit: weftExtension / 100,
    shearLimit: clamp(input.biasExtensionPct ?? 123 / shearRigidity, 3, 70) / 100,
    arealDensity: densityKg,
    collisionThickness,
    damping: clamp(0.2 + densityKg * 2.1, 0.2, 1.6),
    airDrag: clamp(
      1.05 * Math.sqrt(0.16 / densityKg) * Math.sqrt(0.5 / realThicknessMm),
      0.2,
      2,
    ),
    frictionStatic,
    frictionDynamic: frictionStatic * 0.75,
    creaseYieldDeg,
    creaseMemory,
    creaseRecovery,
  };

  return {
    profile: makeFabricProfile(input.name, physics, `${input.system} · conversion TOILE v1`),
    system: input.system,
    confidence: estimated.length <= 4 ? 'élevée' : 'moyenne',
    measured,
    estimated,
    warnings,
    measurements: { ...input },
  };
}

function normaliseKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[µμ]/g, 'u')
    .replace(/²/g, '2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const compact = value.trim().replace(/\s/g, '').replace(',', '.');
  const match = compact.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstNumber(values: FlatValues, aliases: readonly string[]): number | undefined {
  for (const alias of aliases) {
    const value = parseNumber(values[normaliseKey(alias)]);
    if (value != null) return value;
  }
  return undefined;
}

function firstString(values: FlatValues, aliases: readonly string[]): string | undefined {
  for (const alias of aliases) {
    const value = values[normaliseKey(alias)];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function normaliseObject(raw: Record<string, unknown>): FlatValues {
  const out: FlatValues = {};
  for (const [key, value] of Object.entries(raw)) out[normaliseKey(key)] = value;
  return out;
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseDelimited(text: string): FlatValues | null {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  const candidates = ['\t', ';', ','];
  const delimiter = candidates
    .map((candidate) => ({ candidate, count: splitDelimitedLine(lines[0]!, candidate).length }))
    .sort((a, b) => b.count - a.count)[0]!.candidate;
  const rows = lines.map((line) => splitDelimitedLine(line, delimiter));
  const first = rows[0]!.map(normaliseKey);

  // Property/value/unit laboratory export.
  const propertyColumn = first.findIndex((key) => ['property', 'propriete', 'parameter', 'parametre', 'symbol'].includes(key));
  const valueColumn = first.findIndex((key) => ['value', 'valeur', 'result', 'resultat'].includes(key));
  if (propertyColumn >= 0 && valueColumn >= 0) {
    const out: FlatValues = {};
    for (const row of rows.slice(1)) {
      const key = row[propertyColumn];
      const value = row[valueColumn];
      if (key) out[normaliseKey(key)] = value;
    }
    return out;
  }

  // Header row followed by one sample row.
  if (rows[0]!.length >= 3 && rows[1]) {
    const out: FlatValues = {};
    for (let i = 0; i < rows[0]!.length; i++) {
      const key = rows[0]![i];
      if (key) out[normaliseKey(key)] = rows[1]![i] ?? '';
    }
    return out;
  }

  // Bare key/value rows.
  const out: FlatValues = {};
  for (const row of rows) {
    if (row[0] && row[1] != null) out[normaliseKey(row[0])] = row[1];
  }
  return Object.keys(out).length ? out : null;
}

function inferSystem(values: FlatValues, filename: string): FabricMeasurementSystem | null {
  const explicit = firstString(values, ['system', 'method', 'methode', 'source'])?.toUpperCase();
  if (explicit?.includes('KES') || explicit?.includes('KAWABATA')) return 'KES';
  if (explicit?.includes('FAST') || explicit?.includes('SIRO')) return 'FAST';
  const hint = filename.toUpperCase();
  if (hint.includes('KES') || values['miu'] != null || values['2hb'] != null) return 'KES';
  if (hint.includes('FAST') || values['e100warp'] != null || values['eb5'] != null) return 'FAST';
  return null;
}

function labMeasurementsFromValues(values: FlatValues, filename: string): FabricMeasurementParseResult {
  const system = inferSystem(values, filename);
  if (!system) return { ok: false, error: 'méthode absente : indiquez KES ou FAST dans la colonne system' };

  const directMass = firstNumber(values, [
    'massGsm',
    'weightGsm',
    'arealDensityGsm',
    'wGsm',
    'gsm',
    'grammage',
    'g/m²',
    'g/m2',
  ]);
  const kesMass = firstNumber(values, ['wMgCm2', 'massMgCm2', 'weightMgCm2']);
  const arealDensityGsm = directMass ?? (kesMass != null ? kesMass * 10 : undefined);
  const thicknessMm = firstNumber(values, ['thicknessMm', 't2Mm', 't0Mm', 'thickness', 'epaisseurMm']);
  const extensionWarpPct = firstNumber(values, [
    'extensionWarpPct',
    'warpExtensionPct',
    'e100WarpPct',
    'e100Warp',
    'emWarpPct',
    'emWarp',
  ]);
  const extensionWeftPct = firstNumber(values, [
    'extensionWeftPct',
    'weftExtensionPct',
    'e100WeftPct',
    'e100Weft',
    'emWeftPct',
    'emWeft',
  ]);

  const plainBendWarp = firstNumber(values, ['bWarp', 'bendingWarp']);
  const plainBendWeft = firstNumber(values, ['bWeft', 'bendingWeft']);
  const bendWarpUNm =
    firstNumber(values, ['bendingWarpUNm', 'bWarpUNm', 'brWarpUNm']) ??
    (firstNumber(values, ['bendingWarpGfCm', 'bWarpGfCm']) ?? (system === 'KES' ? plainBendWarp : undefined))! * 98.0665;
  const bendWeftUNm =
    firstNumber(values, ['bendingWeftUNm', 'bWeftUNm', 'brWeftUNm']) ??
    (firstNumber(values, ['bendingWeftGfCm', 'bWeftGfCm']) ?? (system === 'KES' ? plainBendWeft : undefined))! * 98.0665;
  const bendingWarpUNm = Number.isFinite(bendWarpUNm) ? bendWarpUNm : system === 'FAST' ? plainBendWarp : undefined;
  const bendingWeftUNm = Number.isFinite(bendWeftUNm) ? bendWeftUNm : system === 'FAST' ? plainBendWeft : undefined;

  const directShear = firstNumber(values, ['shearRigidityNm', 'gNm', 'shearGNm']);
  const kesShear = firstNumber(values, ['gGfCmDeg', 'shearGfCmDeg']);
  const shearRigidityNm = directShear ?? (kesShear != null ? kesShear * 56.188 : undefined);
  const biasExtensionPct = firstNumber(values, ['biasExtensionPct', 'eb5Pct', 'eb5']);
  const frictionMiu = firstNumber(values, ['frictionMiu', 'miu']);
  const rtWarp = firstNumber(values, ['rtWarpPct', 'rtWarp']);
  const rtWeft = firstNumber(values, ['rtWeftPct', 'rtWeft']);
  const tensileRecoveryPct =
    rtWarp != null && rtWeft != null ? (rtWarp + rtWeft) / 2 : rtWarp ?? rtWeft;
  let bendingHysteresisRatio = firstNumber(values, [
    'bendingHysteresisRatio',
    '2hbOverB',
    '2HB/B',
    'hysteresisRatio',
  ]);
  if (bendingHysteresisRatio == null && system === 'KES') {
    const hbWarp = firstNumber(values, ['2hbWarp', 'hbWarp']);
    const hbWeft = firstNumber(values, ['2hbWeft', 'hbWeft']);
    const hb = hbWarp != null && hbWeft != null ? (hbWarp + hbWeft) / 2 : hbWarp ?? hbWeft;
    const b = plainBendWarp != null && plainBendWeft != null
      ? (plainBendWarp + plainBendWeft) / 2
      : plainBendWarp ?? plainBendWeft;
    if (hb != null && b != null && b > 0) bendingHysteresisRatio = hb / b;
  }

  const missing: string[] = [];
  if (arealDensityGsm == null) missing.push('massGsm');
  if (thicknessMm == null) missing.push('thicknessMm/T2');
  if (extensionWarpPct == null) missing.push('extensionWarpPct/E100/EM');
  if (extensionWeftPct == null) missing.push('extensionWeftPct/E100/EM');
  if (bendingWarpUNm == null) missing.push('bendingWarpUNm/B warp');
  if (bendingWeftUNm == null) missing.push('bendingWeftUNm/B weft');
  if (shearRigidityNm == null && biasExtensionPct == null) missing.push('shearRigidityNm/G ou biasExtensionPct/EB5');
  if (missing.length) return { ok: false, error: `mesures manquantes : ${missing.join(', ')}` };
  const invalid: string[] = [];
  if (arealDensityGsm! <= 0) invalid.push('massGsm');
  if (thicknessMm! <= 0) invalid.push('thicknessMm/T2');
  if (extensionWarpPct! <= 0) invalid.push('extensionWarpPct/E100/EM');
  if (extensionWeftPct! <= 0) invalid.push('extensionWeftPct/E100/EM');
  if (bendingWarpUNm! <= 0) invalid.push('bendingWarpUNm/B warp');
  if (bendingWeftUNm! <= 0) invalid.push('bendingWeftUNm/B weft');
  if (shearRigidityNm != null && shearRigidityNm <= 0) invalid.push('shearRigidityNm/G');
  if (biasExtensionPct != null && biasExtensionPct <= 0) invalid.push('biasExtensionPct/EB5');
  if (invalid.length) return { ok: false, error: `mesures non positives : ${invalid.join(', ')}` };

  const fallbackName = filename.replace(/\.(?:csv|tsv|txt|json)$/i, '').trim() || 'Échantillon mesuré';
  const measurements: FabricLabMeasurements = {
    system,
    name: firstString(values, ['name', 'nom', 'sample', 'sampleName', 'echantillon']) ?? fallbackName,
    arealDensityGsm: arealDensityGsm!,
    thicknessMm: thicknessMm!,
    extensionWarpPct: extensionWarpPct!,
    extensionWeftPct: extensionWeftPct!,
    bendingWarpUNm: bendingWarpUNm!,
    bendingWeftUNm: bendingWeftUNm!,
    ...(shearRigidityNm != null ? { shearRigidityNm } : {}),
    ...(biasExtensionPct != null ? { biasExtensionPct } : {}),
    ...(frictionMiu != null ? { frictionMiu } : {}),
    ...(tensileRecoveryPct != null ? { tensileRecoveryPct } : {}),
    ...(bendingHysteresisRatio != null ? { bendingHysteresisRatio } : {}),
  };
  return { ok: true, conversion: convertFabricMeasurements(measurements) };
}

/**
 * Parse a TOILE measurement JSON document or a common horizontal/vertical
 * KES/FAST CSV export. The required field names are included in error messages
 * so a lab report can be adapted without guessing.
 */
export function parseFabricMeasurementText(
  text: string,
  filename = 'echantillon',
): FabricMeasurementParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'fichier vide' };
  if (trimmed.startsWith('{')) {
    try {
      const raw = JSON.parse(trimmed) as {
        format?: string;
        version?: number;
        system?: unknown;
        name?: unknown;
        measurements?: Record<string, unknown>;
      };
      if (raw.format !== 'toile-fabric-measurement' || raw.version !== 1 || !raw.measurements) {
        return { ok: false, error: 'document de mesure TOILE v1 non reconnu' };
      }
      return labMeasurementsFromValues(
        normaliseObject({ ...raw.measurements, system: raw.system, name: raw.name }),
        filename,
      );
    } catch {
      return { ok: false, error: 'JSON invalide' };
    }
  }
  const values = parseDelimited(text);
  if (!values) return { ok: false, error: 'tableau CSV/TSV non reconnu' };
  return labMeasurementsFromValues(values, filename);
}

/** A documented template users and laboratories can fill without vendor CSV. */
export function makeFabricMeasurementTemplate(): object {
  return {
    format: 'toile-fabric-measurement',
    version: 1,
    system: 'FAST',
    name: 'Nom de l’échantillon',
    measurements: {
      massGsm: 180,
      thicknessMm: 0.6,
      extensionWarpPct: 3,
      extensionWeftPct: 6,
      biasExtensionPct: 12,
      bendingWarpUNm: 35,
      bendingWeftUNm: 25,
      frictionMiu: 0.3,
    },
    notes: {
      extension: 'FAST E100 ou KES EM, en %',
      bending: 'µN·m ; pour KES, utiliser bendingWarpGfCm/bendingWeftGfCm si le rapport est en gf·cm',
      shear: 'shearRigidityNm peut remplacer biasExtensionPct (FAST EB5)',
      optional: 'tensileRecoveryPct ou bendingHysteresisRatio améliorent la mémoire de pli',
    },
  };
}
