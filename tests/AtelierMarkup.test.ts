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
      'at-avatar-stature-value',
      'at-avatar-stature-help',
      'at-frame-avatar',
      'at-piece',
      'at-length',
      'at-snap',
      'at-sleeves',
      'at-pen',
      'at-link',
      'at-sew',
      'at-zipper',
      'at-place',
      'at-fabric',
      'at-gsm',
      'at-gsm-reset',
      'at-gsm-help',
      'at-gsm-explanation',
      'at-reverse',
      'at-move3d',
      'at-reset3d',
      'at-del',
      'at-undo',
      'at-zoom-out',
      'at-zoom-reset',
      'at-zoom-in',
      'at-big',
      'at-advanced',
      'at-help',
      'at-help-close',
      'at-exit',
      'at-sim',
      'atelier-cheatsheet',
      'atelier-empty-state',
      'atelier-empty-state-title',
      'at-empty-tshirt',
      'at-empty-piece',
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
    expect(html).not.toMatch(/<option value="">/);
    expect(html).toMatch(/<label class="field-label" for="at-gsm">Grammage \(GSM\)<\/label>/);
    expect(html).toContain('inputmode="decimal"');
    expect(html).toContain('aria-describedby="at-gsm-help at-gsm-explanation"');
    expect(html).toMatch(/<small id="at-gsm-help" role="status" aria-live="polite">/);
    expect(html).toContain('Le GSM ajuste la masse et l’inertie');
    expect(html).toMatch(
      /<input id="at-avatar-stature" type="range" min="140" max="210" step="1"/,
    );
    expect(html).toMatch(
      /<label class="avatar-size-label" for="at-avatar-stature">/,
    );
    expect(html).toMatch(
      /<output id="at-avatar-stature-value"[^>]+for="at-avatar-stature"/,
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
    expect(html).toContain('⌖ Réinitialiser la pose');
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
    expect(html).toContain('data-first-tip=');
    expect(html).toContain('#view.piece-hover { cursor: move; }');
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
      'free',
    ]);
  });
});
