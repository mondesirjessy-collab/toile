import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('shipped neutral male avatar assets', () => {
  it('ships the repaired rigged surface once and aligns its collision proxy', () => {
    const validator = fileURLToPath(
      new URL('../tools/validate_jericho_assets.mjs', import.meta.url),
    );
    const result = spawnSync(process.execPath, [validator, '--json'], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60_000,
    });

    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      repair: {
        sourceIntersections: { count: number };
        repairedIntersections: { count: number };
        movedVertices: number;
        maximumDisplacementMm: number;
        invertedTriangles: number;
      };
      visual: {
        vertices: number;
        triangles: number;
        sha256: string;
        hasTangents: boolean;
        skinJoints: number;
        nodeCount: number;
        maximumWeightError: number;
        selfIntersections: { count: number };
        material: {
          baseColorFactor: number[];
          metallicFactor: number;
          roughnessFactor: number;
          doubleSided: boolean;
          textureCount: number;
          imageCount: number;
        };
      };
      export: {
        vertices: number;
        triangles: number;
        sha256: string;
        hasTangents: boolean;
        skinJoints: number;
        nodeCount: number;
        maximumWeightError: number;
        selfIntersections: { count: number };
        material: {
          baseColorFactor: number[];
          metallicFactor: number;
          roughnessFactor: number;
          doubleSided: boolean;
          textureCount: number;
          imageCount: number;
        };
      };
      proxy: {
        vertices: number;
        triangles: number;
        manifoldEdges: number;
        selfIntersections: { count: number };
      };
      alignment: { proxyToExportMm: number };
    };
    expect(report.ok).toBe(true);
    expect(report.repair.sourceIntersections.count).toBe(18);
    expect(report.repair.repairedIntersections.count).toBe(0);
    expect(report.repair.movedVertices).toBe(25);
    expect(report.repair.maximumDisplacementMm).toBeCloseTo(10.1058878277, 6);
    expect(report.repair.invertedTriangles).toBe(0);
    expect(report.visual.triangles).toBe(1_766);
    expect(report.visual.vertices).toBe(885);
    expect(report.visual.sha256).toBe('cb23e6635743328c3637c46b0ee29343de5f3a87c4279df6ff6e9a1e8ebb3263');
    expect(report.visual.hasTangents).toBe(false);
    expect(report.visual.skinJoints).toBe(25);
    expect(report.visual.nodeCount).toBe(26);
    expect(report.visual.maximumWeightError).toBeLessThan(1e-6);
    expect(report.visual.selfIntersections.count).toBe(0);
    expect(report.visual.material).toEqual({
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 0,
      roughnessFactor: 0.5,
      doubleSided: false,
      textureCount: 0,
      imageCount: 0,
    });
    expect(report.export.vertices).toBe(885);
    expect(report.export.triangles).toBe(1_766);
    expect(report.export.sha256).toBe(report.visual.sha256);
    expect(report.export.hasTangents).toBe(false);
    expect(report.export.skinJoints).toBe(25);
    expect(report.export.nodeCount).toBe(26);
    expect(report.export.maximumWeightError).toBeLessThan(1e-6);
    expect(report.export.selfIntersections.count).toBe(0);
    expect(report.export.material).toEqual(report.visual.material);
    expect(report.proxy.vertices).toBe(885);
    expect(report.proxy.triangles).toBe(1_766);
    expect(report.proxy.manifoldEdges).toBe(2_649);
    expect(report.proxy.selfIntersections.count).toBe(0);
    expect(report.alignment.proxyToExportMm).toBeLessThanOrEqual(4);
  }, 65_000);
});
