import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { BodyMeasure } from '../src/engine/body/measure';
import type { DraftPiece, EdgeRun, UV } from '../src/engine/pattern/Draft';
import { cloTee, cloPants, teeRuns } from '../src/engine/pattern/cloBlocks';
import { pantsRuns } from '../src/engine/pattern/loosePants';
import { compileAssembly, compileDraft } from '../src/engine/pattern/Draft';
import { buildLoosePantsMesh } from '../src/engine/pattern/LoosePantsAssembly';

const body: BodyMeasure = {
  height: 1.78,
  neckY: 1.51,
  shoulderY: 1.43,
  shoulderHalfW: 0.22,
  chest: { y: 1.28, halfW: 0.24, halfD: 0.145, circ: 1.0 },
  waist: { y: 1.05, halfW: 0.205, halfD: 0.13, circ: 0.86 },
  hip: { y: 0.91, halfW: 0.255, halfD: 0.16, circ: 1.02 },
  thigh: { y: 0.72, halfW: 0.105, halfD: 0.105, circ: 0.66 },
};

// Longueur physique (m) d'un run {from,to} le long du contour (sens direct,
// avec bouclage), en tenant compte de width/height de la pièce.
function runLength(piece: DraftPiece, run: EdgeRun): number {
  const p = piece.outline;
  const n = p.length;
  const phys = (q: UV): [number, number] => [q[0]! * piece.width, q[1]! * piece.height];
  let len = 0;
  let i = run.from;
  let guard = 0;
  while (i !== run.to && guard++ < n + 1) {
    const a = phys(p[i]!);
    const j = (i + 1) % n;
    const b = phys(p[j]!);
    len += Math.hypot(a[0] - b[0], a[1] - b[1]);
    i = j;
  }
  return len;
}

function physOutline(piece: DraftPiece): [number, number][] {
  return piece.outline.map(([u, v]) => [u * piece.width, v * piece.height]);
}

describe('cloBlocks — reconstruction fidèle des blocs CLO', () => {
  it('tee : coutures épaule/côté devant↔dos de longueurs appariées', () => {
    const doc = cloTee(body, body);
    const front = doc.piece;
    const back = doc.back!;
    const fr = teeRuns(front);
    const br = teeRuns(back);
    for (const [name, a, b] of [
      ['épaule D', fr.shoulderR, br.shoulderR],
      ['épaule G', fr.shoulderL, br.shoulderL],
      ['côté D', fr.sideR, br.sideR],
      ['côté G', fr.sideL, br.sideL],
    ] as const) {
      const la = runLength(front, a);
      const lb = runLength(back, b);
      const rel = Math.abs(la - lb) / Math.max(la, lb);
      expect(rel, `${name}: ${(la * 100).toFixed(1)} vs ${(lb * 100).toFixed(1)} cm`).toBeLessThan(0.2);
    }
  });

  it('pantalon : coutures côté/entrejambe devant↔dos appariées', () => {
    const doc = cloPants(body, body);
    const front = doc.piece;
    const back = doc.back!;
    const fr = pantsRuns(front);
    const br = pantsRuns(back);
    const lo = [runLength(front, fr.outseam), runLength(back, br.outseam)];
    const li = [runLength(front, fr.inseam), runLength(back, br.inseam)];
    expect(Math.abs(lo[0]! - lo[1]!) / Math.max(...lo), `côté ${lo.map((x) => (x * 100).toFixed(1))}`).toBeLessThan(0.15);
    expect(Math.abs(li[0]! - li[1]!) / Math.max(...li), `entrejambe ${li.map((x) => (x * 100).toFixed(1))}`).toBeLessThan(0.15);
  });

  it('tee : chaque pièce se compile et l’assemblage produit des coutures', () => {
    const doc = cloTee(body, body);
    for (const piece of [doc.piece, doc.back!, ...(doc.pieces ?? [])]) {
      const compiled = compileDraft(piece, 64);
      expect(compiled).toBeTruthy();
    }
    const seams = compileAssembly(doc, 64);
    expect(seams.length, 'coutures assemblées').toBeGreaterThan(0);
  });

  it('pantalon : buildLoosePantsMesh assemble un maillage vivant', () => {
    const doc = cloPants(body, body);
    const mesh = buildLoosePantsMesh(doc, 64, body.hip.circ);
    expect(mesh.count, 'particules').toBeGreaterThan(0);
    expect(mesh.constraintCount, 'contraintes').toBeGreaterThan(0);
    const finite = Array.from({ length: mesh.count }, (_, i) => mesh.positions[i * 4 + 1]!).every(
      (y) => Number.isFinite(y),
    );
    expect(finite, 'positions finies').toBe(true);
  });

  it('émet la géométrie reconstruite pour aperçu', () => {
    const tee = cloTee(body, body);
    const pants = cloPants(body, body);
    const ft = teeRuns(tee.piece);
    const bt = teeRuns(tee.back!);
    const fp = pantsRuns(pants.piece);
    const bp = pantsRuns(pants.back!);
    const marks = (piece: DraftPiece, runs: Record<string, EdgeRun>): Record<string, [number, number]> => {
      const out: Record<string, [number, number]> = {};
      for (const [k, r] of Object.entries(runs)) {
        const q = piece.outline[r.from]!;
        out[k] = [q[0]! * piece.width, q[1]! * piece.height];
      }
      return out;
    };
    writeFileSync(
      '/tmp/clo-recon.json',
      JSON.stringify({
        teeFront: { outline: physOutline(tee.piece), marks: marks(tee.piece, ft as unknown as Record<string, EdgeRun>) },
        teeBack: { outline: physOutline(tee.back!), marks: marks(tee.back!, bt as unknown as Record<string, EdgeRun>) },
        teeSleeve: { outline: physOutline(tee.pieces![0]!) },
        pantFront: { outline: physOutline(pants.piece), marks: marks(pants.piece, fp as unknown as Record<string, EdgeRun>) },
        pantBack: { outline: physOutline(pants.back!), marks: marks(pants.back!, bp as unknown as Record<string, EdgeRun>) },
      }),
    );
    expect(true).toBe(true);
  });
});
