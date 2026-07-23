import { describe, expect, it } from 'vitest';
import { MouseForce } from '../src/app/MouseForce';

describe('MouseForce gesture cancellation', () => {
  it('relâche les boutons logiques et reste idempotent après Escape', () => {
    const oldWindow = globalThis.window;
    const windowListeners = new Map<
      string,
      (event?: PointerEvent) => void
    >();
    const canvasListeners = new Map<
      string,
      Array<(event: PointerEvent) => void>
    >();
    const canvas = {
      addEventListener: (
        type: string,
        listener: (event: PointerEvent) => void,
      ) => {
        const current = canvasListeners.get(type) ?? [];
        current.push(listener);
        canvasListeners.set(type, current);
      },
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    } as unknown as HTMLElement;
    const pointer = (button: number): PointerEvent =>
      ({
        button,
        clientX: 100,
        clientY: 50,
        shiftKey: false,
      }) as PointerEvent;
    const dispatch = (type: string, event: PointerEvent): void => {
      for (const listener of canvasListeners.get(type) ?? []) listener(event);
    };

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: (
          type: string,
          listener: (event?: PointerEvent) => void,
        ) =>
          windowListeners.set(type, listener),
      },
    });

    try {
      const mouse = new MouseForce();
      mouse.attach(canvas);
      dispatch('pointerdown', pointer(0));
      dispatch('pointerdown', pointer(2));
      expect(mouse.leftDown).toBe(true);
      expect(mouse.rightDown).toBe(true);
      expect(mouse.repelMode).toBe(-1);

      expect(mouse.cancelGesture()).toBe(true);
      expect(mouse.leftDown).toBe(false);
      expect(mouse.rightDown).toBe(false);
      expect(mouse.repelMode).toBe(0);
      expect(mouse.cancelGesture()).toBe(false);

      // The real pointerup still arrives after Escape and remains harmless.
      dispatch('pointerup', pointer(0));
      dispatch('pointerup', pointer(2));
      expect(mouse.cancelGesture()).toBe(false);

      dispatch('pointerdown', pointer(0));
      expect(mouse.leftDown).toBe(true);
      windowListeners.get('pointerup')?.(pointer(0));
      expect(mouse.leftDown).toBe(false);

      dispatch('pointerdown', pointer(0));
      dispatch('pointerdown', pointer(2));
      const cancelledPointer = {
        ...pointer(-1),
        button: -1,
        buttons: 0,
      } as PointerEvent;
      dispatch('pointercancel', cancelledPointer);
      expect(mouse.leftDown).toBe(false);
      expect(mouse.rightDown).toBe(false);

      dispatch('pointerdown', pointer(0));
      windowListeners.get('blur')?.();
      expect(mouse.leftDown).toBe(false);
    } finally {
      if (oldWindow === undefined) {
        delete (globalThis as { window?: Window }).window;
      } else {
        Object.defineProperty(globalThis, 'window', {
          configurable: true,
          value: oldWindow,
        });
      }
    }
  });
});
