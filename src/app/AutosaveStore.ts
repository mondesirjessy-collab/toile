export const AUTOSAVE_DB_NAME = 'toile-autosave';
export const AUTOSAVE_STORE_NAME = 'snapshots';
export const AUTOSAVE_CLEAN_KEY = 'toile.autosave.cleanThrough';
export const AUTOSAVE_DISMISSED_KEY = 'toile.autosave.dismissedThrough';

export interface AutosaveSnapshot {
  id: number;
  format: 'toile-autosave-snapshot';
  version: 1;
  savedAt: number;
  payloadJson: string;
}

export interface AutosaveStore {
  save(payloadJson: string, savedAt?: number): Promise<AutosaveSnapshot>;
  latest(): Promise<AutosaveSnapshot | null>;
}

type PendingSnapshot = Omit<AutosaveSnapshot, 'id'>;

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });

/** IndexedDB persistence for the five newest canonical garment snapshots. */
export class IndexedDbAutosaveStore implements AutosaveStore {
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly indexedDb: IDBFactory = indexedDB,
    private readonly keep = 5,
  ) {}

  async save(payloadJson: string, savedAt = Date.now()): Promise<AutosaveSnapshot> {
    const db = await this.database();
    const tx = db.transaction(AUTOSAVE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(AUTOSAVE_STORE_NAME);
    const pending: PendingSnapshot = {
      format: 'toile-autosave-snapshot',
      version: 1,
      savedAt,
      payloadJson,
    };
    const id = Number(await requestResult(store.add(pending)));
    const keys = (await requestResult(store.getAllKeys())).map(Number).sort((a, b) => b - a);
    for (const stale of keys.slice(Math.max(1, this.keep))) store.delete(stale);
    await transactionDone(tx);
    return { ...pending, id };
  }

  async latest(): Promise<AutosaveSnapshot | null> {
    const db = await this.database();
    const tx = db.transaction(AUTOSAVE_STORE_NAME, 'readonly');
    const cursor = await requestResult(tx.objectStore(AUTOSAVE_STORE_NAME).openCursor(null, 'prev'));
    await transactionDone(tx);
    if (!cursor) return null;
    return validateAutosaveSnapshot(cursor.value) ? cursor.value : null;
  }

  private database(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = this.indexedDb.open(AUTOSAVE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(AUTOSAVE_STORE_NAME)) {
          db.createObjectStore(AUTOSAVE_STORE_NAME, { keyPath: 'id', autoIncrement: true });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to open autosave database'));
      request.onblocked = () => reject(new Error('Autosave database upgrade is blocked'));
    });
    return this.databasePromise;
  }
}

export function validateAutosaveSnapshot(value: unknown): value is AutosaveSnapshot {
  const item = value as Partial<AutosaveSnapshot> | null;
  return (
    !!item &&
    item.format === 'toile-autosave-snapshot' &&
    item.version === 1 &&
    typeof item.id === 'number' &&
    Number.isFinite(item.id) &&
    typeof item.savedAt === 'number' &&
    Number.isFinite(item.savedAt) &&
    typeof item.payloadJson === 'string'
  );
}

const marker = (storage: Pick<Storage, 'getItem'>, key: string): number => {
  try {
    const value = Number(storage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
};

export function shouldOfferRecovery(
  snapshot: AutosaveSnapshot,
  storage: Pick<Storage, 'getItem'>,
): boolean {
  return snapshot.id > Math.max(marker(storage, AUTOSAVE_CLEAN_KEY), marker(storage, AUTOSAVE_DISMISSED_KEY));
}

export function markRecoveryHandled(
  snapshot: AutosaveSnapshot,
  storage: Pick<Storage, 'setItem'>,
  kind: 'clean' | 'dismissed',
): void {
  try {
    storage.setItem(kind === 'clean' ? AUTOSAVE_CLEAN_KEY : AUTOSAVE_DISMISSED_KEY, String(snapshot.id));
  } catch {
    // Recovery remains usable when storage markers are blocked; at worst the
    // same non-intrusive proposal can be shown again next boot.
  }
}

export interface AutosaveControllerOptions {
  store: AutosaveStore;
  snapshot(): unknown;
  isIdle(): boolean;
  debounceMs?: number;
  now?: () => number;
  onSaved?: (snapshot: AutosaveSnapshot) => void;
}

/**
 * Debounced autosave coordinator. It deliberately never serializes while a
 * scene is being torn down or built, so IndexedDB cannot receive hybrid state.
 */
export class AutosaveController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private revision = 0;
  private dirty = false;
  private deadlineExpired = false;
  private writing = false;
  private disposed = false;
  private disabled = false;
  private warned = false;
  private lastPayload = '';
  private lastSaved: AutosaveSnapshot | null = null;

  constructor(private readonly options: AutosaveControllerOptions) {}

  markDirty(): void {
    if (this.disposed || this.disabled) return;
    this.revision++;
    this.dirty = true;
    this.deadlineExpired = false;
    this.arm();
  }

  /** Resume a save whose two-second deadline elapsed during a transition. */
  notifyIdle(): void {
    if (!this.dirty || this.disposed || this.disabled) return;
    if (this.deadlineExpired) void this.flushNow();
    else if (!this.timer && !this.writing) this.arm();
  }

  async flushNow(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed || this.disabled || !this.dirty || this.writing) return;
    if (!this.options.isIdle()) {
      this.deadlineExpired = true;
      return;
    }

    const revision = this.revision;
    let payload: string;
    try {
      payload = JSON.stringify(this.options.snapshot());
    } catch (error) {
      this.warn(error);
      return;
    }
    if (payload === this.lastPayload) {
      if (this.revision === revision) this.dirty = false;
      return;
    }

    this.writing = true;
    try {
      const saved = await this.options.store.save(payload, (this.options.now ?? Date.now)());
      this.lastPayload = payload;
      this.lastSaved = saved;
      this.options.onSaved?.(saved);
      if (this.revision === revision) this.dirty = false;
    } catch (error) {
      this.warn(error);
    } finally {
      this.writing = false;
      this.deadlineExpired = false;
      if (this.dirty && !this.disposed) this.arm();
    }
  }

  get cleanCloseSnapshot(): AutosaveSnapshot | null {
    return !this.dirty && !this.writing && this.options.isIdle() ? this.lastSaved : null;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(0, this.options.debounceMs ?? 2000);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.deadlineExpired = true;
      void this.flushNow();
    }, delay);
  }

  private warn(error: unknown): void {
    this.disabled = true;
    this.dirty = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.warned) return;
    this.warned = true;
    console.warn('[toile] autosave unavailable:', error);
  }
}
