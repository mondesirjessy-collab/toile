import { describe, expect, it } from 'vitest';
import { arrangementPoints, type BodyMeasure } from '../src/engine/body/measure';
import { arrangementVolumes, pointOnVolume, roleArrangeTarget, volumePlaneAxesAt, volumeRadialAt, volumeSettingsOf } from '../src/engine/body/cloArrangement';

const measure = (over: Partial<BodyMeasure> = {}): BodyMeasure => ({
  height: 1.65,
  neckY: 1.42,
  shoulderY: 1.38,
  shoulderHalfW: 0.19,
  chest: { y: 1.22, halfW: 0.14, halfD: 0.11, circ: 0.9 },
  waist: { y: 1.03, halfW: 0.12, halfD: 0.1, circ: 0.75 },
  hip: { y: 0.86, halfW: 0.17, halfD: 0.12, circ: 0.98 },
  thigh: { y: 0.62, halfW: 0.08, halfD: 0.09, circ: 0.55 },
  arm: { y: 1.33, z: -0.02, rootX: 0.2 },
  ...over,
});

describe("points d'arrangement (grille CLO complète, mensurations réelles)", () => {
  it('place chaque ancre HORS du corps, à hauteur plausible', () => {
    const m = measure();
    const pts = arrangementPoints(m);

    const byId = Object.fromEntries(pts.map((p) => [p.id, p.pos]));
    // Héritées : devant/dos dégagés au-delà de la demi-profondeur mesurée.
    expect(byId['torso-front']![2]).toBeGreaterThan(m.chest.halfD);
    expect(byId['torso-back']![2]).toBeLessThan(-m.chest.halfD);
    expect(byId['side-right']![0]).toBeGreaterThan(m.shoulderHalfW);
    expect(byId['arm-right']![1]).toBeGreaterThan(m.arm!.y);
    // Grille CLO : centres devant/dos dégagés eux aussi.
    expect(byId['body-front-center-3']![2]).toBeGreaterThan(m.chest.halfD);
    expect(byId['body-back-center-3']![2]).toBeLessThan(-m.chest.halfD);
    // Hauteurs dans le corps [0, height + marge].
    for (const p of pts) {
      expect(p.pos[1]).toBeGreaterThan(0);
      expect(p.pos[1]).toBeLessThan(m.height + 0.3);
      expect(p.labelFr.length).toBeGreaterThan(2);
    }
    // Pas d'id en double (la Map du rangement écraserait en silence).
    expect(new Set(pts.map((p) => p.id)).size).toBe(pts.length);
  });

  it('les offsets signature CLO : taille plaquée −40 mm, col dégagé +40 mm', () => {
    const m = measure();
    const byId = Object.fromEntries(arrangementPoints(m).map((p) => [p.id, p.pos]));
    // Taille (niveau 4) : dégagement 0,10 − 0,04 = 0,06 m au-delà de la surface.
    expect(byId['body-front-center-4']![2]).toBeCloseTo(m.waist.halfD + 0.06, 2);
    // Autres niveaux : dégagement plein 0,10 m.
    expect(byId['body-front-center-3']![2]).toBeGreaterThan(byId['body-front-center-4']![2]!);
    // Col : dos du cou, rayon CLO à l'échelle + 40 mm.
    const collar = byId['neck-collar']!;
    expect(collar[2]).toBeLessThan(0);
    expect(-collar[2]).toBeCloseTo(0.081 * (m.height / 1.75) + 0.04, 3);
    expect(collar[1]).toBeCloseTo(m.neckY, 6);
  });

  it('paires symétriques : miroir exact en x sur TOUTE la grille', () => {
    const pts = arrangementPoints(measure());
    const byId = new Map(pts.map((p) => [p.id, p.pos] as const));
    let pairs = 0;
    for (const [id, pos] of byId) {
      const mirror = id.includes('-r')
        ? id.replace('-right', '-left').replace(/-r-/, '-l-').replace(/-r$/, '-l')
        : null;
      if (!mirror || mirror === id || !byId.has(mirror)) continue;
      const l = byId.get(mirror)!;
      expect(l[0]).toBeCloseTo(-pos[0], 9);
      expect(l[1]).toBeCloseTo(pos[1], 9);
      expect(l[2]).toBeCloseTo(pos[2], 9);
      pairs += 1;
    }
    expect(pairs).toBeGreaterThan(20); // torse, jambes, chevilles, cou, tête…
  });

  it('sans axe de bras mesuré (bras baissés) : pas de pastilles bras', () => {
    const pts = arrangementPoints(measure({ arm: undefined }));
    expect(pts.every((p) => !p.id.startsWith('arm-') && !p.id.startsWith('wrist-'))).toBe(true);
  });

  it("avec l'axe mesuré : la grille bras CLO (4 directions × 3) + poignets", () => {
    const path = [
      { x: 0.22, y: 1.33, z: -0.02 },
      { x: 0.45, y: 1.32, z: -0.05 },
      { x: 0.62, y: 1.31, z: -0.08 },
    ];
    const pts = arrangementPoints(measure({ arm: { y: 1.33, z: -0.02, rootX: 0.2, path } }));
    const ids = new Set(pts.map((p) => p.id));
    for (const d of ['front', 'back', 'outside', 'inside'])
      for (const n of [1, 2, 3]) {
        expect(ids.has(`arm-r-${d}-${n}`)).toBe(true);
        expect(ids.has(`arm-l-${d}-${n}`)).toBe(true);
      }
    expect(ids.has('wrist-r-outside')).toBe(true);
    // arm-…-1 (épaule) est plus proche de la racine que arm-…-3 (poignet).
    const byId = Object.fromEntries(pts.map((p) => [p.id, p.pos]));
    expect(byId['arm-r-front-1']![0]).toBeLessThan(byId['arm-r-front-3']![0]!);
  });

  it('le volume jupe CLO : plus large que la hanche, sous le bassin', () => {
    const m = measure();
    const byId = Object.fromEntries(arrangementPoints(m).map((p) => [p.id, p.pos]));
    const front = byId['skirt-front']!;
    expect(front[2]).toBeGreaterThan(m.hip.halfD); // le cône déborde la hanche
    expect(front[1]).toBeLessThan(m.hip.y); // près du bassin, sous lui
    expect(byId['skirt-back']![2]).toBeLessThan(0);
  });

  it("l'éditeur : pointOnVolume ↔ volumeSettingsOf font l'aller-retour", () => {
    const m = measure();
    for (const vol of arrangementVolumes(m)) {
      for (const [x, y, off] of [
        [25, 55, 0],
        [75, 80, 40],
        [0, 30, -20],
        [60, 50, 15],
      ] as const) {
        const pos = pointOnVolume(vol, x, y, off);
        const s = volumeSettingsOf(vol, pos);
        // Tranches (poignet, cheville, cou) : l'axe quasi nul rend Y non
        // significatif — seule la section compte.
        const isSlice = Math.abs(vol.b[1] - vol.a[1]) < 0.05;
        expect(s.xPct).toBeCloseTo(x, 0);
        if (!isSlice) expect(s.yPct).toBeCloseTo(y, 0);
        expect(s.offsetMm).toBeCloseTo(off, 0);
      }
    }
  });

  it("l'axe d'Orientation : la normale radiale pointe hors du volume", () => {
    const m = measure();
    const vols = new Map(arrangementVolumes(m).map((v) => [v.id, v] as const));
    const torso = vols.get('torso')!;
    expect(volumeRadialAt(torso, 25)).toEqual([-0, 0, 1]); // devant = +Z
    expect(volumeRadialAt(torso, 0)[0]).toBeCloseTo(1, 9); // côté D = +X
    expect(volumeRadialAt(torso, 75)[2]).toBeCloseTo(-1, 9); // dos = −Z
    // Volume couché (bras) : « dessus » = +Y monde.
    const path = [
      { x: 0.22, y: 1.33, z: -0.02 },
      { x: 0.62, y: 1.31, z: -0.08 },
    ];
    const arm = new Map(
      arrangementVolumes(measure({ arm: { y: 1.33, z: -0.02, rootX: 0.2, path } })).map(
        (v) => [v.id, v] as const,
      ),
    ).get('arm-r')!;
    expect(volumeRadialAt(arm, 0)[1]).toBeCloseTo(1, 9);
  });

  it('les axes des miroirs : trièdre orthonormé au point courant', () => {
    const m = measure();
    const vols = new Map(arrangementVolumes(m).map((v) => [v.id, v] as const));
    const dot = (a: number[], b: number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    const torso = vols.get('torso')!;
    for (const x of [25, 0, 75, 60]) {
      const n = volumeRadialAt(torso, x);
      const { up, right } = volumePlaneAxesAt(torso, x);
      expect(Math.hypot(...up)).toBeCloseTo(1, 9);
      expect(Math.hypot(...right)).toBeCloseTo(1, 9);
      expect(dot(up, n)).toBeCloseTo(0, 9);
      expect(dot(right, n)).toBeCloseTo(0, 9);
      expect(dot(up, right)).toBeCloseTo(0, 9);
    }
    // Torse : le « haut » du plan = +Y monde.
    expect(volumePlaneAxesAt(torso, 25).up[1]).toBeCloseTo(1, 9);
    // Bras couché : le « haut » de la pièce = le long du bras.
    const path = [
      { x: 0.22, y: 1.33, z: -0.02 },
      { x: 0.62, y: 1.31, z: -0.08 },
    ];
    const arm = new Map(
      arrangementVolumes(measure({ arm: { y: 1.33, z: -0.02, rootX: 0.2, path } })).map(
        (v) => [v.id, v] as const,
      ),
    ).get('arm-r')!;
    expect(Math.abs(volumePlaneAxesAt(arm, 0).up[0])).toBeGreaterThan(0.9);
  });

  it('la table rôle→recette : les destinations CLO de référence', () => {
    const m = measure();
    // Ceinture : PLAQUÉE à −40 mm (dégagement 0,10 − 0,04 = 0,06 devant).
    const waist = roleArrangeTarget(m, 'waist')!;
    expect(waist.recipe.offsetMm).toBe(-40);
    expect(waist.pos[2]).toBeGreaterThan(0); // devant
    const front = roleArrangeTarget(m, 'front')!;
    expect(front.pos[2]).toBeGreaterThan(waist.pos[2]); // la ceinture est plus près
    // Bande d'encolure : au DOS du cou (Neck_Back), pas devant.
    const neck = roleArrangeTarget(m, 'neck')!;
    expect(neck.pos[2]).toBeLessThan(0);
    expect(neck.pos[1]).toBeCloseTo(m.neckY, 6);
    // Devant/dos : symétrie avant/arrière au même niveau.
    const back = roleArrangeTarget(m, 'back')!;
    expect(back.pos[1]).toBeCloseTo(front.pos[1], 9);
    expect(back.pos[2]).toBeCloseTo(-front.pos[2], 9);
    // Jambes : devant des cuisses, miroir exact.
    const legR = roleArrangeTarget(m, 'legR')!;
    const legL = roleArrangeTarget(m, 'legL')!;
    expect(legR.pos[0]).toBeCloseTo(-legL.pos[0], 9);
    expect(legR.pos[2]).toBeGreaterThan(0);
    // Manche : HAUT du bras (Y87 du bloc tee CLO) — près de la racine.
    const path = [
      { x: 0.22, y: 1.33, z: -0.02 },
      { x: 0.62, y: 1.31, z: -0.08 },
    ];
    const withArm = measure({ arm: { y: 1.33, z: -0.02, rootX: 0.2, path } });
    const armR = roleArrangeTarget(withArm, 'armR')!;
    expect(armR.recipe.yPct).toBe(87);
    expect(armR.pos[0]).toBeLessThan(0.32); // vers la racine (épaule), pas le poignet
    expect(armR.pos[1]).toBeGreaterThan(1.33); // au-DESSUS du bras (outside)
    // Sans bras mesuré : le rôle manche n'a pas de cible (pas de volume).
    expect(roleArrangeTarget(m, 'armR')).toBeNull();
    // Rôle inconnu : null.
    expect(roleArrangeTarget(m, 'auto')).toBeNull();
  });

  it('suit la stature : un corps plus grand remonte les ancres', () => {
    const small = arrangementPoints(measure());
    const tall = arrangementPoints(
      measure({
        chest: { y: 1.4, halfW: 0.15, halfD: 0.12, circ: 0.95 },
        waist: { y: 1.2, halfW: 0.13, halfD: 0.11, circ: 0.8 },
      }),
    );
    const yOf = (pts: ReturnType<typeof arrangementPoints>, id: string): number =>
      pts.find((p) => p.id === id)!.pos[1];
    expect(yOf(tall, 'torso-front')).toBeGreaterThan(yOf(small, 'torso-front'));
  });
});
