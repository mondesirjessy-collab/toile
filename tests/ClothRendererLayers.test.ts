import { describe, expect, it } from 'vitest';
import {
  countVisualLayers,
  partitionClothTriangles,
  ribbonVisualOffset,
} from '../src/app/ClothRenderer';

describe('countVisualLayers', () => {
  it('keeps a multi-piece garment on one visual layer', () => {
    // Body + two sleeves + collar: eight physical panels, one garment layer.
    expect(countVisualLayers(new Float32Array(8).fill(0))).toBe(1);
  });

  it('uses the highest explicit solver layer plus one', () => {
    expect(countVisualLayers(new Float32Array([0, 0, 1, 1]))).toBe(2);
    expect(countVisualLayers(new Float32Array([0, 2, 1]))).toBe(3);
  });

  it('defaults legacy single garments to one layer', () => {
    expect(countVisualLayers()).toBe(1);
    expect(countVisualLayers(new Float32Array())).toBe(1);
  });
});

describe('ribbonVisualOffset', () => {
  it('lifts a jersey seam shell by one collision thickness', () => {
    expect(ribbonVisualOffset(0.005)).toBeCloseTo(0.005, 8);
  });

  it('caps thick-fabric lift at 5 mm and tapers by vertex weight', () => {
    expect(ribbonVisualOffset(0.008)).toBeCloseTo(0.005, 8);
    expect(ribbonVisualOffset(0.008, 0.5)).toBeCloseTo(0.0025, 8);
    expect(ribbonVisualOffset(0.008, 0)).toBe(0);
  });
});

describe('partitionClothTriangles', () => {
  it('keeps a complete safety surface and overlays the complete cap vertex star', () => {
    const n = 4;
    const panelSize = n * n;
    const partition = partitionClothTriangles(
      new Uint32Array([
        n + 1, n + 2, 2 * n + 1, // ordinary front interior
        panelSize + n + 1, panelSize + n + 2, panelSize + 2 * n + 1,
        0, 1, n, // front triangle touching the sewn edge
        panelSize, panelSize + 1, panelSize + n, // matching back triangle
        panelSize, 1, 0, // first half of the cap
        panelSize, panelSize + 1, 1, // second half of the cap
      ]),
      n,
    );
    expect([...partition.surface]).toEqual([
      n + 1, n + 2, 2 * n + 1,
      panelSize + n + 1, panelSize + n + 2, panelSize + 2 * n + 1,
      0, 1, n,
      panelSize, panelSize + 1, panelSize + n,
      panelSize, 1, 0,
      panelSize, panelSize + 1, 1,
    ]);
    expect([...partition.ribbons]).toEqual([
      panelSize, 1, 0,
      panelSize, panelSize + 1, 1,
      0, 1, n,
      panelSize, panelSize + 1, panelSize + n,
    ]);
    expect([...partition.ribbonWeights]).toEqual([
      1, 1, 1,
      1, 1, 1,
      1, 1, 0,
      1, 1, 0,
    ]);
  });

  it('does not confuse a later garment panel with a seam ribbon', () => {
    const n = 4;
    const panelSize = n * n;
    const triangle = [2 * panelSize, 2 * panelSize + 1, 2 * panelSize + n];
    const partition = partitionClothTriangles(new Uint32Array(triangle), n);
    expect([...partition.surface]).toEqual(triangle);
    expect(partition.ribbons).toHaveLength(0);
    expect(partition.ribbonWeights).toHaveLength(0);
  });

  it('keeps genuine overlapping panel surfaces in the smooth pass', () => {
    const n = 4;
    const panelSize = n * n;
    const overlappingSurfaces = [
      0, 1, n,
      panelSize, panelSize + 1, panelSize + n,
    ];
    const partition = partitionClothTriangles(
      new Uint32Array(overlappingSurfaces),
      n,
    );

    expect([...partition.surface]).toEqual(overlappingSurfaces);
    expect(partition.ribbons).toHaveLength(0);
    expect(partition.ribbonWeights).toHaveLength(0);
  });

  it('never removes a triangle from the safety surface', () => {
    const n = 4;
    const panelSize = n * n;
    const boundaryCell = [
      0, n, 1,
      1, n, n + 1,
      panelSize, panelSize + 1, panelSize + n,
      panelSize + 1, panelSize + n + 1, panelSize + n,
    ];
    const partition = partitionClothTriangles(
      new Uint32Array([
        ...boundaryCell,
        panelSize, 1, 0,
        panelSize, panelSize + 1, 1,
      ]),
      n,
    );

    expect([...partition.surface]).toEqual([
      ...boundaryCell,
      panelSize, 1, 0,
      panelSize, panelSize + 1, 1,
    ]);
    expect([...partition.ribbons]).toEqual([
      panelSize, 1, 0,
      panelSize, panelSize + 1, 1,
      0, n, 1,
      1, n, n + 1,
      panelSize, panelSize + 1, panelSize + n,
      panelSize + 1, panelSize + n + 1, panelSize + n,
    ]);
    expect([...partition.ribbonWeights]).toEqual([
      1, 1, 1,
      1, 1, 1,
      1, 0, 1,
      1, 0, 0,
      1, 1, 0,
      1, 0, 0,
    ]);
  });

  it('includes vertex-only neighbours but excludes faces without a cap vertex', () => {
    const n = 4;
    const panelSize = n * n;
    const mixed = [panelSize, 1, 0];
    const edgeNeighbour = [0, 1, n];
    const vertexOnly = [0, n, n + 1];
    const interior = [n + 1, n + 2, 2 * n + 1];
    const source = [...mixed, ...edgeNeighbour, ...vertexOnly, ...interior];
    const partition = partitionClothTriangles(new Uint32Array(source), n);

    expect([...partition.surface]).toEqual(source);
    expect([...partition.ribbons]).toEqual([
      ...mixed,
      ...edgeNeighbour,
      ...vertexOnly,
    ]);
    expect([...partition.ribbonWeights]).toEqual([
      1, 1, 1,
      1, 1, 0,
      1, 0, 0,
    ]);
  });
});
