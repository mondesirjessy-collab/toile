export const DOWNLOAD_URL_REVOKE_DELAY_MS = 30_000;

/**
 * Start a browser download without leaving a detached anchor or Blob URL
 * behind when navigation fails synchronously.
 */
export function downloadBrowserBlob(
  blob: Blob,
  filename: string,
  revokeDelayMs = DOWNLOAD_URL_REVOKE_DELAY_MS,
): string {
  const objectUrl = URL.createObjectURL(blob);
  let anchor: HTMLAnchorElement | null = null;
  let revokeScheduled = false;

  try {
    anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), revokeDelayMs);
    revokeScheduled = true;
    return filename;
  } catch (error) {
    if (!revokeScheduled) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // Preserve the download failure instead of replacing it with cleanup.
      }
    }
    throw error;
  } finally {
    try {
      anchor?.remove();
    } catch {
      // A failed DOM cleanup must not turn a started download into an error.
    }
  }
}
