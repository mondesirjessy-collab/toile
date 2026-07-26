export interface FirstUseTipControl {
  id: string;
  title: string;
}

export interface FirstUseTipStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const firstUseTipStorageKey = (controlId: string): string =>
  `toile:first-use:v139:${controlId}`;

/**
 * Return the control's existing title exactly once.
 *
 * `seen` is the fallback when persistent browser storage is unavailable. The
 * storage key deliberately survives reloads and browser restarts so onboarding
 * does not become repetitive once a gesture is known.
 */
export function claimFirstUseTip(
  control: FirstUseTipControl,
  seen: Set<string>,
  storage: FirstUseTipStorage | null,
): string | null {
  const id = control.id.trim();
  const title = control.title.trim();
  if (!id || !title) return null;

  const key = firstUseTipStorageKey(id);
  if (seen.has(key)) return null;
  if (storage) {
    try {
      if (storage.getItem(key)) {
        seen.add(key);
        return null;
      }
      storage.setItem(key, '1');
    } catch {
      // Private/restricted webviews may reject persistent storage. The
      // in-memory set below still preserves the one-shot contract for the run.
    }
  }
  seen.add(key);
  return title;
}
