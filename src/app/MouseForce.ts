/**
 * MouseForce — milestone 2 pointer interaction.
 * Tracks the cursor in normalized device coordinates (NDC, y up) and which
 * mouse button is held, then exposes a signed `mode`:
 *   +1 attract (left button)   -1 repel (right button)   0 idle
 *
 * Camera orbit was moved off the plain left-drag (see OrbitCamera) so the
 * left/right buttons are free for the radial force. The per-frame loop reads
 * `ndcX/ndcY` + `mode`, turns the cursor into a world-space ray via the camera,
 * and feeds it to the solver.
 */
export type ForceMode = -1 | 0 | 1;

export class MouseForce {
  /** Cursor position in NDC: x,y ∈ [-1, 1], y pointing up. */
  ndcX = 0;
  ndcY = 0;

  private leftDown = false;
  private rightDown = false;

  attach(canvas: HTMLElement): void {
    // Right button drives repulsion, so suppress the native context menu.
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointermove', (e) => this.updateNdc(canvas, e));

    canvas.addEventListener('pointerdown', (e) => {
      this.updateNdc(canvas, e);
      // Shift+left is reserved for camera orbit — don't grab it as a force.
      if (e.button === 0 && !e.shiftKey) this.leftDown = true;
      if (e.button === 2) this.rightDown = true;
    });

    const release = (e: PointerEvent): void => {
      if (e.button === 0) this.leftDown = false;
      if (e.button === 2) this.rightDown = false;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    // If focus is lost mid-hold the up event never arrives — reset defensively.
    window.addEventListener('blur', () => {
      this.leftDown = false;
      this.rightDown = false;
    });
  }

  /** Repulsion wins if both buttons are somehow held at once. */
  get mode(): ForceMode {
    if (this.rightDown) return -1;
    if (this.leftDown) return 1;
    return 0;
  }

  private updateNdc(canvas: HTMLElement, e: PointerEvent): void {
    const rect = canvas.getBoundingClientRect();
    this.ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.ndcY = 1 - ((e.clientY - rect.top) / rect.height) * 2;
  }
}
