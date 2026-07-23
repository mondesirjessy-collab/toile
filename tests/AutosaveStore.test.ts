import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOSAVE_CLEAN_KEY,
  AUTOSAVE_DISMISSED_KEY,
  AutosaveController,
  markRecoveryHandled,
  shouldOfferRecovery,
  type AutosaveSnapshot,
  type AutosaveStore,
} from '../src/app/AutosaveStore';

class MemoryStore implements AutosaveStore {
  readonly items: AutosaveSnapshot[] = [];
  delay: Promise<void> | null = null;

  async save(payloadJson: string, savedAt = Date.now()): Promise<AutosaveSnapshot> {
    await this.delay;
    const item: AutosaveSnapshot = {
      id: this.items.length + 1,
      format: 'toile-autosave-snapshot',
      version: 1,
      savedAt,
      payloadJson,
    };
    this.items.push(item);
    if (this.items.length > 5) this.items.splice(0, this.items.length - 5);
    return item;
  }

  async latest(): Promise<AutosaveSnapshot | null> {
    return this.items.at(-1) ?? null;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AutosaveController', () => {
  it('debounces mutations and stores only the canonical latest document', async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    let value = 0;
    const autosave = new AutosaveController({ store, snapshot: () => ({ value }), isIdle: () => true });
    autosave.markDirty();
    value = 1;
    autosave.markDirty();
    await vi.advanceTimersByTimeAsync(1999);
    expect(store.items).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.items).toHaveLength(1);
    expect(JSON.parse(store.items[0]!.payloadJson)).toEqual({ value: 1 });
  });

  it('waits for idle when the deadline expires during a transition', async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    let idle = false;
    const autosave = new AutosaveController({ store, snapshot: () => ({ ok: true }), isIdle: () => idle });
    autosave.markDirty();
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.items).toHaveLength(0);
    idle = true;
    autosave.notifyIdle();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.items).toHaveLength(1);
  });

  it('keeps a mutation that happens while IndexedDB is writing', async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    let release!: () => void;
    store.delay = new Promise<void>((resolve) => { release = resolve; });
    let value = 1;
    const autosave = new AutosaveController({ store, snapshot: () => ({ value }), isIdle: () => true });
    autosave.markDirty();
    const first = autosave.flushNow();
    value = 2;
    autosave.markDirty();
    release();
    await first;
    store.delay = null;
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.items.map((item) => JSON.parse(item.payloadJson).value)).toEqual([1, 2]);
  });

  it('deduplicates an unchanged payload', async () => {
    const store = new MemoryStore();
    const autosave = new AutosaveController({ store, snapshot: () => ({ same: true }), isIdle: () => true });
    autosave.markDirty();
    await autosave.flushNow();
    autosave.markDirty();
    await autosave.flushNow();
    expect(store.items).toHaveLength(1);
  });

  it('fails closed after an IndexedDB error and warns only once', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store: AutosaveStore = {
      save: vi.fn(async () => { throw new Error('quota'); }),
      latest: vi.fn(async () => null),
    };
    const autosave = new AutosaveController({ store, snapshot: () => ({ value: 1 }), isIdle: () => true });
    autosave.markDirty();
    await autosave.flushNow();
    autosave.markDirty();
    await autosave.flushNow();
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('keeps the latest five snapshots', async () => {
    const store = new MemoryStore();
    let value = 0;
    const autosave = new AutosaveController({ store, snapshot: () => ({ value }), isIdle: () => true });
    for (value = 1; value <= 6; value++) {
      autosave.markDirty();
      await autosave.flushNow();
    }
    expect(store.items).toHaveLength(5);
    expect(JSON.parse(store.items[0]!.payloadJson)).toEqual({ value: 2 });
  });
});

describe('recovery markers', () => {
  const snapshot: AutosaveSnapshot = {
    id: 8,
    format: 'toile-autosave-snapshot',
    version: 1,
    savedAt: 1,
    payloadJson: '{}',
  };

  it('offers only snapshots newer than clean/dismissed markers', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(shouldOfferRecovery(snapshot, storage)).toBe(true);
    markRecoveryHandled(snapshot, storage, 'dismissed');
    expect(values.get(AUTOSAVE_DISMISSED_KEY)).toBe('8');
    expect(shouldOfferRecovery(snapshot, storage)).toBe(false);
    values.delete(AUTOSAVE_DISMISSED_KEY);
    markRecoveryHandled(snapshot, storage, 'clean');
    expect(values.get(AUTOSAVE_CLEAN_KEY)).toBe('8');
    expect(shouldOfferRecovery(snapshot, storage)).toBe(false);
  });
});
