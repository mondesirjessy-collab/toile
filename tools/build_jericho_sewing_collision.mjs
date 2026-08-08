#!/usr/bin/env node

/**
 * Build the exact rigged surface used to bake one neutral-avatar pose collider.
 *
 * This deliberately goes through TOILE's production parser, pose evaluator,
 * contact repair and rig-preserving GLB merger. The resulting GLB therefore
 * uses the same local joint rotations, weights and topology as the WebGPU
 * viewport; Blender is not involved.
 *
 * Usage:
 *   node tools/build_jericho_sewing_collision.mjs [source.glb] [output.glb] [pose] [yaw]
 *
 * Poses: a-pose | sewing-preview (default)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.resolve(
  process.argv[2] ?? path.join(root, 'public/avatars/jericho.visual.glb'),
);
const posePreset = process.argv[4] ?? 'sewing-preview';
const yawRadians = Number(process.argv[5] ?? 0);
const outputPath = path.resolve(
  process.argv[3] ?? `/private/tmp/jericho-${posePreset}-posed.glb`,
);

if (!fs.existsSync(sourcePath)) {
  throw new Error(`Neutral avatar source GLB not found: ${sourcePath}`);
}
if (!Number.isFinite(yawRadians)) {
  throw new Error(`Neutral avatar pose yaw must be finite, received: ${process.argv[5]}`);
}

// Bundle just the production functions this offline tool calls. This keeps the
// implementation single-sourced without starting a dev/HMR server.
const bundle = await build({
  stdin: {
    resolveDir: root,
    loader: 'ts',
    contents: `
      export {
        computeScanVisualNormalization,
        parseScanVisualGlb,
      } from './src/engine/body/ScanAvatar.ts';
      export {
        ARTICULATED_SCAN_RIG_POSE_PRESETS,
        buildScanRigPoseGeometry,
        evaluateScanRigPose,
        transformScanRigPoint,
      } from './src/engine/body/ScanRigPose.ts';
      export { buildGlbWithRiggedSource } from './src/app/gltfExport.ts';
    `,
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  write: false,
});
const bundledSource = bundle.outputFiles?.[0]?.text;
if (!bundledSource) throw new Error('Unable to bundle TOILE collision builder');
const runtime = await import(
  `data:text/javascript;base64,${Buffer.from(bundledSource).toString('base64')}`
);
if (!runtime.ARTICULATED_SCAN_RIG_POSE_PRESETS.includes(posePreset)) {
  throw new Error(
    `Unsupported articulated pose "${posePreset}"; expected ${runtime.ARTICULATED_SCAN_RIG_POSE_PRESETS.join(', ')}`,
  );
}

{
  const sourceBytes = fs.readFileSync(sourcePath);
  const source = sourceBytes.buffer.slice(
    sourceBytes.byteOffset,
    sourceBytes.byteOffset + sourceBytes.byteLength,
  );
  const parsed = runtime.parseScanVisualGlb(source);
  if (!parsed.rig) throw new Error('Neutral avatar source GLB has no native rig');

  const normalization = runtime.computeScanVisualNormalization(parsed.mesh, 1.83, yawRadians);
  const pose = runtime.evaluateScanRigPose(
    parsed.rig,
    normalization,
    posePreset,
  );
  const geometry = runtime.buildScanRigPoseGeometry(parsed.mesh, parsed.rig);
  const posedGlb = runtime.buildGlbWithRiggedSource([], {
    glb: source,
    placement: {
      scale: normalization.scale,
      translation: normalization.translation,
      yawRadians: normalization.yawRadians,
    },
    nodeRotations: pose.nodeRotations,
    skinOverride: {
      meshIndex: parsed.rig.skin.meshIndex,
      indices: geometry.indices,
      jointIndices: geometry.jointIndices,
      jointWeights: geometry.jointWeights,
    },
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, new Uint8Array(posedGlb));
  const nodePoint = (name) => {
    const node = parsed.rig.nodes.find((candidate) => candidate.name === name);
    if (!node) throw new Error(`Neutral avatar source rig has no ${name}`);
    const offset = node.index * 16;
    return runtime.transformScanRigPoint(normalization.matrix, [
      pose.nodeWorldMatrices[offset + 12],
      pose.nodeWorldMatrices[offset + 13],
      pose.nodeWorldMatrices[offset + 14],
    ]);
  };
  const direction = (from, to) => {
    const start = nodePoint(from);
    const end = nodePoint(to);
    const value = end.map((component, axis) => component - start[axis]);
    const length = Math.hypot(...value);
    return value.map((component) => component / length);
  };
  process.stdout.write(`${JSON.stringify({
    source: sourcePath,
    output: outputPath,
    pose: posePreset,
    yawRadians,
    bytes: posedGlb.byteLength,
    joints: parsed.rig.skin.joints.length,
    posedNodes: Object.keys(pose.nodeRotations).length,
    triangles: geometry.indices.length / 3,
    detachedTriangles: geometry.detachedTriangleCount,
    hardenedVertices: geometry.hardenedVertexCount,
    armDirections: {
      L: {
        upper: direction('L_Upperarm', 'L_Forearm'),
        forearm: direction('L_Forearm', 'L_Hand'),
      },
      R: {
        upper: direction('R_Upperarm', 'R_Forearm'),
        forearm: direction('R_Forearm', 'R_Hand'),
      },
    },
  }, null, 2)}\n`);
}
