import { describe, expect, it } from 'vitest';
import {
  claimFirstUseTip,
  firstUseTipStorageKey,
  type FirstUseTipStorage,
} from '../src/app/FirstUseTip';

class MemoryStorage implements FirstUseTipStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('astuces au premier usage', () => {
  it('reprend le title existant et ne le montre qu’une fois', () => {
    const storage = new MemoryStorage();
    const seen = new Set<string>();
    const control = {
      id: 'at-length',
      title: 'Modifier un bord sans limite.',
    };

    expect(claimFirstUseTip(control, seen, storage)).toBe(control.title);
    expect(claimFirstUseTip(control, seen, storage)).toBeNull();
    expect(storage.getItem(firstUseTipStorageKey(control.id))).toBe('1');
  });

  it('reste acquittée après un rechargement représenté par un nouveau Set', () => {
    const storage = new MemoryStorage();
    const control = {
      id: 'at-sew',
      title: 'Coudre deux bords.',
    };

    expect(claimFirstUseTip(control, new Set(), storage)).toBe(control.title);
    expect(claimFirstUseTip(control, new Set(), storage)).toBeNull();
  });

  it('retombe sur la mémoire vive si le stockage persistant est bloqué', () => {
    const storage: FirstUseTipStorage = {
      getItem: () => {
        throw new Error('storage blocked');
      },
      setItem: () => {
        throw new Error('storage blocked');
      },
    };
    const seen = new Set<string>();
    const control = { id: 'at-link', title: 'Marier deux segments.' };

    expect(claimFirstUseTip(control, seen, storage)).toBe(control.title);
    expect(claimFirstUseTip(control, seen, storage)).toBeNull();
  });
});
