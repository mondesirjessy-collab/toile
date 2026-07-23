import { describe, expect, it } from 'vitest';
import {
  FABRIC_PHYSICS,
  FABRIC_PRESET_NAMES,
  MAX_FABRIC_GSM,
  MIN_FABRIC_GSM,
  REFERENCE_AREAL_DENSITY,
  clampFabricGsm,
  fabricMaterialId,
  fabricMaterialLibrary,
  fabricMaterialTable,
  makeFabricProfile,
  packFabricMaterialTable,
  sanitizeFabricProfile,
  scaleInverseMasses,
  scaleInverseMassesByMaterial,
} from '../src/engine/solver/FabricMaterial';

describe('profils physiques des tissus', () => {
  it('une matière lourde réduit correctement les masses inverses sans réveiller les particules coupées', () => {
    const base = new Float32Array([1, 0, 0.5]);
    const light = scaleInverseMasses(base, 0.1);
    const heavy = scaleInverseMasses(base, 0.4);
    expect(light[0]).toBeCloseTo(REFERENCE_AREAL_DENSITY / 0.1);
    expect(heavy[0]).toBeCloseTo(REFERENCE_AREAL_DENSITY / 0.4);
    expect(light[0]).toBeGreaterThan(heavy[0]!);
    expect(light[1]).toBe(0);
    expect(heavy[2]).toBeCloseTo(0.25);
  });

  it('les sept presets ont des paramètres finis et un frottement dynamique inférieur au statique', () => {
    expect(Object.keys(FABRIC_PHYSICS)).toEqual([
      'Jersey',
      'Maille',
      'Popeline',
      'Denim',
      'Lin',
      'Laine',
      'Soie',
    ]);
    for (const material of Object.values(FABRIC_PHYSICS)) {
      expect(Object.values(material).every(Number.isFinite)).toBe(true);
      expect(material.arealDensity).toBeGreaterThan(0);
      expect(material.collisionThickness).toBeGreaterThan(0);
      expect(material.frictionDynamic).toBeLessThanOrEqual(material.frictionStatic);
      expect(material.bendWarp).toBeGreaterThan(0);
      expect(material.creaseYieldDeg).toBeGreaterThan(0);
      expect(material.creaseMemory).toBeGreaterThanOrEqual(0);
      expect(material.creaseRecovery).toBeGreaterThanOrEqual(0);
    }
  });

  it('sépare les propriétés que les anciens presets confondaient', () => {
    const silk = FABRIC_PHYSICS.Soie!;
    const denim = FABRIC_PHYSICS.Denim!;
    expect(silk.arealDensity).toBeLessThan(denim.arealDensity);
    expect(silk.airDrag).toBeGreaterThan(denim.airDrag);
    expect(silk.collisionThickness).toBeLessThan(denim.collisionThickness);
    expect(silk.bend).toBeGreaterThan(denim.bend); // compliance : plus grand = plus souple
    expect(silk.frictionDynamic).toBeLessThan(denim.frictionDynamic);
    expect(FABRIC_PHYSICS.Maille!.stretchLimit).toBeGreaterThan(denim.stretchLimit);
    expect(denim.creaseMemory).toBeGreaterThan(FABRIC_PHYSICS.Jersey!.creaseMemory);
    expect(denim.creaseRecovery).toBeLessThan(FABRIC_PHYSICS.Jersey!.creaseRecovery);
  });

  it('conserve un ordre stable et applique la masse propre à chaque pièce', () => {
    const table = fabricMaterialTable(FABRIC_PHYSICS.Jersey!);
    expect(table).toHaveLength(1 + FABRIC_PRESET_NAMES.length);
    expect(fabricMaterialId(undefined)).toBe(0);
    expect(fabricMaterialId('Denim')).toBe(4);
    expect(packFabricMaterialTable(table)).toHaveLength(table.length * 16);

    const ids = new Uint32Array([
      fabricMaterialId('Soie'),
      fabricMaterialId('Denim'),
      fabricMaterialId('Denim'),
    ]);
    const masses = scaleInverseMassesByMaterial(new Float32Array([1, 1, 0]), ids, table);
    expect(masses[0]).toBeGreaterThan(masses[1]!); // soie légère, denim lourd
    expect(masses[2]).toBe(0); // une particule coupée reste morte
  });

  it('crée et déduplique les variantes GSM sans modifier les autres propriétés du tissu', () => {
    const library = fabricMaterialLibrary(FABRIC_PHYSICS.Jersey!, [
      { preset: 'Denim', arealDensityGsm: 320 },
      { preset: 'Denim', arealDensityGsm: 320 },
      { arealDensityGsm: 150 },
    ]);

    expect(library.materials).toHaveLength(10); // 8 bases + deux variantes
    expect(library.ids[0]).toBe(library.ids[1]);
    expect(library.ids[0]).toBeGreaterThan(FABRIC_PRESET_NAMES.length);
    expect(library.baseIds).toEqual(new Uint32Array([4, 4, 0]));
    const denimVariant = library.materials[library.ids[0]!]!;
    expect(denimVariant.arealDensity).toBeCloseTo(0.32);
    expect({ ...denimVariant, arealDensity: FABRIC_PHYSICS.Denim!.arealDensity }).toEqual(
      FABRIC_PHYSICS.Denim,
    );
    expect(library.globalVariantIds).toEqual([library.ids[2]]);
  });

  it('partage les mêmes bornes GSM entre saisie, profils et masses du solveur', () => {
    expect(clampFabricGsm(5)).toBe(MIN_FABRIC_GSM);
    expect(clampFabricGsm(5000)).toBe(MAX_FABRIC_GSM);
    expect(clampFabricGsm(Number.NaN, 240)).toBe(240);
    expect(clampFabricGsm(Number.NaN, Number.NaN)).toBe(
      REFERENCE_AREAL_DENSITY * 1000,
    );
  });

  it('exporte puis réimporte sans perte tous les profils, y compris le denim très rigide', () => {
    for (const [name, physics] of Object.entries(FABRIC_PHYSICS)) {
      const exported = makeFabricProfile(name, physics, 'banc FAST');
      const imported = sanitizeFabricProfile(JSON.parse(JSON.stringify(exported)));
      expect(imported).toEqual(exported);
    }
  });

  it('rejette un profil incomplet ou physiquement incohérent', () => {
    expect(sanitizeFabricProfile({ format: 'toile-fabric', version: 1 })).toBeNull();
    const valid = makeFabricProfile('Test', FABRIC_PHYSICS.Lin!);
    expect(
      sanitizeFabricProfile({
        ...valid,
        physics: { ...valid.physics, frictionDynamic: valid.physics.frictionStatic + 0.1 },
      }),
    ).toBeNull();
    expect(
      sanitizeFabricProfile({
        ...valid,
        physics: { ...valid.physics, arealDensity: Number.POSITIVE_INFINITY },
      }),
    ).toBeNull();
  });
});
