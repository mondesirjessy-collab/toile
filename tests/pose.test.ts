import { describe, expect, it } from 'vitest';
import {
  BODY_FORM_ARMS,
  BODY_MALE_ARMS,
  horizontalizeArmChains,
} from '../src/engine/body/BodySdf';
import { poseIdle } from '../src/engine/body/pose';

describe.each([
  ['femme', BODY_FORM_ARMS],
  ['homme', BODY_MALE_ARMS],
] as const)('poseIdle depuis une T-pose — %s', (_name, source) => {
  it('déplace réellement chaque humérus de plus de 5 cm au pic', () => {
    const rest = horizontalizeArmChains(source);
    const first = rest.length - 8;
    const peakTime = Math.PI / (2 * 1.6);
    const posed = poseIdle(rest, peakTime).prims;

    for (let side = 0; side < 2; side++) {
      const restUpper = rest[first + side]!;
      const posedUpper = posed[first + side]!;
      expect(posedUpper.a).toEqual(restUpper.a);
      expect(Math.hypot(
        posedUpper.b[0] - restUpper.b[0],
        posedUpper.b[1] - restUpper.b[1],
        posedUpper.b[2] - restUpper.b[2],
      )).toBeGreaterThan(0.05);
      expect(Math.abs(posedUpper.b[2] - restUpper.b[2])).toBeGreaterThan(0.05);

      const restElbow = rest[first + 2 + side]!;
      const posedElbow = posed[first + 2 + side]!;
      expect(Math.hypot(
        posedElbow.a[0] - restElbow.a[0],
        posedElbow.a[1] - restElbow.a[1],
        posedElbow.a[2] - restElbow.a[2],
      )).toBeGreaterThan(0.05);
    }
  });
});
