import { describe, it, expect } from 'vitest';
import {
  pointInPolygon,
  pointInTriangle,
  isSelfIntersecting,
  sanitizeDraft,
  defaultDraft,
  insertOutlineVertex,
  deleteOutlineVertex,
  compileDraft,
  compileAssembly,
  compileCrossSeams,
  crossSewnOpenCells,
  removeFreePiece,
  tshirtDraft,
  reindexAssemblySeams,
  pieceIdOf,
  docPieces,
  type UV,
  type DraftPiece,
} from '../src/engine/pattern/Draft';
import { generateSeamedPanels, countMaskIslands, type ClothMeshData } from '../src/engine/cloth/ClothMesh';

describe('Draft geometry', () => {
  const square: UV[] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];

  it('pointInPolygon: inside vs outside a square', () => {
    expect(pointInPolygon([0.5, 0.5], square)).toBe(true);
    expect(pointInPolygon([1.5, 0.5], square)).toBe(false);
    expect(pointInPolygon([-0.1, 0.5], square)).toBe(false);
  });

  it('pointInPolygon: an L-shape excludes the notch', () => {
    const L: UV[] = [
      [0, 0],
      [1, 0],
      [1, 0.5],
      [0.5, 0.5],
      [0.5, 1],
      [0, 1],
    ];
    expect(pointInPolygon([0.25, 0.75], L)).toBe(true); // in the leg
    expect(pointInPolygon([0.75, 0.75], L)).toBe(false); // in the cut corner
  });

  it('pointInTriangle', () => {
    expect(pointInTriangle([0.25, 0.25], [0, 0], [1, 0], [0, 1])).toBe(true);
    expect(pointInTriangle([0.8, 0.8], [0, 0], [1, 0], [0, 1])).toBe(false);
  });

  it('isSelfIntersecting: simple square no, bowtie yes', () => {
    expect(isSelfIntersecting(square)).toBe(false);
    const bowtie: UV[] = [
      [0, 0],
      [1, 1],
      [1, 0],
      [0, 1],
    ];
    expect(isSelfIntersecting(bowtie)).toBe(true);
  });

  it('sanitizeDraft clamps coords and rejects a self-intersecting outline', () => {
    const bad = {
      format: 'toile-draft',
      version: 1,
      gridN: 64,
      piece: { outline: [[0, 0], [1, 1], [1, 0], [0, 1]], darts: [], seams: [], openEdges: [], width: 0.9, height: 1, topY: 1.5, gap: 0.9 },
    };
    const s = sanitizeDraft(bad); // bowtie (self-intersecting) → falls back to default
    expect(s.piece.outline).toEqual(defaultDraft(64).piece.outline);

    const ok = sanitizeDraft({
      format: 'toile-draft',
      version: 1,
      gridN: 999,
      piece: { outline: [[5, -3], [2, 0], [0.5, 2]], darts: [], seams: [], openEdges: [], width: 9, height: 1, topY: 1.5, gap: 0.9 },
    });
    expect(ok.gridN).toBe(64); // 999 rejected
    for (const [x, y] of ok.piece.outline) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
    expect(ok.piece.width).toBeLessThanOrEqual(2); // 9 clamped
  });

  it('rejects a non-draft object', () => {
    expect(sanitizeDraft(null).format).toBe('toile-draft');
    expect(sanitizeDraft({ format: 'nope' }).piece.outline.length).toBeGreaterThanOrEqual(3);
  });

  it('insert/delete outline vertices and re-index the open runs', () => {
    const base = defaultDraft(64).piece; // 7 vertices, openEdges [{1,3},{5,6}]
    // Insert on edge 2 (between v2 and v3) → new vertex at index 3; runs ≥3 shift +1.
    const ins = insertOutlineVertex(base, 2, [0.55, 0.06]);
    expect(ins.outline.length).toBe(8);
    expect(ins.outline[3]).toEqual([0.55, 0.06]);
    expect(ins.openEdges[0]).toEqual({ from: 1, to: 4 }); // to 3 → 4 (was ≥3)
    expect(ins.openEdges[1]).toEqual({ from: 6, to: 7 }); // {5,6} → {6,7}
    // Delete brings it back toward the original count and re-indexes.
    const del = deleteOutlineVertex(ins, 3);
    expect(del.outline.length).toBe(7);
    expect(del.outline).toEqual(base.outline);
    // Never drop below a triangle.
    let tri = { ...base, outline: base.outline.slice(0, 3) };
    tri = deleteOutlineVertex(tri, 0);
    expect(tri.outline.length).toBe(3);
  });

  it('compileDraft: openEdges without darts, and darts pair their legs', () => {
    const base = defaultDraft(64).piece;
    const plain = compileDraft(base, 64);
    expect(plain.extraSeams.length).toBe(0); // no darts
    expect(plain.openCells.size).toBeGreaterThan(0); // neckline + hem cells open

    const withDart = compileDraft(
      { ...base, darts: [{ apex: [0.5, 0.45], legA: [0.45, 0.92], legB: [0.55, 0.92] }] },
      64,
    );
    expect(withDart.extraSeams.length).toBeGreaterThan(0); // legs sewn together
    for (const s of withDart.extraSeams) expect(s.i).not.toBe(s.j);
    // The dart opened MORE boundary cells (its two legs) than the plain piece.
    expect(withDart.openCells.size).toBeGreaterThan(plain.openCells.size);
  });

  it('compileDraft: a hand-seam sews two picked edges together', () => {
    const base = defaultDraft(64).piece; // outline edges: 4→5 (right side), 6→0 (left side)
    const withSeam = compileDraft(
      { ...base, seams: [{ a: { from: 4, to: 5 }, b: { from: 6, to: 0 } }] },
      64,
    );
    expect(withSeam.extraSeams.length).toBeGreaterThan(0); // the two sides zipped
    for (const s of withSeam.extraSeams) expect(s.i).not.toBe(s.j);
  });
});

