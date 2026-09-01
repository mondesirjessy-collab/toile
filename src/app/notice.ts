/**
 * Notice de montage (v296) — la gamme d'assemblage du vêtement courant.
 *
 * Deux étages, comme tout le Studio IA :
 * - `buildNoticeReport` (PUR) extrait les FAITS du DraftDoc : pièces réelles,
 *   coutures d'assemblage avec leurs longueurs MESURÉES, pinces, zips.
 * - la rédaction : Claude via le proxy (`toile-notice`) quand il est là,
 *   sinon `fallbackNotice` — une gamme standard déterministe, sans IA.
 * Dans les deux cas le document imprimé porte le même avertissement : la
 * gamme est INDICATIVE, personne n'a cousu ce vêtement.
 */

import {
  assemblySeamIsClosed,
  pieceIdOf,
  type DraftDoc,
  type DraftPiece,
  type FaceRun,
} from '../engine/pattern/Draft';
import { NOTICE_MAX_ETAPES, type NoticeResult, type NoticeStep } from './brief/NoticeContract';

function roleLabel(p: DraftPiece, fallback: string): string {
  const r = p.placement?.role ?? p.wrap;
  if (r === 'armL') return 'Manche gauche';
  if (r === 'armR') return 'Manche droite';
  if (r === 'neck') return 'Col';
  if (r === 'front') return 'Devant';
  if (r === 'back') return 'Dos';
  return p.name ?? fallback;
}

/** Longueur (m) du chemin de contour `from → to` (circulaire, sens direct). */
function runLengthM(piece: DraftPiece, run: FaceRun): number {
  const n = piece.outline.length;
  if (n < 2) return 0;
  const from = ((run.from % n) + n) % n;
  const to = ((run.to % n) + n) % n;
  let len = 0;
  for (let i = from; i !== to; i = (i + 1) % n) {
    const a = piece.outline[i]!;
    const b = piece.outline[(i + 1) % n]!;
    len += Math.hypot((b[0] - a[0]) * piece.width, (b[1] - a[1]) * piece.height);
  }
  return len;
}

export interface NoticeReportInput {
  garment: string;
  size: string;
  fabric: string;
  seamAllowanceCm: number;
}

/** Les FAITS du patron, prêts à rédiger (envoyés tels quels au proxy). */
export function buildNoticeReport(draft: DraftDoc, input: NoticeReportInput): Record<string, unknown> {
  // Devant/Dos FORCÉS pour les 2 faces de base (comme la fiche de production) :
  // les noms techniques des générateurs (« frontSideDart ») restent en interne.
  const all: Array<{ piece: DraftPiece; nom: string }> = [{ piece: draft.piece, nom: 'Devant' }];
  if (draft.back && draft.back.outline.length >= 3) all.push({ piece: draft.back, nom: 'Dos' });
  for (const [i, p] of (draft.pieces ?? []).entries()) all.push({ piece: p, nom: roleLabel(p, `Pièce ${i + 3}`) });
  const nameOf = (id: number): string => all[id]?.nom ?? `Pièce ${id + 1}`;

  const r1 = (v: number): number => Math.round(v * 10) / 10;
  const pieces = all.map(({ piece, nom }) => ({
    nom,
    largeur_cm: r1(piece.width * 100),
    hauteur_cm: r1(piece.height * 100),
    pinces: piece.darts.map((d) => ({
      bouche_cm: r1(Math.hypot((d.legA[0] - d.legB[0]) * piece.width, (d.legA[1] - d.legB[1]) * piece.height) * 100),
    })),
  }));

  const coutures = (draft.seams ?? []).map((seam) => {
    const idA = pieceIdOf(seam.a);
    const idB = pieceIdOf(seam.b);
    const pieceA = all[idA]?.piece;
    const pieceB = all[idB]?.piece;
    return {
      de: nameOf(idA),
      vers: nameOf(idB),
      longueur_cm: r1(((pieceA ? runLengthM(pieceA, seam.a) : 0) + (pieceB ? runLengthM(pieceB, seam.b) : 0)) / 2 * 100),
      type: seam.kind === 'zipper' ? 'zip' : 'couture',
      fermee: assemblySeamIsClosed(seam),
    };
  });

  return {
    vetement: { type: input.garment, taille: input.size, tissu: input.fabric },
    marge_couture_cm: input.seamAllowanceCm,
    pieces,
    coutures,
    assemblage_auto: !draft.manual && coutures.length === 0 ? 'périmètre devant/dos cousu automatiquement' : undefined,
  };
}

/**
 * Gamme STANDARD sans IA (repli déterministe) : coupe → pinces → assemblage
 * dans l'ordre des coutures du patron → zips → finitions. Les longueurs
 * citées sont les vraies. Volontairement sobre : l'ordre fin d'un montage
 * industriel relève d'un·e professionnel·le — et la notice le dit.
 */
