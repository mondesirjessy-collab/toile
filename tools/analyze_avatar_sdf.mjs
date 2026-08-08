/**
 * Compare the baked collision SDF with the render mesh it is meant to match.
 * Read-only diagnostic:
 *   `node tools/analyze_avatar_sdf.mjs [femme-scan jericho ...]`.
 */
import fs from 'node:fs';

function readAvatar(name) {
  const meshBytes = fs.readFileSync(`public/avatars/${name}.mesh.bin`);
  const meshView = new DataView(meshBytes.buffer, meshBytes.byteOffset, meshBytes.byteLength);
  const vertexCount = meshView.getUint32(0, true);
  const positions = new Float32Array(
    meshBytes.buffer,
    meshBytes.byteOffset + 8,
    vertexCount * 3,
  );

  const sdfBytes = fs.readFileSync(`public/avatars/${name}.sdf.bin`);
  const sdfView = new DataView(sdfBytes.buffer, sdfBytes.byteOffset, sdfBytes.byteLength);
  const dims = [0, 4, 8].map((offset) => sdfView.getUint32(offset, true));
  const min = [12, 16, 20].map((offset) => sdfView.getFloat32(offset, true));
  const max = [24, 28, 32].map((offset) => sdfView.getFloat32(offset, true));
  const valuesMm = new Int16Array(
    sdfBytes.buffer,
    sdfBytes.byteOffset + 36,
    dims[0] * dims[1] * dims[2],
  );
  return { vertexCount, positions, dims, min, max, valuesMm };
}

function sampler(avatar) {
  const { dims, min, max, valuesMm } = avatar;
  const cell = dims.map((count, axis) => (max[axis] - min[axis]) / (count - 1));
  const at = (i, j, k) => valuesMm[(k * dims[1] + j) * dims[0] + i] / 1000;
  return (x, y, z) => {
    const grid = [x, y, z].map((value, axis) => (value - min[axis]) / cell[axis]);
    const base = grid.map((value, axis) =>
      Math.max(0, Math.min(dims[axis] - 2, Math.floor(value))),
    );
    const fraction = grid.map((value, axis) =>
      Math.max(0, Math.min(1, value - base[axis])),
    );
    const [i, j, k] = base;
    const [fx, fy, fz] = fraction;
    const mix = (a, b, t) => a + (b - a) * t;
    const x00 = mix(at(i, j, k), at(i + 1, j, k), fx);
    const x10 = mix(at(i, j + 1, k), at(i + 1, j + 1, k), fx);
    const x01 = mix(at(i, j, k + 1), at(i + 1, j, k + 1), fx);
    const x11 = mix(at(i, j + 1, k + 1), at(i + 1, j + 1, k + 1), fx);
    return mix(mix(x00, x10, fy), mix(x01, x11, fy), fz);
  };
}

function summarize(values) {
  values.sort((a, b) => a - b);
  const quantile = (fraction) =>
    values[Math.min(values.length - 1, Math.floor(fraction * (values.length - 1)))];
  const percent = (predicate) =>
    (100 * values.reduce((count, value) => count + Number(predicate(value)), 0)) /
    values.length;
  return {
    samples: values.length,
    minMm: quantile(0),
    p01Mm: quantile(0.01),
    p10Mm: quantile(0.1),
    p50Mm: quantile(0.5),
    p90Mm: quantile(0.9),
    p95Mm: quantile(0.95),
    p99Mm: quantile(0.99),
    maxMm: quantile(1),
    over2_5mmPct: percent((value) => value > 2.5),
    over5mmPct: percent((value) => value > 5),
    underMinus2_5mmPct: percent((value) => value < -2.5),
  };
}

function analyze(name) {
  const avatar = readAvatar(name);
  const signedDistance = sampler(avatar);
  const height = avatar.max[1] - avatar.min[1] - 0.12;
  const groups = {
    all: [],
    neck: [],
    shoulders: [],
    armpits: [],
    upperBody: [],
    torso: [],
    arms: [],
  };
  for (let vertex = 0; vertex < avatar.vertexCount; vertex++) {
    const x = avatar.positions[vertex * 3];
    const y = avatar.positions[vertex * 3 + 1];
    const z = avatar.positions[vertex * 3 + 2];
    const distanceMm = signedDistance(x, y, z) * 1000;
    const relativeY = y / height;
    groups.all.push(distanceMm);
    if (relativeY > 0.78 && Math.abs(x) < 0.16) groups.neck.push(distanceMm);
    if (
      relativeY > 0.72 &&
      relativeY < 0.9 &&
      Math.abs(x) >= 0.12 &&
      Math.abs(x) < 0.36
    ) {
      groups.shoulders.push(distanceMm);
    }
    if (
      relativeY > 0.65 &&
      relativeY < 0.82 &&
      Math.abs(x) >= 0.18 &&
      Math.abs(x) < 0.38
    ) {
      groups.armpits.push(distanceMm);
    }
    if (relativeY > 0.64 && relativeY < 0.92) groups.upperBody.push(distanceMm);
    if (relativeY > 0.5 && relativeY < 0.78 && Math.abs(x) < 0.25) {
      groups.torso.push(distanceMm);
    }
    if (Math.abs(x) >= 0.3 && relativeY > 0.62 && relativeY < 0.88) {
      groups.arms.push(distanceMm);
    }
  }
  const cellMm = avatar.dims.map(
    (count, axis) => ((avatar.max[axis] - avatar.min[axis]) * 1000) / (count - 1),
  );
  return {
    name,
    dims: avatar.dims,
    cellMm,
    zones: Object.fromEntries(
      Object.entries(groups)
        .filter(([, values]) => values.length > 0)
        .map(([zone, values]) => [zone, summarize(values)]),
    ),
  };
}

const names = process.argv.slice(2);
console.log(
  JSON.stringify(
    (names.length ? names : ['femme-scan', 'jericho']).map(analyze),
    null,
    2,
  ),
);
