import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const countId = (id: string): number =>
  [...html.matchAll(new RegExp(`\\bid="${id}"`, 'g'))].length;

describe('atelier workspace markup', () => {
  it('keeps every behaviour hook unique after the visual reorganisation', () => {
    const requiredIds = [
      'atelier-bar',
      'patternBox',
      'pattern',
      'place-chooser',
      'placement-status',
      'placement-status-message',
      'at-sim-without-piece',
      'split-divider',
      'at-tshirt',
      'at-pants',
      'at-hoodie',
      'at-size',
      'at-avatar-stature',
      'at-avatar-stature-num',
      'at-avatar-stature-help',
      'at-frame-avatar',
      'at-piece',
      'at-length',
      'at-snap',
      'at-cut',
      'at-gather',
      'gather-chooser',
      'at-offset',
      'at-mirror',
      'offset-chooser',
      'offset-target-label',
      'offset-cancel',
      'at-sleeves',
      'at-pen',
      'at-link',
      'at-sew',
      'at-sew-free',
      'at-zipper',
      'at-place',
      'at-fabric',
      'at-gsm',
      'at-gsm-reset',
      'at-gsm-help',
      'at-gsm-explanation',
      'at-color',
      'at-color-reset',
      'at-color-help',
      'at-graphic-add',
      'at-graphic-remove',
      'at-graphic-file',
      'at-graphic-help',
      'at-motif',
      'motif-chooser',
      'motif-image',
      'motif-cancel',
      'at-reverse',
      'at-move3d',
      'at-arrange',
      'at-reset3d',
      'at-del',
      'at-undo',
      'at-reset2d',
      'at-zoom-out',
      'at-zoom-reset',
      'at-zoom-in',
      'at-particles',
      'at-particles-help',
      'at-big',
      'at-advanced',
      'at-help',
      'at-help-close',
      'at-sim',
      'atelier-cheatsheet',
      'atelier-empty-state',
      'atelier-empty-state-title',
      'at-empty-tshirt',
      'at-empty-piece',
      'at-empty-femme',
      'at-empty-homme',
    ];

    for (const id of requiredIds) expect(countId(id), id).toBe(1);
  });

  it('exposes stable accessible controls and visible workflow groups', () => {
    expect(html).toMatch(
      /<select id="at-size" aria-label="Taille du patron actif"/,
    );
    expect(html).toMatch(
      /<select id="at-fabric" aria-label="Tissu de la sélection"/,
    );
    expect(html).toContain(
      '<option value="__global__">🧵 Tissu global — Jersey</option>',
    );
    expect(html).toMatch(
      /<select id="at-particles" aria-label="Distance entre particules du maillage d’essayage"/,
    );
    expect(html).toContain('Distance entre particules');
    const particleValues = [
      ...html.matchAll(/<select id="at-particles"[^>]*>([\s\S]*?)<\/select>/g),
    ][0]?.[1] ?? '';
    expect([...particleValues.matchAll(/<option value="(\d+)"/g)].map((m) => m[1])).toEqual([
      '32',
      '64',
      '128',
    ]);
    expect(particleValues).toContain('mm');
    expect(html).not.toMatch(/<option value="">/);
    expect(html).toMatch(/<label class="field-label" for="at-gsm">Grammage \(GSM\)<\/label>/);
    expect(html).toContain('inputmode="decimal"');
    expect(html).toContain('aria-describedby="at-gsm-help at-gsm-explanation"');
    expect(html).toMatch(/<small id="at-gsm-help" role="status" aria-live="polite">/);
    expect(html).toContain('Le GSM ajuste la masse et l’inertie');
    expect(html).toMatch(/<input id="at-color" type="color"[^>]*aria-label="Couleur de l’empiècement sélectionné"/);
    expect(html).toContain('Couleur de la pièce');
    expect(html).toContain('Le tissu décide de la couleur.');
    expect(html).toContain('Graphique de la pièce');
    expect(html).toMatch(/<input id="at-graphic-file" type="file" accept="image\/png,image\/jpeg" hidden/);
    expect(html).toContain('🖼 Poser un graphique');
    expect(html).toContain('▦ Poser un motif');
    const motifKinds = [...html.matchAll(/<button data-motif="([^"]+)"/g)].map((m) => m[1]);
    expect(motifKinds).toEqual(['rayures', 'vichy', 'pois', 'damier']);
    expect(html).toContain('⇱ Décaler le contour');
    const offsetValues = [
      ...html.matchAll(/<button data-offset-cm="([^"]+)"/g),
    ].map((m) => m[1]);
    expect(offsetValues).toEqual(['-1', '-0.5', '0.5', '1', '2']);
    expect(html).toMatch(
      /<input id="at-avatar-stature" type="range" min="140" max="210" step="1"/,
    );
    expect(html).toMatch(
      /<label class="avatar-size-label" for="at-avatar-stature">/,
    );
    expect(html).toMatch(
      /<input id="at-avatar-stature-num"[^>]+type="number"/,
    );
    expect(html).toContain('aria-describedby="at-avatar-stature-help"');
    expect(html).toMatch(/<canvas id="pattern"/);
    expect(html).toContain('Taille globale');
    expect(html).toContain('Taille du vêtement');
    expect(html).toContain('Le vêtement garde sa taille choisie');
    expect(html).toContain('« Taille du vêtement » pour le regrader');
    expect(html).not.toContain('Les patrons automatiques sont regradés');
    expect(html).toContain('⊙ Cadrer la vue');
    expect(html).toContain('Choisir le patron');
    expect(html).toContain('Dessiner et ajuster');
    expect(html).toContain('Assembler');
    expect(html).toContain('Pièce active');
    expect(html).toContain('Essayer en 3D');
    expect(html).toMatch(
      /<button id="at-sim-without-piece" type="button" hidden>Simuler sans cette pièce<\/button>/,
    );
    expect(html).toContain('Revenir au patron');
    expect(html).toContain('◎ Placement');
    expect(html).toMatch(/id="at-piece"[^>]+aria-pressed="false"/);
    expect(html).toMatch(/id="at-place"[^>]+aria-pressed="false"/);
    expect(html).toContain('⌖ Annuler le déplacement manuel');
    expect(html).toContain('La position du dessin n’influence pas l’essayage');
    expect(html).toContain('Automatique par les coutures (recommandé)');
    expect(html).toContain('Les gestes essentiels');
    expect(html).toContain('Échap</dt><dd>Annuler le geste ou désarmer');
    expect(html).toContain('Commencez votre patron');
    expect(html).toContain(
      'aria-label="Afficher l’aide des gestes et raccourcis"',
    );
    expect(html).toContain(
      '<canvas id="view" tabindex="-1" aria-label="Vue 3D du vêtement et du mannequin">',
    );
    expect(html).toMatch(
      /id="atelier-empty-state"[^>]+aria-labelledby="atelier-empty-state-title"[^>]+aria-live="polite"/,
    );
    expect(html).toContain(
      '<h2 id="atelier-empty-state-title">Commencez votre patron</h2>',
    );
    expect(html).toContain(
      '<button id="at-empty-tshirt" type="button">Choisir un modèle</button>',
    );
    expect(html).toContain(
      '<button id="at-empty-piece" type="button">✎ Tracer une pièce</button>',
    );
    expect(html).toContain('Votre mannequin');
    expect(html).toMatch(/<button id="at-empty-femme"[^>]+aria-pressed="true"/);
    expect(html).toMatch(/<button id="at-empty-homme"[^>]+aria-pressed="false"/);
    expect(html).toContain('aria-label="Premier T-shirt en six étapes"');
    expect(html).toContain(
      'tracez votre première pièce dans le plan 2D, puis choisissez son placement sur le mannequin',
    );
    const firstTshirtFlow = html.match(
      /<ol class="cheatsheet-flow"[^>]*>([\s\S]*?)<\/ol>/,
    )?.[1];
    expect(firstTshirtFlow).toBeDefined();
    expect(firstTshirtFlow?.match(/<li>/g)).toHaveLength(6);
    expect(firstTshirtFlow).toContain('2 · Essayer');
    expect(firstTshirtFlow).toContain('4 · Longueur');
    expect(firstTshirtFlow).toContain('6 · Exporter');
    expect(firstTshirtFlow).not.toContain('Coudre');
    expect(html).toMatch(
      /\.cheatsheet-flow\s*\{[\s\S]{0,160}grid-template-columns:\s*repeat\(3,/,
    );
    expect(html).toContain(
      '--toile-toast-bottom: calc(var(--atelier-status-h) + 12px)',
    );
    expect(html).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.cheatsheet-flow\s*\{\s*grid-template-columns:\s*repeat\(2,/,
    );
    expect(html).toMatch(
      /@media \(max-width: 520px\)[\s\S]*\.cheatsheet-flow,[\s\S]*\.empty-state-actions\s*\{\s*grid-template-columns:\s*1fr;/,
    );
    expect(html).toContain('data-first-tip');
    expect(html).toContain(
      '<dt>Point + glisser</dt><dd>Déplacer un sommet du patron',
    );
    expect(html).toContain(
      '<dt>R</dt><dd>Réinitialiser le tissu dans sa pose de départ.</dd>',
    );
    expect(html).toContain('#view.piece-hover { cursor: grab; }');
  });

  it('keeps the scrollable tools separate from the non-overlapping footer', () => {
    expect(html).toMatch(
      /<div class="atelier-rail-scroll">[\s\S]*<section class="selection-card"[\s\S]*<\/section>\s*<\/div>\s*<div class="atelier-rail-footer">/,
    );
    expect(html).toMatch(
      /\.atelier-rail-scroll\s*\{[\s\S]*overflow-y:\s*auto;/,
    );
    expect(html).toMatch(
      /\.atelier-rail-footer\s*\{[\s\S]*position:\s*static;/,
    );
    expect(html).not.toMatch(
      /\.atelier-rail-footer\s*\{[\s\S]{0,160}position:\s*sticky;/,
    );
  });

  it('exposes the OBJ body import control (v185)', () => {
    expect(countId('at-import-body')).toBe(1);
    expect(countId('at-import-body-file')).toBe(1);
    expect(html).toMatch(/<input id="at-import-body-file"[^>]*type="file"[^>]*accept="[^"]*\.obj/);
    expect(html).toContain('<dt>⬆ Importer un corps</dt>');
    expect(html).toContain('du brief au patron · v193');
  });

  it('exposes the jupe archetype button (v193)', () => {
    expect(countId('at-jupe')).toBe(1);
    expect(html).toMatch(/<button id="at-jupe"[^>]*>. Jupe<\/button>/);
  });

  it('exposes the essayage pose selector (v189)', () => {
    expect(countId('at-pose-native')).toBe(1);
    expect(countId('at-pose-apose')).toBe(1);
    expect(countId('at-pose-debout')).toBe(1);
    expect(html).toMatch(/<button id="at-pose-apose"[^>]*data-pose="a-pose"/);
    expect(html).toMatch(/<button id="at-pose-debout"[^>]*data-pose="debout"/);
  });

  it('exposes editable numeric measurement fields (v184)', () => {
    for (const id of ['at-avatar-stature-num', 'at-m-poitrine-num', 'at-m-taille-num', 'at-m-hanches-num', 'at-m-carrure-num', 'at-m-cuisse-num']) {
      expect(countId(id)).toBe(1);
      expect(html).toMatch(new RegExp(`<input id="${id}"[^>]*type="number"`));
    }
    expect(html).not.toContain('id="at-m-poitrine-val"');
  });

  it('exposes named mannequin gabarits and silhouettes (v183)', () => {
    expect(countId('at-gab-femme')).toBe(1);
    expect(countId('at-gab-homme')).toBe(1);
    expect([...html.matchAll(/class="avatar-silhouette"/g)].length).toBe(3);
    expect(html).toContain('data-sil="menue"');
    expect(html).toContain('data-sil="ronde"');
    expect(html).toContain('data-sil="athletique"');
    expect(html).toContain('<dt>Gabarit &amp; silhouette</dt>');
  });

  it('exposes the atelier measurement sliders (v182) under the mannequin card', () => {
    for (const id of ['at-m-poitrine', 'at-m-taille', 'at-m-hanches', 'at-m-carrure', 'at-m-cuisse']) {
      expect(countId(id)).toBe(1);
    }
    expect(html).toContain('id="at-measures"');
    expect(html).toContain('id="at-measures-reset"');
    expect(html).toContain('↕ Mensurations (cm)');
    expect(html).toContain('<dt>↕ Mensurations (cm)</dt>');
  });

  it('exposes the 3D seam toggle (v181) in the view tools and cheat-sheet', () => {
    expect(html).toMatch(/<button id="at-seams3d"[^>]*aria-pressed="true"/);
    expect(html).toContain('🪡 Coutures');
    expect(html).toContain('<dt>🪡 Coutures en 3D</dt>');
  });

  it('teaches the measured-edge tap (v180) in the cheat-sheet', () => {
    expect(html).toContain('<dt>Clic sec sur un bord</dt>');
  });

  it('exposes the paper plan theme toggle (v179) in the plan header and cheat-sheet', () => {
    expect(html).toMatch(/<button id="at-plan-theme"[^>]*aria-pressed="false"/);
    expect(html).toContain('◐ Papier');
    expect(html).toContain('<dt>◐ Papier</dt>');
  });

  it('exposes the Clo layout toggle (v178) in the plan header and cheat-sheet', () => {
    expect(html).toMatch(/<button id="at-layout-clo"[^>]*aria-pressed="false"/);
    expect(html).toContain('⇄ 3D à gauche');
    expect(html).toContain('body.layout-3d-left #patternBox.big');
    expect(html).toContain('<dt>⇄ 3D à gauche</dt>');
  });

  it('teaches the click piece selection (v177) in rail, canvas title and cheat-sheet', () => {
    expect(html).toContain('Un clic sur une pièce la sélectionne (gauche ou droit)');
    expect(html).toContain('<dt>Clic sur une pièce</dt>');
    expect(html).toContain('un clic (gauche ou droit) : sélectionner une pièce');
    expect(html).not.toContain('Clic droit sur une pièce pour la sélectionner');
  });

  it('exposes the Clo keyboard palette (v176) in the cheat-sheet', () => {
    expect(html).toContain('Si tu viens de Clo');
    expect(html).toContain('<dt>Espace</dt>');
    expect(html).toContain('<dt>B ou N</dt>');
    expect(html).toContain('<dt>A ou Z</dt>');
  });

  it('exposes the ⌖ precision bench (v175) with its choosers and cheat-sheet entry', () => {
    expect(html).toMatch(/<button id="at-precision"[^>]*title="[^"]*ÉTABLI DE PRÉCISION[^"]*"/);
    expect(html).toContain('<dt>⌖ Précision</dt>');
    expect(html).toContain('id="precision-corner-chooser"');
    expect(html).toContain('id="precision-axis-chooser"');
    expect(html).toContain('id="divide-chooser"');
  });

  it('exposes the ⛓ linked-editing button (v174) with its cheat-sheet entry', () => {
    expect(html).toMatch(/<button id="at-linkedit"[^>]*title="[^"]*ÉDITION LIÉE[^"]*"/);
    expect(html).toContain('<dt>⛓ Édition liée</dt>');
  });

  it('exposes the ⌾ hole button (v173) with its cheat-sheet entry', () => {
    expect(html).toMatch(/<button id="at-hole"[^>]*title="[^"]*ÉVIDER[^"]*"/);
    expect(html).toContain('<dt>⌾ Évider</dt>');
  });

  it('exposes the ⧉ merge button (v172) with its cheat-sheet entry', () => {
    expect(html).toMatch(/<button id="at-merge"[^>]*title="[^"]*FUSIONNER[^"]*"/);
    expect(html).toContain('<dt>⧉ Fusionner</dt>');
  });

  it('exposes the ⛶ sketch-on-body button (v171) with its cheat-sheet entry', () => {
    expect(html).toMatch(/<button id="at-sketch3d"[^>]*title="[^"]*CROQUIS SUR LE CORPS[^"]*"/);
    expect(html).toContain('<dt>⛶ Croquis sur corps</dt>');
  });

  it('exposes the ⬦ edit-3D-outline button (v170) with its cheat-sheet entry', () => {
    expect(html).toMatch(/<button id="at-edit3d"[^>]*title="[^"]*CONTOUR EN 3D[^"]*"/);
    expect(html).toContain('<dt>⬦ Retoucher contour</dt>');
  });

  it('offers the split-now chooser after a 3D trace (v169)', () => {
    expect(html).toContain('<div id="draw3d-chooser" hidden>');
    expect(html).toContain('<button id="draw3d-split-now">');
    expect(html).toContain('<button id="draw3d-split-keep">');
    expect(html).toMatch(/<dt>✎ Dessiner sur tissu<\/dt><dd>[^<]*SCINDER dans la foulée/);
  });

  it('exposes the ✎3D draw-on-fabric button (v168) with its cheat-sheet entry', () => {
    expect(html).toMatch(/<button id="at-draw3d"[^>]*title="[^"]*SUR LE TISSU[^"]*"/);
    expect(html).toContain('<dt>✎ Dessiner sur tissu</dt>');
  });

  it('exposes the ⧢ fullness tool (v167) with chooser and cheat-sheet entry', () => {
    expect(html).toMatch(/<button id="at-fullness"[^>]*title="[^"]*couper-pivoter[^"]*"/);
    expect(html).toContain('<div id="fullness-chooser" hidden>');
    const cms = [...html.matchAll(/<button data-open-cm="([^"]+)"/g)].map((m) => m[1]);
    expect(cms).toEqual(['2', '4', '6', '8', '12']);
    expect(html).toContain('<dt>⧢ Évasement</dt>');
  });

  it('exposes the ⌵ notch tool (v166) with its cheat-sheet entry', () => {
    expect(html).toMatch(/<button id="at-notch"[^>]*title="[^"]*CRANS de montage[^"]*"/);
    expect(html).toContain('<dt>⌵ Crans</dt>');
  });

  it('documents splitting along an internal line (v165) in the cheat-sheet', () => {
    expect(html).toMatch(/<dt>▱ Ligne interne<\/dt><dd>[^<]*SCINDE la pièce le long de son tracé/);
  });

  it('exposes the ∿ curve-point tool (v164) with its cheat-sheet entry', () => {
    expect(html).toMatch(/<button id="at-curvepoint"[^>]*title="[^"]*POINT COURBE[^"]*"/);
    expect(html).toContain('<dt>∿ Point courbe</dt>');
  });

  it('exposes the ◆ fisheye-dart tool (v163) with its cheat-sheet entry', () => {
    expect(html).toMatch(/<button id="at-dart"[^>]*title="[^"]*LOSANGE[^"]*"/);
    expect(html).toContain('<dt>◆ Pince losange</dt>');
  });

  it('exposes the ▱ internal-line tool (v162) with its cheat-sheet entry', () => {
    expect(html).toMatch(/<button id="at-internal"[^>]*title="[^"]*LIGNES INTERNES[^"]*"/);
    expect(html).toContain('<dt>▱ Ligne interne</dt>');
  });

  it('exposes the ⋈ mirror-draw toggle (v161) with its cheat-sheet entry', () => {
    expect(html).toMatch(/<button id="at-mirror-draw"[^>]*aria-pressed="false"[^>]*title="[^"]*axe vertical[^"]*"/);
    expect(html).toContain('<dt>⋈ Miroir au tracé</dt>');
  });

  it('exposes the ⌒ fitted-sleeve button (v160) with its cheat-sheet entry', () => {
    expect(html).toMatch(/<button id="at-sleeve-fit"[^>]*title="[^"]*emmanchure[^"]*"/);
    expect(html).toContain('<dt>⌒ Manche adaptée</dt>');
  });

  it('documents the ✥ XYZ triad (v158) in tooltip and cheat-sheet', () => {
    expect(html).toMatch(
      /<button id="at-move3d"[^>]*title="[^"]*trièdre X·Y·Z[^"]*"/,
    );
    expect(html).toContain('<dt>Clic 3D = trièdre X·Y·Z</dt>');
    expect(html).toContain('centimètres en direct');
  });

  it('preserves every supported placement destination', () => {
    const destinations = [
      ...html.matchAll(/<button data-place="([^"]+)"/g),
    ].map((match) => match[1]);

    expect(destinations).toEqual([
      'auto',
      'front',
      'back',
      'armR',
      'armL',
      'neck',
      'waist',
      'legR',
      'legL',
      'pocket',
      'under',
      'free',
    ]);
  });
});
