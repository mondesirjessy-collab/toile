/**
 * annyBody — pont vers le corps paramétrique Anny (naver, Apache-2.0 / CC0).
 *
 * Anny est un modèle MakeHuman piloté par 6 phénotypes haut niveau (gender,
 * age, muscle, weight, height, proportions) dont l'effet sur le maillage est
 * LINÉAIRE (vérifié à l'extraction : < 4 mm sur toute la plage). On a extrait
 * hors-ligne (PyTorch) le maillage neutre + le déplacement de chaque phénotype
 * — base + 6 deltas — dans public/avatars/anny-body.bin (~1,5 Mo). Ici, le
 * « forward pass » n'est qu'une combinaison linéaire :
 *     positions = base + Σ (phénotype − 0,5) · delta.
 * Le maillage obtenu est ensuite voxelisé en corps TOILE par buildImportedBody
 * (exactement comme un OBJ importé) : maillage de rendu + grille SDF.
 */
import type { ObjMesh } from './importBody';

export type AnnyPhenotype = 'gender' | 'age' | 'muscle' | 'weight' | 'height' | 'proportions';
export type AnnyPhenotypes = Partial<Record<AnnyPhenotype, number>>;

export interface AnnyModel {
  labels: string[];
  vertexCount: number;
  faceCount: number;
  neutral: number;
  base: Float32Array; // V*3
  deltas: Float32Array; // P*V*3
  faces: Uint32Array; // F*3
}

/** Charge le binaire extrait d'Anny (en-tête JSON + base + deltas + faces). */
export async function loadAnnyModel(url: string): Promise<AnnyModel> {
  const buf = await (await fetch(url)).arrayBuffer();
  const dv = new DataView(buf);
  const hlen = dv.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hlen))) as {
    labels: string[];
    vertexCount: number;
    faceCount: number;
    neutral: number;
  };
  const V = header.vertexCount;
  const F = header.faceCount;
  const P = header.labels.length;
  let off = 4 + hlen;
  // slice() copie dans des buffers alignés sur 4 (l'en-tête peut désaligner off).
  const base = new Float32Array(buf.slice(off, off + V * 3 * 4));
  off += V * 3 * 4;
  const deltas = new Float32Array(buf.slice(off, off + P * V * 3 * 4));
  off += P * V * 3 * 4;
  const facesI = new Int32Array(buf.slice(off, off + F * 3 * 4));
  return {
    labels: header.labels,
    vertexCount: V,
    faceCount: F,
    neutral: header.neutral,
    base,
    deltas,
    faces: Uint32Array.from(facesI),
  };
}

/** Forward pass : maillage Anny pour un jeu de phénotypes (∈ [0,1], 0,5 = neutre). */
export function annyMesh(model: AnnyModel, ph: AnnyPhenotypes): ObjMesh {
  const { vertexCount: V, labels, base, deltas, neutral } = model;
  const positions = new Float32Array(base); // copie du corps neutre
  const p3 = V * 3;
  for (let p = 0; p < labels.length; p++) {
    const w = ((ph as Record<string, number>)[labels[p]!] ?? neutral) - neutral;
    if (w === 0) continue;
    const doff = p * p3;
    for (let i = 0; i < p3; i++) positions[i]! += w * deltas[doff + i]!;
  }
  return { positions, indices: model.faces };
}
