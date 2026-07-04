/**
 * MouseForce — pointer state for cloth interaction.
 * Tracks the cursor in normalized device coordinates (NDC, y up) and the button
 * state. Milestone 7-8 remapped the buttons:
 *   - left  → raycast particle drag (the brief's official interaction; the grab
 *             + follow is driven in main.ts, which reads `leftDown` edges)
 *   - right → radial repulsion force (the milestone-2 tool, kept as a stress
 *             test for stability S3)
 * Camera orbit stays on middle button / Shift+left (see OrbitCamera), so plain
 * left/right are free.
 */
export class MouseForce {
  /** Cursor position in NDC: x,y ∈ [-1, 1], y pointing up. */
  ndcX = 0;
  ndcY = 0;

  leftDown = false;
  rightDown = false;

  attach(canvas: HTMLElement): void {
    // Right button drives repulsion, so suppress the native context menu.
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointermove', (e) => this.updateNdc(canvas, e));

    canvas.addEventListener('pointerdown', (e) => {
      this.updateNdc(canvas, e);
      // Shift+left is reserved for camera orbit — don't grab it.
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

  /** Radial force mode: -1 repel (right button), 0 idle. */
  get repelMode(): number {
    return this.rightDown ? -1 : 0;
  }

  private updateNdc(canvas: HTMLElement, e: PointerEvent): void {
    const rect = canvas.getBoundingClientRect();
    this.ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.ndcY = 1 - ((e.clientY - rect.top) / rect.height) * 2;
  }
}
