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
      'at-sim',
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
    expect(html).toContain('corps et ses collisions');
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