describe('freeform mesh (shape: freeform)', () => {
  const n = 32;
  const keptCount = (m: ClothMeshData): number => [...m.invMasses].filter((w) => w > 0).length;
  // Outline covering more than [0,1]² → every grid cell is inside → full mask.
  const fullOutline: UV[] = [
    [-0.05, -0.05],
    [1.05, -0.05],
    [1.05, 1.05],
    [-0.05, 1.05],
  ];

  it('a full-cover outline keeps the same mask as a plain rect', () => {
    const rect = generateSeamedPanels({ resolution: n, width: 1, height: 1, gap: 1, topY: 1.5 });
    const free = generateSeamedPanels({ resolution: n, width: 1, height: 1, gap: 1, topY: 1.5, shape: 'freeform', mask: { outline: fullOutline, darts: [] } });
    expect(free.count).toBe(rect.count);
    expect(keptCount(free)).toBe(keptCount(rect)); // all cells kept in both
    expect(keptCount(free)).toBe(2 * n * n);
    // Same fabric topology (mask identical) — structural/shear match.
    expect(free.structuralCount).toBe(rect.structuralCount);
    expect(free.shearCount).toBe(rect.shearCount);
  });

  it('a smaller polygon cuts cells and stays one island', () => {
    const tri: UV[] = [
      [0.5, 0.02],
      [0.95, 0.95],
      [0.05, 0.95],
    ];
    const free = generateSeamedPanels({ resolution: n, width: 1, height: 1, gap: 1, topY: 1.5, shape: 'freeform', mask: { outline: tri, darts: [] } });
    expect(keptCount(free)).toBeLessThan(2 * n * n); // triangle cuts corners
    expect(keptCount(free)).toBeGreaterThan(0);
    // Reconstruct the single-panel mask to check island count.
    const mask: boolean[] = [];
    for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) mask[v * n + u] = free.invMasses[v * n + u]! > 0;
    expect(countMaskIslands(mask, n)).toBe(1);
  });

  it('a dart cuts a wedge (fewer kept cells) and its legs can be sewn via extraSeams', () => {
    const noDart = generateSeamedPanels({ resolution: n, width: 1, height: 1, gap: 1, topY: 1.5, shape: 'freeform', mask: { outline: fullOutline, darts: [] } });
    const withDart = generateSeamedPanels({
      resolution: n, width: 1, height: 1, gap: 1, topY: 1.5, shape: 'freeform',
      mask: { outline: fullOutline, darts: [{ apex: [0.5, 0.5], legA: [0.4, 0.98], legB: [0.6, 0.98] }] },
    });
    expect(keptCount(withDart)).toBeLessThan(keptCount(noDart)); // the wedge is removed

    // extraSeams add Seam constraints (front + back).
    const withSeam = generateSeamedPanels({
      resolution: n, width: 1, height: 1, gap: 1, topY: 1.5, shape: 'freeform',
      mask: { outline: fullOutline, darts: [] },
      extraSeams: [{ i: 5 * n + 5, j: 5 * n + 10 }],
    });
    expect(withSeam.seamCount).toBe(noDart.seamCount + 2); // one pair × 2 panels
  });

  it('extraOpenings leave a boundary run unsewn', () => {
    // Sew nothing (whole boundary open) → far fewer seams than the sealed pillow.
    const sealed = generateSeamedPanels({ resolution: n, width: 1, height: 1, gap: 1, topY: 1.5, shape: 'freeform', mask: { outline: fullOutline, darts: [] } });
    const allOpen = generateSeamedPanels({ resolution: n, width: 1, height: 1, gap: 1, topY: 1.5, shape: 'freeform', mask: { outline: fullOutline, darts: [] }, extraOpenings: () => true });
    expect(allOpen.seamCount).toBeLessThan(sealed.seamCount);
  });

  const panelSize = n * n;
  const keptInPanel = (m: ClothMeshData, p: number): number => {
    let c = 0;
    for (let i = 0; i < panelSize; i++) if (m.invMasses[p * panelSize + i]! > 0) c++;
    return c;
  };

  it('an independent back mask (côte-à-côte) cuts the back panel differently from the front', () => {
    const backTri: UV[] = [
      [0.5, 0.05],
      [0.9, 0.9],
      [0.1, 0.9],
    ];
    const mesh = generateSeamedPanels({
      resolution: n, width: 1, height: 1, gap: 1, topY: 1.5, shape: 'freeform',
      mask: { outline: fullOutline, darts: [] },
      maskBack: { outline: backTri, darts: [] },
    });
    expect(keptInPanel(mesh, 0)).toBe(panelSize); // full front
    expect(keptInPanel(mesh, 1)).toBeLessThan(keptInPanel(mesh, 0)); // back cut to a triangle
    expect(keptInPanel(mesh, 1)).toBeGreaterThan(0);
  });

  it('no back mask → the back panel mirrors the front exactly', () => {
    const tri: UV[] = [
      [0.5, 0.02],
      [0.95, 0.95],
      [0.05, 0.95],
    ];
    const mesh = generateSeamedPanels({ resolution: n, width: 1, height: 1, gap: 1, topY: 1.5, shape: 'freeform', mask: { outline: tri, darts: [] } });
    expect(keptInPanel(mesh, 1)).toBe(keptInPanel(mesh, 0)); // mirror
  });

  it('manual assembly sews nothing by itself; assemblySeams add exactly their constraints', () => {
    const opts = { resolution: n, width: 1, height: 1, gap: 1, topY: 1.5, shape: 'freeform' as const, mask: { outline: fullOutline, darts: [] } };
    const auto = generateSeamedPanels(opts);
    const manual = generateSeamedPanels({ ...opts, manualAssembly: true });
    expect(auto.seamCount).toBeGreaterThan(0); // the automatic perimeter sew
    expect(manual.seamCount).toBe(0); // manual: nothing holds it until the user sews
    const sewn = generateSeamedPanels({
      ...opts,
      manualAssembly: true,
      assemblySeams: [{ i: 5 * n + 5, j: panelSize + 5 * n + 5 }, { i: 6 * n + 6, j: panelSize + 6 * n + 6 }],
    });
    expect(sewn.seamCount).toBe(2); // exactly the two user seams
  });
});

