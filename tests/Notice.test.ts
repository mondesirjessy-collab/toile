import { describe, expect, it, vi } from 'vitest';
import { validateNotice } from '../src/app/brief/NoticeContract';
import { buildNoticeReport, fallbackNotice, renderNoticeHtml } from '../src/app/notice';
import { handleStudioRequest, NOTICE_FEW_SHOT, extractJson, type ModelCaller } from '../server/brief-core';
import type { DraftDoc } from '../src/engine/pattern/Draft';

/** Petit patron 2 faces : carrés 50×60 cm, 2 coutures d'assemblage + 1 pince devant. */
const square = (darts = 0): DraftDoc['piece'] => ({
  outline: [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ],
  width: 0.5,
  height: 0.6,
  seams: [],
  darts: Array.from({ length: darts }, () => ({ apex: [0.5, 0.5], legA: [0.4, 1], legB: [0.6, 1] })),
});

const DRAFT: DraftDoc = {
  format: 'toile-draft',
  version: 1,
  gridN: 64,
  piece: square(1),
  back: square(),
  manual: true,
  seams: [
    { a: { face: 'front', from: 0, to: 1 }, b: { face: 'back', from: 0, to: 1 } },
    { a: { face: 'front', from: 2, to: 3 }, b: { face: 'back', from: 2, to: 3 }, kind: 'zipper', closed: true },
  ],
};

const INPUT = { garment: 'T-shirt', size: 'M', fabric: 'Jersey', seamAllowanceCm: 1 };

describe('notice de montage (v296)', () => {
  it('buildNoticeReport : pièces, pinces et coutures aux longueurs MESURÉES', () => {
    const report = buildNoticeReport(DRAFT, INPUT) as Record<string, unknown>;
    const pieces = report.pieces as Array<{ nom: string; pinces: Array<{ bouche_cm: number }> }>;
    expect(pieces.map((p) => p.nom)).toEqual(['Devant', 'Dos']);
    expect(pieces[0]!.pinces).toHaveLength(1);
    expect(pieces[0]!.pinces[0]!.bouche_cm).toBe(10); // 0,2 u × 50 cm
    const coutures = report.coutures as Array<{ longueur_cm: number; type: string }>;
    expect(coutures).toHaveLength(2);
    expect(coutures[0]!.longueur_cm).toBe(50); // bord bas : 1 u × 50 cm
    expect(coutures[0]!.type).toBe('couture');
    expect(coutures[1]!.type).toBe('zip');
  });

  it('fallbackNotice : gamme standard VALIDE le contrat, pinces avant assemblage, honnêteté affichée', () => {
    const report = buildNoticeReport(DRAFT, INPUT);
    const notice = fallbackNotice(report);
    expect(validateNotice(notice)).not.toBeNull();
    const titres = notice.etapes.map((e) => e.titreFr);
    expect(titres[0]).toBe('Coupe');
    const iPince = titres.findIndex((t) => t.startsWith('Pinces'));
    const iAssemblage = titres.findIndex((t) => t.startsWith('Assembler'));
    expect(iPince).toBeGreaterThan(-1);
    expect(iAssemblage).toBeGreaterThan(iPince);
    expect(titres.some((t) => t.startsWith('Zip'))).toBe(true);
    expect(notice.etapes.some((e) => e.detailFr.includes('50 cm'))).toBe(true);
    expect(notice.conseilsFr.join(' ')).toContain('sans IA');
  });

  it('validateNotice : borne les étapes, écarte le difforme', () => {
    expect(validateNotice(null)).toBeNull();
    expect(validateNotice({ intent: 'notice', titreFr: 'x', etapes: [] })).toBeNull();
    const v = validateNotice({
      intent: 'notice',
      titreFr: 't',
      etapes: [
        { titreFr: 'a', detailFr: 'b' },
        { titreFr: '', detailFr: 'sans titre : écartée' },
        { titreFr: 'c', detailFr: 'd'.repeat(2000) },
      ],
      conseilsFr: ['ok', 42, ''],
    });
    expect(v).not.toBeNull();
    expect(v!.etapes).toHaveLength(2);
    expect(v!.etapes[1]!.n).toBe(2); // renuméroté après l'écart
    expect(v!.etapes[1]!.detailFr.length).toBe(600);
    expect(v!.conseilsFr).toEqual(['ok']);
  });

  it('le few-shot serveur VALIDE le contrat, et le routeur sert toile-notice', async () => {
    for (const example of NOTICE_FEW_SHOT) {
      expect(validateNotice(extractJson(example.assistant)), example.user).not.toBeNull();
    }
    const model: ModelCaller = vi.fn(async () =>
      '{"intent":"notice","titreFr":"Gamme","etapes":[{"n":1,"titreFr":"Coupe","detailFr":"Couper."}],"conseilsFr":[]}');
    const out = await handleStudioRequest(
      { format: 'toile-notice', version: 1, report: buildNoticeReport(DRAFT, INPUT) },
      model,
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ intent: 'notice' });
  });

  it('renderNoticeHtml : imprimable, avertissement présent, HTML échappé', () => {
    const report = buildNoticeReport(DRAFT, INPUT);
    const notice = fallbackNotice(report);
    notice.etapes[0]!.titreFr = 'Coupe <script>alert(1)</script>';
    const html = renderNoticeHtml(notice, report, 'gamme standard (sans IA)');
    expect(html).toContain('window.print()');
    expect(html).toContain('INDICATIVE');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('50 × 60 cm');
  });
});
