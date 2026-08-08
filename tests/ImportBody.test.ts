import { describe, expect, it } from 'vitest';
import { parseObj, buildImportedBody } from '../src/engine/body/importBody';
import { gridSd, measureBody } from '../src/engine/body/measure';

// A unit cube (8 verts, 12 tris), Wavefront OBJ with 1-based indices.
const CUBE = `
# unit cube
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 0 0 1
v 1 0 1
v 1 1 1
v 0 1 1
f 1 2 3
f 1 3 4
f 5 7 6
f 5 8 7
f 1 6 2
f 1 5 6
f 2 6 7
f 2 7 3
f 3 7 8
f 3 8 4
f 4 8 5
f 4 5 1
`;

describe('import de corps OBJ (v185)', () => {
  it('parse les sommets et triangule les faces (quads et négatifs compris)', () => {
    const m = parseObj(CUBE);
    expect(m.positions.length).toBe(8 * 3);
    expect(m.indices.length).toBe(12 * 3);
    // quad + indices négatifs → 2 triangles, indices bornés
    const quad = parseObj('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf -4 -3 -2 -1');
    expect(quad.indices.length).toBe(6);
    expect(Math.max(...quad.indices)).toBeLessThan(4);
  });

  it('refuse un OBJ sans géométrie valide', () => {
    expect(() => parseObj('# vide\no chose')).toThrow();
    expect(() => parseObj('v 0 0 0\nf 1 2 9')).toThrow(); // index hors sommets
  });

  it('voxélise en SDF : négatif dedans, positif dehors, debout et à 1,70 m', () => {
    const built = buildImportedBody(parseObj(CUBE), { voxel: 0.03 });
    // normalisé : pieds à ~0, hauteur ~1,70 m
    expect(built.grid.max[1]).toBeGreaterThan(1.7);
    expect(built.grid.min[1]).toBeLessThanOrEqual(0);
    const sd = gridSd(built.grid);
    // centre du cube normalisé : x≈0 (centré), y≈0,85 (mi-hauteur), z≈0
    expect(sd(0, 0.85, 0)).toBeLessThan(0); // dedans
    // loin sur le côté : dehors
    expect(sd(2, 0.85, 0)).toBeGreaterThan(0);
    // le mesh de rendu a des normales finies
    expect(built.mesh.normals.length).toBe(built.mesh.positions.length);
    expect([...built.mesh.normals].every(Number.isFinite)).toBe(true);
  });

  it('produit un corps MESURABLE (measureBody ne renvoie que des cotes finies)', () => {
    // La vraie question du live : applyBody('scan import') mesure le grid ;
    // si une cote est NaN/0, le rebuild reçoit du poison. Un corps simple mais
    // volumineux doit donner des mensurations finies et strictement positives.
    const W = 0.25, H = 1.7, D = 0.14;
    const v = [[-W,0,-D],[W,0,-D],[W,H,-D],[-W,H,-D],[-W,0,D],[W,0,D],[W,H,D],[-W,H,D]];
    let obj = v.map((p) => `v ${p[0]} ${p[1]} ${p[2]}`).join('\n') + '\n';
    const F = [[1,2,3,4],[8,7,6,5],[5,6,2,1],[6,7,3,2],[7,8,4,3],[8,5,1,4]];
    obj += F.map((f) => `f ${f.join(' ')}`).join('\n');
    const built = buildImportedBody(parseObj(obj), { voxel: 0.03 });
    const m = measureBody(gridSd(built.grid), built.grid.max[1] - 0.06);
    // Aucune cote NaN — c'est ce qui empoisonnerait le rebuild (le vrai risque).
    for (const cote of [m.height, m.chest.circ, m.waist.circ, m.hip.circ, m.thigh.circ, m.shoulderHalfW]) {
      expect(Number.isFinite(cote)).toBe(true);
    }
    // Le TRONC d'un volume plein est mesuré (>0). Carrure et cuisse peuvent
    // être nulles sur ce pavé sans épaules ni jambes distinctes — un vrai scan
    // humain les mesure. L'essentiel : jamais de NaN.
    for (const cote of [m.height, m.chest.circ, m.waist.circ, m.hip.circ]) {
      expect(cote).toBeGreaterThan(0);
    }
  });

  it('redresse un corps Z-up (rotation propre, hauteur sur la plus longue dimension)', () => {
    // un « bâtonnet » haut sur Z : après import il doit être haut sur Y
    const stick = 'v 0 0 0\nv 0.1 0 0\nv 0.1 0.1 0\nv 0 0.1 0\nv 0 0 2\nv 0.1 0 2\nv 0.1 0.1 2\nv 0 0.1 2\n'
      + 'f 1 2 3\nf 1 3 4\nf 5 7 6\nf 5 8 7\nf 1 6 2\nf 1 5 6\nf 2 6 7\nf 2 7 3\nf 3 7 8\nf 3 8 4\nf 4 8 5\nf 4 5 1';
    const built = buildImportedBody(parseObj(stick), { voxel: 0.05 });
    const h = built.grid.max[1] - built.grid.min[1];
    expect(h).toBeGreaterThan(1.6); // la grande dimension est devenue la hauteur
  });
});