describe('compileAssembly (manual seams)', () => {
  it('pairs a front edge with a back edge into cross-panel cell pairs', () => {
    const doc = defaultDraft(32);
    doc.seams = [{ a: { face: 'front', from: 0, to: 1 }, b: { face: 'back', from: 0, to: 1 } }];
    const cross = compileAssembly(doc, 32);
    expect(cross.length).toBeGreaterThan(0);
    const panelSize = 32 * 32;
    for (const s of cross) {
      expect(s.i).toBeLessThan(panelSize); // front cell → panel 0
      expect(s.j).toBeGreaterThanOrEqual(panelSize); // back cell → panel 1
    }
  });

  it('no seams → no pairs (et la pièce par défaut arrive PRÉ-COUSUE, v119)', () => {
    const bare = defaultDraft(32);
    expect(compileAssembly(bare, 32).length).toBeGreaterThan(0); // épaules + côtés déjà cousus : le premier Simuler drape
    bare.seams = [];
    expect(compileAssembly(bare, 32).length).toBe(0); // sans coutures, rien n'est apparié
  });

  it('reindexAssemblySeams shifts only the edited face after inserting a point', () => {
    const seams = [{ a: { face: 'front' as const, from: 3, to: 4 }, b: { face: 'back' as const, from: 0, to: 1 } }];
    // A point inserted at index 1 on the FRONT pushes front edges ≥ 1 up by one.
    const out = reindexAssemblySeams(seams, 'front', 'insert', 1, 8);
    expect(out[0]!.a).toEqual({ face: 'front', from: 4, to: 5 }); // front run followed its edge
    expect(out[0]!.b).toEqual({ face: 'back', from: 0, to: 1 }); // back face untouched
  });
});