export function fallbackNotice(report: Record<string, unknown>): NoticeResult {
  const vetement = report.vetement as { type: string; taille: string; tissu: string };
  const marge = report.marge_couture_cm as number;
  const pieces = report.pieces as Array<{ nom: string; pinces: Array<{ bouche_cm: number }> }>;
  const coutures = report.coutures as Array<{ de: string; vers: string; longueur_cm: number; type: string }>;
  const etapes: NoticeStep[] = [];
  const push = (titreFr: string, detailFr: string): void => {
    if (etapes.length < NOTICE_MAX_ETAPES) etapes.push({ n: etapes.length + 1, titreFr, detailFr });
  };
  push(
    'Coupe',
    `Couper les ${pieces.length} pièces (${pieces.map((p) => p.nom).join(', ')}) dans le ${vetement.tissu.toLowerCase()}, marge de couture ${String(marge).replace('.', ',')} cm incluse au trait de coupe du plan de découpe.`,
  );
  for (const piece of pieces) {
    if (!piece.pinces.length) continue;
    push(
      `Pinces — ${piece.nom}`,
      `Coudre ${piece.pinces.length} pince${piece.pinces.length > 1 ? 's' : ''} (bouche ${piece.pinces
        .map((d) => String(d.bouche_cm).replace('.', ','))
        .join(' / ')} cm), pointe effilée sans arrêt brutal, puis coucher au fer.`,
    );
  }
  for (const seam of coutures.filter((s) => s.type === 'couture')) {
    push(
      `Assembler ${seam.de} ↔ ${seam.vers}`,
      `Piquer endroit contre endroit sur ${String(seam.longueur_cm).replace('.', ',')} cm, crans en vis-à-vis, puis surfiler ou surjeter la marge.`,
    );
  }
  for (const seam of coutures.filter((s) => s.type === 'zip')) {
    push(
      `Zip ${seam.de} ↔ ${seam.vers}`,
      `Poser la fermeture à glissière sur ${String(seam.longueur_cm).replace('.', ',')} cm au pied ganseur, bords repliés au fer d'abord.`,
    );
  }
  if (!coutures.length) {
    push(
      'Assemblage',
      'Assembler devant et dos endroit contre endroit sur tout le périmètre cousu du patron (assemblage automatique du modèle), crans en vis-à-vis.',
    );
  }
  push('Finitions', 'Ourler le bas et les ouvertures restantes (encolure, emmanchures) selon le modèle, puis repasser l’ensemble.');
  return {
    intent: 'notice',
    titreFr: `Gamme de montage — ${vetement.type} (${vetement.taille}, ${vetement.tissu})`,
    etapes,
    conseilsFr: [
      'Notice STANDARD générée sans IA : ordre générique coupe → pinces → assemblage → finitions.',
      'Gamme indicative — à faire valider par un·e mécanicien·ne modèle avant toute production.',
    ],
  };
}

/** Page imprimable autonome (PURE : rend la chaîne HTML complète). */
export function renderNoticeHtml(
  notice: NoticeResult,
  report: Record<string, unknown>,
  provenance: string,
): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const vetement = report.vetement as { type: string; taille: string; tissu: string };
  const pieces = report.pieces as Array<{ nom: string; largeur_cm: number; hauteur_cm: number; pinces: unknown[] }>;
  const marge = String(report.marge_couture_cm).replace('.', ',');
  const cm = (v: number): string => String(v).replace('.', ',');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>${esc(notice.titreFr)}</title>
<style>
  body { font: 13px/1.55 system-ui, sans-serif; color: #1c1d22; margin: 32px auto; max-width: 720px; padding: 0 16px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .meta { color: #5a5d66; margin: 0 0 18px; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 18px; }
  th, td { border: 1px solid #d5d7dd; padding: 5px 8px; text-align: left; font-size: 12px; }
  th { background: #f2f3f6; }
  ol { padding-left: 22px; }
  li { margin: 0 0 10px; }
  li strong { display: block; }
  .conseils { background: #f6f4ec; border: 1px solid #e2ddc9; border-radius: 6px; padding: 10px 14px; margin-top: 16px; }
  .avert { margin-top: 18px; padding: 10px 14px; border: 1px solid #d9a89b; background: #faf0ec; border-radius: 6px; font-size: 12px; }
  .print { margin: 18px 0; }
  @media print { .print { display: none; } body { margin: 0; } }
</style></head><body>
<h1>🧵 ${esc(notice.titreFr)}</h1>
<p class="meta">TOILE — ${esc(vetement.type)} · taille ${esc(vetement.taille)} · ${esc(vetement.tissu)} · marge ${marge} cm · ${esc(provenance)}</p>
<button class="print" onclick="window.print()">🖨 Imprimer</button>
<table><thead><tr><th>Pièce</th><th>Encombrement</th><th>Pinces</th></tr></thead><tbody>
${pieces.map((p) => `<tr><td>${esc(p.nom)}</td><td>${cm(p.largeur_cm)} × ${cm(p.hauteur_cm)} cm</td><td>${p.pinces.length || '—'}</td></tr>`).join('\n')}
</tbody></table>
<ol>
${notice.etapes.map((e) => `<li><strong>${esc(e.titreFr)}</strong>${esc(e.detailFr)}</li>`).join('\n')}
</ol>
${notice.conseilsFr.length ? `<div class="conseils">${notice.conseilsFr.map((c) => `<div>· ${esc(c)}</div>`).join('\n')}</div>` : ''}
<div class="avert">⚠️ Gamme générée automatiquement depuis le patron (pièces, coutures et longueurs réelles) — INDICATIVE : l'ordre fin et les réglages machine doivent être validés par un·e mécanicien·ne modèle avant production.</div>
</body></html>`;
}
