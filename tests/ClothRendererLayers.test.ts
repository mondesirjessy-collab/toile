import { describe, expect, it } from 'vitest';
import {
  avatarMetalRoughFallback,
  countVisualLayers,
  partitionClothTriangles,
  ribbonVisualOffset,
  packVisualMaterial,
} from '../src/app/ClothRenderer';

describe('avatarMetalRoughFallback', () => {
  it('encodes glTF scalar roughness and metallic factors in their channels', () => {
    expect([...avatarMetalRoughFallback({ roughnessFactor: 0.9, metallicFactor: 0 })])
      .toEqual([0, 230, 0, 255]);
  });

  it('uses glTF defaults and clamps invalid channel ranges', () => {
    expect([...avatarMetalRoughFallback()]).toEqual([0, 255, 255, 255]);
    expect([...avatarMetalRoughFallback({ roughnessFactor: 2, metallicFactor: -1 })])
      .toEqual([0, 255, 0, 255]);
  });
});

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

describe('packVisualMaterial (couleur d’empiècement dans le mot visuel)', () => {
  it('sans couleur : le mot est l’id nu (0-7), inchangé', () => {
    expect(packVisualMaterial(0)).toBe(0);
    expect(packVisualMaterial(4)).toBe(4);
    expect(packVisualMaterial(7, undefined)).toBe(7);
    expect(packVisualMaterial(3, 'pas-un-hex')).toBe(3);
  });

  it('avec couleur : id dans l’octet bas, RGB dans les 24 bits hauts, toujours positif', () => {
    const word = packVisualMaterial(4, '#c2543a');
    expect(word & 0xff).toBe(4);
    expect(word >>> 8).toBe(0xc2543a);
    expect(word).toBeGreaterThan(0);
    // Le pire cas (blanc sur id 255) reste un u32 positif.
    expect(packVisualMaterial(255, '#ffffff')).toBe(((0xffffff << 8) | 0xff) >>> 0);
  });

  it('le noir pur reste encodable (poussé à 0x010101, jamais 0)', () => {
    const word = packVisualMaterial(2, '#000000');
    expect(word & 0xff).toBe(2);
    expect(word >>> 8).toBe(0x010101);
  });
});