describe('multi-piece free editor (pieceId / cross-seams)', () => {
  const square = (): DraftPiece => ({
    outline: [
      [0.2, 0.2],
      [0.8, 0.2],
      [0.8, 0.8],
      [0.2, 0.8],
    ],
    darts: [],
    seams: [],
    openEdges: [],
    width: 0.5,
    height: 0.5,
    topY: 1.2,
    gap: 0.12,
  });

  it('pieceIdOf normalises face and pieceId (pieceId wins)', () => {
    expect(pieceIdOf({ from: 0, to: 1, face: 'front' })).toBe(0);
    expect(pieceIdOf({ from: 0, to: 1, face: 'back' })).toBe(1);
    expect(pieceIdOf({ from: 0, to: 1, pieceId: 3 })).toBe(3);
    expect(pieceIdOf({ from: 0, to: 1, pieceId: 0, face: 'back' })).toBe(0);
  });

  it('docPieces lists front, back, then free pieces', () => {
    const doc = defaultDraft(32);
    expect(docPieces(doc).length).toBe(2); // front + back
    doc.pieces = [square()];
    const list = docPieces(doc);
    expect(list.length).toBe(3);
    expect(list[2]).toBe(doc.pieces![0]);
  });

  it('compileAssembly IGNORES seams that touch a free piece (≥2)', () => {
    const doc = defaultDraft(32);
    doc.pieces = [square()];
    doc.seams = [{ a: { face: 'front', from: 5, to: 6 }, b: { pieceId: 2, from: 0, to: 1 } }];
    expect(compileAssembly(doc, 32).length).toBe(0); // handled by compileCrossSeams instead
  });

  it('compileCrossSeams sews a base edge to a free piece, offset into the combined mesh', () => {
    const n = 32;
    const panelSize = n * n;
    const doc = defaultDraft(n);
    doc.pieces = [square()];
    doc.seams = [{ a: { face: 'front', from: 5, to: 6 }, b: { pieceId: 2, from: 0, to: 1 } }];
    const baseCount = 2 * panelSize; // front + back panels
    const offsets = [0, panelSize, baseCount]; // pieceId 0,1 in base; free piece appended
    const cross = compileCrossSeams(doc, n, offsets, 2);
    expect(cross.length).toBeGreaterThan(0);
    for (const c of cross) {
      expect(c.i).toBeLessThan(baseCount); // the base (front) side stays in the base range
      expect(c.j).toBeGreaterThanOrEqual(baseCount); // the free piece is appended after the base
    }
  });

  it('compileCrossSeams sews BOTH faces: each drawn pair has a back-panel twin', () => {
    const n = 32;
    const panelSize = n * n;
    const doc = defaultDraft(n);
    doc.pieces = [square()];
    doc.seams = [{ a: { face: 'front', from: 5, to: 6 }, b: { pieceId: 2, from: 0, to: 1 } }];
    const baseCount = 2 * panelSize;
    const offsets = [0, panelSize, baseCount];
    const cross = compileCrossSeams(doc, n, offsets, 2);
    expect(cross.length).toBeGreaterThan(0);
    expect(cross.length % 2).toBe(0); // pairs come in front/back twins
    for (let k = 0; k < cross.length; k += 2) {
      const front = cross[k]!;
      const back = cross[k + 1]!;
      expect(front.i).toBeLessThan(panelSize); // drawn on the body's FRONT panel
      expect(back.i).toBe(front.i + panelSize); // twin lands on the body's BACK panel
      expect(back.j).toBe(front.j + panelSize); // …and on the piece's own back panel
    }
  });

  it('a seam drawn on the BACK face mirrors onto the FRONT panel', () => {
    const n = 32;
    const panelSize = n * n;
    const doc = defaultDraft(n);
    doc.pieces = [square()];
    doc.seams = [{ a: { face: 'back', from: 5, to: 6 }, b: { pieceId: 2, from: 0, to: 1 } }];
    const offsets = [0, panelSize, 2 * panelSize];
    const cross = compileCrossSeams(doc, n, offsets, 2);
    expect(cross.length).toBeGreaterThan(0);
    for (let k = 0; k < cross.length; k += 2) {
      const drawn = cross[k]!;
      const twin = cross[k + 1]!;
      expect(drawn.i).toBeGreaterThanOrEqual(panelSize); // drawn on the BACK panel
      expect(twin.i).toBe(drawn.i - panelSize); // twin on the FRONT panel
      expect(twin.j).toBe(drawn.j + panelSize); // piece side still mirrors up
    }
  });

  it('a piece sewn onto a WELDED base run still pins panel-to-panel (the v104 lesson)', () => {
    // The proven armholeCrossSeams pins sleeve.front↔body.front AND
    // sleeve.back↔body.BACK (i = p·n² + local): the four rims converge
    // TRANSITIVELY through the body's own front↔back seam. Pinning the
    // piece's back panel to the body's FRONT cell instead (a "direct cinch"
    // variant) yanks the tube over the shoulder and ejects the arm — so a
    // welded run must behave exactly like any other run: opposite panels.
    const n = 32;
    const panelSize = n * n;
    const doc = defaultDraft(n);
    doc.pieces = [square()];
    doc.seams = [
      // The body edge 5→6 is itself sewn front↔back (a welded side-like line)…
      { a: { face: 'front', from: 5, to: 6 }, b: { face: 'back', from: 5, to: 6 } },
      // …and the piece is sewn onto that same run.
      { a: { face: 'front', from: 5, to: 6 }, b: { pieceId: 2, from: 0, to: 1 } },
    ];
    const cross = compileCrossSeams(doc, n, [0, panelSize, 2 * panelSize], 2);
    expect(cross.length).toBeGreaterThan(0);
    expect(cross.length % 2).toBe(0);
    for (let k = 0; k < cross.length; k += 2) {
      const front = cross[k]!;
      const twin = cross[k + 1]!;
      expect(front.i).toBeLessThan(panelSize); // drawn pair on the front panels
      expect(twin.i).toBe(front.i + panelSize); // twin on the body's BACK panel…
      expect(twin.j).toBe(front.j + panelSize); // …and the piece's back panel
    }
  });

  it('the twin is dropped when the back mask leaves the mirrored cell INTERIOR', () => {
    // Front has a deep neckline scoop; the back is a plain quad whose top edge
    // sits at v=0 — every front scoop-rim cell is alive but INTERIOR in the
    // back mask, so sewing a piece to the front neckline must emit NO back
    // twin (a seam into mid-fabric would pinch a permanent tuft).
    const n = 32;
    const panelSize = n * n;
    const doc = defaultDraft(n);
    doc.back = {
      outline: [
        [0.2, 0.0],
        [0.8, 0.0],
        [0.9, 0.97],
        [0.1, 0.97],
      ],
      darts: [],
      seams: [],
      openEdges: [],
      width: 0.95,
      height: 1.1,
      topY: 1.6,
      gap: 1.0,
    };
    doc.pieces = [square()];
    // Front neckline run (vertices 1→3, the scoop) sewn to the piece's top edge.
    doc.seams = [{ a: { face: 'front', from: 1, to: 3 }, b: { pieceId: 2, from: 0, to: 1 } }];
    const cross = compileCrossSeams(doc, n, [0, panelSize, 2 * panelSize], 2);
    expect(cross.length).toBeGreaterThan(0); // the drawn (front) pairs are all there
    expect(cross.every((c) => c.i < panelSize)).toBe(true); // …but no twin landed mid-fabric on the back panel
  });

  it('crossSewnOpenCells lists the piece cells of a cross-sewn run (a sewn edge is no rim)', () => {
    const n = 32;
    const doc = defaultDraft(n);
    doc.pieces = [square()];
    doc.seams = [{ a: { face: 'front', from: 5, to: 6 }, b: { pieceId: 2, from: 0, to: 1 } }];
    const cells = crossSewnOpenCells(doc, 2, n);
    expect(cells.length).toBeGreaterThan(0);
    // The sewn run is the square's TOP edge (v≈0.2): every cell sits in that band.
    for (const c of cells) expect(Math.floor(c / n) / (n - 1)).toBeLessThan(0.3);
    expect(crossSewnOpenCells(doc, 3, n)).toEqual([]); // absent piece → nothing
  });

  it('compileCrossSeams returns nothing for a non-entering / absent piece', () => {
    const n = 32;
    const doc = defaultDraft(n);
    doc.pieces = [square()];
    doc.seams = [{ a: { face: 'front', from: 5, to: 6 }, b: { pieceId: 2, from: 0, to: 1 } }];
    const offsets = [0, n * n, 2 * n * n];
    expect(compileCrossSeams(doc, n, offsets, 3).length).toBe(0); // piece 3 isn't the entering piece
    expect(compileCrossSeams(defaultDraft(n), n, offsets, 2).length).toBe(0); // no free-piece seams at all
  });

  it('reindexAssemblySeams shifts a numeric pieceId run and preserves its identity', () => {
    const seams = [{ a: { pieceId: 2, from: 3, to: 4 }, b: { face: 'front' as const, from: 0, to: 1 } }];
    const out = reindexAssemblySeams(seams, 2, 'insert', 1, 8);
    expect(out[0]!.a).toEqual({ pieceId: 2, from: 4, to: 5 }); // free-piece run followed its edge
    expect(out[0]!.b).toEqual({ face: 'front', from: 0, to: 1 }); // the base endpoint is untouched
  });

  it('sanitizeDraft parses free pieces and drops seams to missing pieces', () => {
    const s = sanitizeDraft({
      format: 'toile-draft',
      version: 1,
      gridN: 32,
      piece: { outline: [[0.2, 0.1], [0.8, 0.1], [0.5, 0.9]], darts: [], seams: [], openEdges: [], width: 0.9, height: 1, topY: 1.5, gap: 1 },
      pieces: [square()],
      seams: [
        { a: { pieceId: 2, from: 0, to: 1 }, b: { face: 'front', from: 0, to: 1 } }, // valid
        { a: { pieceId: 5, from: 0, to: 1 }, b: { face: 'front', from: 0, to: 1 } }, // ghost: no piece 5
      ],
    });
    expect(s.pieces?.length).toBe(1);
    expect(s.seams?.length).toBe(1); // ghost seam dropped
    expect(pieceIdOf(s.seams![0]!.a)).toBe(2);
    expect(s.pieces![0]!.gap).toBe(0.12); // a thin free piece round-trips (not clamped to 0.3)
  });

  it('sanitizeDraft remaps free-piece pieceIds when a middle piece is dropped', () => {
    const degenerate = { outline: [[0.2, 0.2], [0.8, 0.2]], darts: [], seams: [], openEdges: [], width: 0.5, height: 0.5, topY: 1.2, gap: 0.12 };
    const s = sanitizeDraft({
      format: 'toile-draft',
      version: 1,
      gridN: 32,
      piece: { outline: [[0.2, 0.1], [0.8, 0.1], [0.5, 0.9]], darts: [], seams: [], openEdges: [], width: 0.9, height: 1, topY: 1.5, gap: 1 },
      pieces: [degenerate, square()], // slot 0 (<3 pts) dropped; slot 1 (old pieceId 3) survives → new pieceId 2
      seams: [
        { a: { pieceId: 3, from: 0, to: 1 }, b: { face: 'front', from: 0, to: 1 } }, // targets the survivor
        { a: { pieceId: 2, from: 0, to: 1 }, b: { face: 'front', from: 0, to: 1 } }, // targets the dropped piece
      ],
    });
    expect(s.pieces?.length).toBe(1); // only the valid square survived
    expect(s.seams?.length).toBe(1); // the seam to the dropped piece is removed
    expect(pieceIdOf(s.seams![0]!.a)).toBe(2); // the survivor's seam re-pointed 3 → 2
  });

  it('sanitizeDraft keeps a free piece\'s sleeve mode (wrap) and its true small size', () => {
    const doc = defaultDraft(32);
    doc.pieces = [{ ...square(), width: 0.16, height: 0.42, gap: 0.18, wrap: 'armL' }];
    const round = sanitizeDraft(JSON.parse(JSON.stringify(doc)));
    expect(round.pieces![0]!.wrap).toBe('armL');
    expect(round.pieces![0]!.width).toBeCloseTo(0.16); // free pieces keep sizes below the body floor (0.3)
    expect(round.pieces![0]!.gap).toBeCloseTo(0.18);
    // A bogus wrap value is dropped, not passed through.
    doc.pieces = [{ ...square(), wrap: 'tête' as 'armL' }];
    expect(sanitizeDraft(JSON.parse(JSON.stringify(doc))).pieces![0]!.wrap).toBeUndefined();
    // The BODY keeps its 0.3 floor (a garment can't shrink to doll size by typo).
    const tiny = defaultDraft(32);
    tiny.piece.width = 0.05;
    expect(sanitizeDraft(JSON.parse(JSON.stringify(tiny))).piece.width).toBeCloseTo(0.3);
  });

  it('sanitizeDraft omits `pieces` when there are none (back-compat invariant)', () => {
    const s = sanitizeDraft(defaultDraft(32));
    expect('pieces' in s).toBe(false);
  });

  it('tshirtDraft: valid torso body, pre-sewn shoulders+sides, single connected island', () => {
    const doc = tshirtDraft(0.7, 0.62, 0.9, 1.52, 32);
    expect(isSelfIntersecting(doc.piece.outline)).toBe(false);
    expect(doc.manual).toBe(true);
    expect(doc.seams!.length).toBe(2); // left shoulder+side, right shoulder+side
    // Pre-sewn seams pair front↔back → cross-panel cell pairs (front panel 0, back panel 1).
    const cross = compileAssembly(doc, 32);
    expect(cross.length).toBeGreaterThan(0);
    const ps = 32 * 32;
    for (const s of cross) {
      expect(s.i).toBeLessThan(ps);
      expect(s.j).toBeGreaterThanOrEqual(ps);
    }
    // The torso outline rasterises to ONE connected piece — never a fragment.
    const n = 32;
    const kept: boolean[] = [];
    for (let v = 0; v < n; v++)
      for (let u = 0; u < n; u++) kept.push(pointInPolygon([u / (n - 1), v / (n - 1)], doc.piece.outline));
    expect(countMaskIslands(kept, n)).toBe(1);
  });

  it('removeFreePiece drops the piece, drops its seams, and shifts pieces above it', () => {
    const pieces = [square(), square()]; // pieceId 2 and 3
    const seams = [
      { a: { pieceId: 2, from: 0, to: 1 }, b: { face: 'front' as const, from: 0, to: 1 } }, // touches removed → dropped
      { a: { pieceId: 3, from: 0, to: 1 }, b: { face: 'front' as const, from: 0, to: 1 } }, // survives → shifts 3→2
      { a: { face: 'front' as const, from: 0, to: 1 }, b: { face: 'back' as const, from: 0, to: 1 } }, // base → untouched
    ];
    const out = removeFreePiece(pieces, seams, 2);
    expect(out.pieces.length).toBe(1);
    expect(out.seams.length).toBe(2); // the seam touching piece 2 is dropped
    expect(pieceIdOf(out.seams[0]!.a)).toBe(2); // former piece 3 re-pointed to 2
    expect(out.seams[1]!.a).toEqual({ face: 'front', from: 0, to: 1 }); // base run untouched
    expect(out.seams[1]!.b).toEqual({ face: 'back', from: 0, to: 1 });
  });

  it('removeFreePiece leaves pieces below the removed one unchanged', () => {
    const pieces = [square(), square()]; // 2, 3
    const seams = [{ a: { pieceId: 2, from: 0, to: 1 }, b: { face: 'front' as const, from: 0, to: 1 } }];
    const out = removeFreePiece(pieces, seams, 3); // remove the higher piece
    expect(out.pieces.length).toBe(1);
    expect(out.seams.length).toBe(1); // seam to piece 2 doesn't touch 3 → survives
    expect(pieceIdOf(out.seams[0]!.a)).toBe(2); // 2 < 3 → unchanged
  });
});
