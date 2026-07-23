export const TOAST_VISIBLE_MS = 6_000;
export const MAX_VISIBLE_TOASTS = 2;

/** Pure queue rule shared by the DOM implementation and regression tests. */
export function boundedToastMessages(
  current: readonly string[],
  next: string,
  limit = MAX_VISIBLE_TOASTS,
): string[] {
  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.floor(limit))
    : MAX_VISIBLE_TOASTS;
  return [...current, next].slice(-safeLimit);
}

export function undoToastMessage(
  detail = 'dernière modification du patron',
): string {
  return `Annulé : ${detail}`;
}

/**
 * Short, non-blocking UI feedback. A single live region owns at most two
 * messages, so repeated commands never cover the atelier.
 */
export function showToast(
  message: string,
  ok = true,
  durationMs = TOAST_VISIBLE_MS,
): void {
  if (typeof document === 'undefined') return;
  let stack = document.getElementById('toile-toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toile-toast-stack';
    stack.setAttribute('role', 'status');
    stack.setAttribute('aria-live', 'polite');
    stack.setAttribute('aria-atomic', 'false');
    stack.style.cssText =
      'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
      'z-index:120;display:grid;gap:6px;width:max-content;max-width:min(520px,calc(100vw - 32px));' +
      'pointer-events:none';
    document.body.appendChild(stack);
  }

  while (stack.children.length >= MAX_VISIBLE_TOASTS) {
    stack.firstElementChild?.remove();
  }
  const item = document.createElement('div');
  item.className = 'toile-toast';
  item.textContent = message;
  item.style.cssText =
    'padding:8px 16px;border-radius:6px;font:13px ui-monospace,Menlo,monospace;' +
    'color:#ede9df;background:rgba(10,11,14,0.92);border:1px solid;' +
    'box-shadow:0 8px 24px rgba(0,0,0,0.3);transition:opacity 0.3s;opacity:0';
  item.style.borderColor = ok
    ? 'rgba(127,178,255,0.55)'
    : 'rgba(255,120,120,0.65)';
  stack.appendChild(item);
  requestAnimationFrame(() => {
    item.style.opacity = '1';
  });
  const fadeMs = Math.min(300, Math.max(0, durationMs));
  window.setTimeout(() => {
    item.style.opacity = '0';
  }, Math.max(0, durationMs - fadeMs));
  window.setTimeout(() => {
    item.remove();
    if (stack?.childElementCount === 0) stack.remove();
  }, Math.max(0, durationMs));
}
