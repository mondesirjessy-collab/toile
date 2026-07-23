import { describe, expect, it } from 'vitest';
import {
  convertFabricMeasurements,
  makeFabricMeasurementTemplate,
  parseFabricMeasurementText,
} from '../src/engine/solver/FabricMeasurement';

describe('conversion de mesures KES / FAST', () => {
  it('convertit un relevé FAST normalisé en profil anisotrope', () => {
    const result = convertFabricMeasurements({
      system: 'FAST',
      name: 'Popeline laboratoire',
      arealDensityGsm: 125,
      thicknessMm: 0.35,
      extensionWarpPct: 2.5,
      extensionWeftPct: 5,
      bendingWarpUNm: 42,
      bendingWeftUNm: 28,
      biasExtensionPct: 10,
    });
    expect(result.profile.format).toBe('toile-fabric');
    expect(result.profile.source).toContain('FAST');
    expect(result.profile.physics.arealDensity).toBeCloseTo(0.125);
    expect(result.profile.physics.stretch).toBeGreaterThan(result.profile.physics.stretchWarp);
    expect(result.profile.physics.bend).toBeGreaterThan(result.profile.physics.bendWarp);
    expect(result.estimated).toContain('friction');
    expect(result.warnings.some((warning) => warning.includes('hystérésis'))).toBe(true);
  });

  it('reconnaît un CSV KES, les décimales françaises et les unités historiques', () => {
    const csv = [
      'system;name;W (mg/cm2);T0 (mm);EM warp;EM weft;B warp;B weft;G (gf/cm/deg);MIU;2HB/B',
      'KES;Lin KES;19;0,65;2,5;3,2;0,08;0,06;1,1;0,34;0,8',
    ].join('\n');
    const result = parseFabricMeasurementText(csv, 'lin-kes.csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conversion.measurements.arealDensityGsm).toBe(190);
    expect(result.conversion.measurements.bendingWarpUNm).toBeCloseTo(7.84532, 4);
    expect(result.conversion.measurements.shearRigidityNm).toBeCloseTo(61.8068, 3);
    expect(result.conversion.profile.physics.frictionStatic).toBeCloseTo(0.612);
    expect(result.conversion.measured).toContain('hystérésis de flexion');
  });

  it('reconnaît les exports verticaux propriété / valeur', () => {
    const csv = [
      'Property,Value,Unit',
      'system,FAST,',
      'name,Laine FAST,',
      'GSM,285,g/m2',
      'T2 mm,1.1,mm',
      'E100 warp,5.5,%',
      'E100 weft,7.2,%',
      'B warp uNm,58,uNm',
      'B weft uNm,45,uNm',
      'EB5,14,%',
    ].join('\n');
    const result = parseFabricMeasurementText(csv, 'laine-fast.csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conversion.system).toBe('FAST');
    expect(result.conversion.profile.name).toBe('Laine FAST');
    expect(result.conversion.measurements.biasExtensionPct).toBe(14);
  });

  it('fournit un diagnostic précis quand le laboratoire omet une mesure essentielle', () => {
    const result = parseFabricMeasurementText(
      'system;name;massGsm\nFAST;Incomplet;180',
      'incomplet.csv',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('thicknessMm/T2');
    expect(result.error).toContain('bendingWarpUNm/B warp');
  });

  it('génère un modèle JSON immédiatement réimportable', () => {
    const template = JSON.stringify(makeFabricMeasurementTemplate());
    const result = parseFabricMeasurementText(template, 'modele.json');
    expect(result.ok).toBe(true);
  });
});
