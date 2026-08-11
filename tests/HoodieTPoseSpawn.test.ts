import { describe, expect, it } from 'vitest';
import type { BodyMeasure } from '../src/engine/body/measure';
import type { Sd } from '../src/engine/body/measure';
import { lucasHoodie } from '../src/engine/pattern/lucasHoodie';
import { buildLucasHoodieMesh } from '../src/engine/pattern/LucasHoodieAssembly';
import { ConstraintKind } from '../src/engine/solver/ConstraintGraph';

// Régression v200 — la « cape » du hoodie sur mannequin en T (incident Mia).
// Cause : l'enveloppe radiale de placement, cherchant le dégagement du corps
// à hauteur d'épaule, marchait À TRAVERS le bras horizontal et déposait des
// cellules du TORSE sur la face externe du bras, à 30-70× la maille de leurs
// voisines. Le vêtement naissait disloqué et convulsait dès le premier pas.
//
// Ce test reconstruit la condition avec un SDF analytique en T (torse
// vertical + deux bras horizontaux) — sans dépendre d'aucun asset cuit — et
// exige qu'AUCUNE arête structurelle/chaîne des panneaux de torse ne relie
// deux extrémités éloignées de plus de 12 cm au spawn (une téléportation).

const body: BodyMeasure = {
  height: 1.78,
  neckY: 1.51,
  shoulderY: 1.43,
  shoulderHalfW: 0.22,
  chest: { y: 1.28, halfW: 0.24, halfD: 0.145, circ: 1.0 },
  waist: { y: 1.05, halfW: 0.205, halfD: 0.13, circ: 0.86 },
  hip: { y: 0.91, halfW: 0.255, halfD: 0.16, circ: 1.02 },
  thigh: { y: 0.72, halfW: 0.105, halfD: 0.105, circ: 0.66 },
  // Bras dégagé à l'horizontale : c'est la présence de cet axe qui déclenchait
  // la téléportation dans le placeur.
  arm: { y: 1.4356, z: -0.0354, rootX: 0.1943 },
};

const capsule = (
  p: readonly [number, number, number],
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  r: number,
): number => {
  const pax = p[0] - a[0];
  const pay = p[1] - a[1];
  const paz = p[2] - a[2];
  const bax = b[0] - a[0];
  const bay = b[1] - a[1];
  const baz = b[2] - a[2];
  const denom = bax * bax + bay * bay + baz * baz;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay + paz * baz) / Math.max(1e-9, denom)));
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  const dz = paz - baz * h;
  return Math.hypot(dx, dy, dz) - r;
};

// Corps en T : torse (capsule verticale) + tête + deux bras HORIZONTAUX à
// hauteur d'épaule. Négatif à l'intérieur, comme tous les SDF du solveur.
const tPoseSd: Sd = (x, y, z) => {
  const p: [number, number, number] = [x, y * 1.0, z * 1.6];
  const torso = capsule(p, [0, 0.72, 0], [0, 1.5, 0], 0.17);
  const head = capsule([x, y, z], [0, 1.5, 0], [0, 1.72, 0], 0.09);
  const armL = capsule([x, y, z], [-0.16, 1.44, -0.03], [-0.7, 1.44, -0.03], 0.05);
  const armR = capsule([x, y, z], [0.16, 1.44, -0.03], [0.7, 1.44, -0.03], 0.05);
  return Math.min(torso, head, armL, armR);
};

describe('Hoodie · spawn en T-pose sans téléportation (régression v200)', () => {
  it('aucune arête de torse ne relie deux extrémités à plus de 12 cm', { timeout: 30000 }, () => {
    // Le SDF doit vraiment présenter du solide loin en x à hauteur d'épaule,
    // sinon le test ne prouve rien.
    expect(tPoseSd(-0.5, 1.45, 0)).toBeLessThan(0);
    expect(tPoseSd(0.5, 1.45, 0)).toBeLessThan(0);

    const n = 64;
    const panelSize = n * n;
    const { mesh, ranges } = buildLucasHoodieMesh(lucasHoodie('M', body), n, body, tPoseSd);

    const torsoPanels = new Set(
      ranges
        .filter((r) => r.pieceId === 0 || r.pieceId === 1)
        .map((r) => Math.floor(r.first / panelSize)),
    );
    const dv = new DataView(mesh.constraintData);
    const pos = mesh.positions;
    let worstSpan = 0;
    let teleports = 0;
    for (let k = 0; k < mesh.constraintCount; k++) {
      const kind = dv.getUint32(k * 16 + 12, true);
      if (kind !== ConstraintKind.Structural && kind !== ConstraintKind.StructuralWarp) {
        continue;
      }
      const i = dv.getUint32(k * 16, true);
      const j = dv.getUint32(k * 16 + 4, true);
      if (!torsoPanels.has(Math.floor(i / panelSize))) continue;
      const span = Math.hypot(
        pos[i * 4]! - pos[j * 4]!,
        pos[i * 4 + 1]! - pos[j * 4 + 1]!,
        pos[i * 4 + 2]! - pos[j * 4 + 2]!,
      );
      worstSpan = Math.max(worstSpan, span);
      if (span > 0.12) teleports++;
    }
    expect(teleports, `arêtes téléportées=${teleports} · pire portée=${worstSpan.toFixed(3)} m`).toBe(0);
  });
});
